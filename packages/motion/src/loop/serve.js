import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
// Tunnel transport (named → ngrok, no anonymous fallback) is shared with the clone
// workflow — packages/core is the one place the preference order lives.
import { startPublicTunnel } from '../../../core/tunnel.js';

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
// installed+authed. Deliberately NO anonymous quick-tunnel fallback (allowQuick stays
// false): a review round must not ride on a rate-limited hostname minted outside the
// operator's control — this loop always has the hosted-draft path instead.
//
// The provider order itself lives in packages/core/tunnel.js, shared with the clone
// workflow's `pingfusi tunnel`. It was written here first; keeping two copies is how the
// clone side spent 24 days minting quick tunnels this loop already knew to avoid.
export async function startTunnel(port, opts = {}) {
  return startPublicTunnel({
    port,
    allowQuick: false,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    hint: 'the supported no-tunnel path is publishing the bundle as a hosted draft: pingfusi motion review <name> <motion-id> publish --bundle <dir>',
  });
}

