import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url)); // serves pages/ and tier3/
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };

export function startFixtureServer(port = 0) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const path = normalize(join(ROOT, new URL(req.url, 'http://x').pathname));
        if (!path.startsWith(ROOT)) throw new Error('outside root');
        const body = await readFile(path);
        res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(port, '127.0.0.1', () =>
      resolve({
        server,
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}
