import { execFile } from 'node:child_process';
import { readdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

async function findFfmpeg() {
  try {
    await pExecFile('ffmpeg', ['-version']);
    return 'ffmpeg';
  } catch {}
  // fall back to Playwright's bundled ffmpeg (it's how the recording got muxed)
  for (const root of [
    join(homedir(), 'Library/Caches/ms-playwright'),
    join(homedir(), '.cache/ms-playwright'),
  ]) {
    try {
      for (const dir of readdirSync(root)) {
        if (!dir.startsWith('ffmpeg')) continue;
        for (const f of readdirSync(join(root, dir))) {
          if (f.startsWith('ffmpeg')) return join(root, dir, f);
        }
      }
    } catch {}
  }
  return null;
}

// Playwright's recorder writes WebM as a live stream — no cues, no duration index —
// which Chromium reports as seekable [0,0]: currentTime assignments silently no-op, so
// scrubbing and sync in any player break. A stream-copy remux writes a finalized
// container. Returns true when the file was remuxed.
// iOS Safari / WKWebView cannot decode VP8 WebM (Playwright's recording format), while
// Playwright's own Chromium build lacks H.264 — so reviewer-facing videos ship in BOTH
// formats and the player offers <source> alternatives.
export async function transcodeMp4(src, out) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return false;
  try {
    await pExecFile(ffmpeg, [
      '-y', '-loglevel', 'error', '-i', src,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-crf', '20', '-an',
      out,
    ]);
    return true;
  } catch {
    rmSync(out, { force: true });
    return false;
  }
}

export async function remuxSeekable(path) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return false;
  const tmp = `${path}.remux.webm`;
  try {
    await pExecFile(ffmpeg, ['-y', '-loglevel', 'error', '-i', path, '-c', 'copy', tmp]);
    renameSync(tmp, path);
    return true;
  } catch {
    rmSync(tmp, { force: true });
    return false;
  }
}
