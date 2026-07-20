import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

const TYPES = {
  '.html': 'text/html',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

const AGENT_ARTIFACTS = new Set(['loop-state.json', 'loop-log.jsonl', 'receipts.jsonl']);

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function isAgentArtifact(path) {
  return AGENT_ARTIFACTS.has(basename(path));
}

// Range support is required: without it Chromium never establishes a seekable range for
// media, and the player (correctly) hides its scrubber.
export async function serveDir(root, port = 0) {
  // Resolve the root once, then resolve every requested file. The lexical check rejects
  // `../root-copy` prefix tricks; the realpath check rejects symlinks that leave the root.
  const canonicalRoot = await realpath(resolve(root));
  return new Promise((ready) => {
    const server = createServer(async (req, res) => {
      try {
        let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (pathname.endsWith('/')) pathname += 'index.html';
        // agent-side artifacts never leave the machine: loop-state.json carries
        // the 2AFC ground truth (sideMapping) — serving a bundle dir wholesale
        // must not leak it to the reviewer
        if (isAgentArtifact(pathname)) {
          throw new Error('agent-side artifact');
        }
        const requestedPath = resolve(canonicalRoot, pathname.replace(/^\/+/, ''));
        if (!isWithin(canonicalRoot, requestedPath)) throw new Error('outside root');
        const canonicalPath = await realpath(requestedPath);
        if (!isWithin(canonicalRoot, canonicalPath)) throw new Error('symlink outside root');
        // Do not let an innocently named symlink expose the protected state files either.
        if (isAgentArtifact(canonicalPath)) throw new Error('agent-side artifact');
        const body = await readFile(canonicalPath);
        const type = TYPES[extname(canonicalPath)] || 'application/octet-stream';
        const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
        if (m) {
          const start = m[1] ? parseInt(m[1], 10) : 0;
          const end = Math.min(m[2] ? parseInt(m[2], 10) : body.length - 1, body.length - 1);
          res.writeHead(206, {
            'content-type': type,
            'accept-ranges': 'bytes',
            'content-range': `bytes ${start}-${end}/${body.length}`,
            'content-length': end - start + 1,
            // review artifacts are rebuilt between rounds under the SAME URL —
            // a cached review-task.json shows the reviewer last round's task
            'cache-control': 'no-store',
          });
          res.end(body.subarray(start, end + 1));
        } else {
          res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': body.length, 'cache-control': 'no-store' });
          res.end(body);
        }
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(port, '127.0.0.1', () =>
      ready({
        server,
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}

// Public https URL for the player (reviewers need a reachable page). Providers, in order:
// named Cloudflare tunnel if configured (stable hostname, no mint limits), then ngrok if
// installed+authed. Deliberately NO anonymous quick-tunnel fallback: a review round must
// not ride on a random hostname minted outside the operator's control.
export async function startTunnel(port, opts = {}) {
  const failures = [];
  try {
    return await startNamedTunnel(port, opts);
  } catch (err) {
    failures.push(`named tunnel: ${err.message}`);
  }
  try {
    return await startNgrok(port, opts);
  } catch (err) {
    failures.push(`ngrok: ${err.message}`);
  }
  throw new Error(
    `no public tunnel available (${failures.join('; ')}) — the supported no-tunnel path is publishing the bundle as a hosted draft: pingfusi motion review <name> <motion-id> publish --bundle <dir>`,
  );
}

// ~/.cloudflared/motion-kit-tunnel.json ({name, hostname}) records an operator-provisioned
// named tunnel (stable hostname on a domain the operator controls). Setup tooling writes
// it; this code only runs a tunnel that already exists — it never mints one.
function startNamedTunnel(port, { timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    let cfg;
    try {
      cfg = JSON.parse(readFileSync(join(homedir(), '.cloudflared', 'motion-kit-tunnel.json'), 'utf8'));
    } catch {
      return reject(new Error('no named tunnel configured'));
    }
    const proc = spawn('cloudflared', ['tunnel', 'run', '--url', `http://127.0.0.1:${port}`, cfg.name], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const fail = (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        proc.kill();
        reject(err);
      }
    };
    const timer = setTimeout(() => fail(new Error('named tunnel did not connect in time')), timeoutMs);
    const scan = (chunk) => {
      if (/Registered tunnel connection/.test(String(chunk)) && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ url: `https://${cfg.hostname}`, stop: () => proc.kill() });
      }
    };
    proc.stdout.on('data', scan);
    proc.stderr.on('data', scan);
    proc.on('error', () => fail(new Error('cloudflared is not installed')));
    proc.on('exit', (code) => fail(new Error(`named tunnel exited (${code})`)));
  });
}

// ngrok exposes the public URL on its local API; --log stdout is only used for errors
function startNgrok(port, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ngrok', ['http', String(port), '--log', 'stdout', '--log-format', 'json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const fail = (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        proc.kill();
        reject(err);
      }
    };
    const timer = setTimeout(() => fail(new Error('ngrok did not come up in time')), timeoutMs);
    const poll = setInterval(async () => {
      try {
        const res = await fetch('http://127.0.0.1:4040/api/tunnels');
        const tunnels = (await res.json()).tunnels || [];
        const t = tunnels.find((x) => x.proto === 'https') || tunnels[0];
        if (t?.public_url && !settled) {
          settled = true;
          clearTimeout(timer);
          clearInterval(poll);
          resolve({ url: t.public_url, stop: () => proc.kill() });
        }
      } catch {} // API not up yet
    }, 400);
    proc.stdout.on('data', (chunk) => {
      // surface auth errors immediately instead of waiting out the timer
      if (/ERR_NGROK|authtoken|authentication failed/i.test(String(chunk))) {
        fail(new Error('ngrok not authenticated (run: ngrok config add-authtoken <token>)'));
      }
    });
    proc.on('error', () => fail(new Error('ngrok not installed')));
    proc.on('exit', (code) => fail(new Error(`ngrok exited (${code}) before providing a URL`)));
  });
}
