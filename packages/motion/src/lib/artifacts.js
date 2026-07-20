import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256OfFile(path) {
  return sha256(readFileSync(path));
}

// Every artifact write is receipted (ppk discipline): receipts.jsonl pins what was produced.
export function writeArtifact(dir, rel, data) {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  const body =
    typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2);
  writeFileSync(path, body);
  appendFileSync(
    join(dir, 'receipts.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), artifact: rel, sha256: sha256(body) }) + '\n',
  );
  return path;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// The library index is shared across exporters (verbatim, fitted, GL tunnel) and
// across runs — an exporter must merge its entries in by name, never rebuild the
// file from just its own run (that silently deletes every other entry; seen live:
// a 60-entry index reduced to 1 by an export of a trace with zero DOM fits).
export function mergeIndex(out, entries, updatedAt) {
  const path = join(out, 'index.json');
  let index = { entries: [] };
  try {
    index = readJson(path);
  } catch {}
  const incoming = new Set(entries.map((e) => e.name));
  index.entries = [...(index.entries ?? []).filter((e) => !incoming.has(e.name)), ...entries];
  index.updatedAt = updatedAt;
  writeArtifact(out, 'index.json', index);
  return index;
}

export function slug(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'unnamed'
  );
}
