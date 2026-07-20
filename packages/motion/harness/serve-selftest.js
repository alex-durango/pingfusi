import assert from 'node:assert/strict';
import { get } from 'node:http';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serveDir, startTunnel } from '../src/loop/serve.js';

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = get({ hostname: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
  });
}

export async function runServeSelftests() {
  const base = await mkdtemp(join(tmpdir(), 'motion-serve-selftest-'));
  const root = join(base, 'root');
  const sibling = join(base, 'root-sibling');
  const emptyBin = join(base, 'empty-bin');
  await Promise.all([mkdir(root), mkdir(sibling), mkdir(emptyBin)]);
  await writeFile(join(root, 'index.html'), 'safe');
  await writeFile(join(root, 'loop-state.json'), 'private');
  await writeFile(join(sibling, 'secret.txt'), 'outside');
  await symlink(join(sibling, 'secret.txt'), join(root, 'escape.txt'));
  await symlink(join(root, 'loop-state.json'), join(root, 'innocent.json'));

  let server;
  try {
    server = await serveDir(root);

    assert.deepEqual(await request(server.port, '/'), { status: 200, body: 'safe' });

    // Encoded slash defers dot-segment normalization until after URL parsing. The old
    // startsWith(root) check served this because `root-sibling` shares the same prefix.
    const traversal = await request(server.port, '/..%2froot-sibling/secret.txt');
    assert.equal(traversal.status, 404);
    assert.notEqual(traversal.body, 'outside');

    const symlinkEscape = await request(server.port, '/escape.txt');
    assert.equal(symlinkEscape.status, 404);
    assert.notEqual(symlinkEscape.body, 'outside');

    assert.equal((await request(server.port, '/loop-state.json')).status, 404);
    assert.equal((await request(server.port, '/innocent.json')).status, 404);

    // Missing tunnel executables must reject normally. In particular, an ENOENT from
    // cloudflared must not become an unhandled ChildProcess `error` event. The named-tunnel
    // half of the aggregate varies by machine (config file present vs not), so match shape.
    const originalPath = process.env.PATH;
    process.env.PATH = emptyBin;
    try {
      await assert.rejects(
        startTunnel(server.port, { timeoutMs: 500 }),
        /no public tunnel available \(named tunnel: .+; ngrok: .+\).*hosted draft: pingfusi motion review/i,
      );
    } finally {
      if (originalPath == null) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  } finally {
    await server?.close();
    await rm(base, { recursive: true, force: true });
  }

  console.log('ok   serve: traversal, symlink, protected artifact, and tunnel spawn guards');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runServeSelftests();
  } catch (err) {
    console.error(`FAIL serve selftest\n  ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}
