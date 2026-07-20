import { chromium } from 'playwright';
import runtime from '../../runtime.cjs';

export const VIEWPORT = { width: 1280, height: 720 };

const INSTALL_HINT = 'Run `pingfusi motion install-browser`; video capture requires Playwright Chromium and its recording FFmpeg. PPK_MOTION_CHROME only selects the browser executable.';

export function launchRemedy(detail) {
  const text = String(detail || '');
  if (/ffmpeg|executable doesn(?:'|’)t exist|browser executable|chromium.*(?:missing|not found)/i.test(text)) return INSTALL_HINT;
  if (/host system is missing dependencies|missing (?:shared )?librar|error while loading shared libraries/i.test(text)) {
    return 'The browser is installed, but this host is missing Playwright system libraries; install the listed OS packages, then retry.';
  }
  return null;
}

export async function launchSession({
  headless = true,
  videoDir = null,
  viewport = VIEWPORT,
  deviceScaleFactor = 1,
} = {}) {
  const resolved = runtime.resolveChromium({ playwrightExecutable: chromium.executablePath() });
  if (!resolved.ok) {
    throw new Error(`${resolved.reason}. ${INSTALL_HINT}`);
  }
  let browser;
  let context;
  try {
    browser = await chromium.launch({ headless, ...(resolved.executablePath ? { executablePath: resolved.executablePath } : {}) });
    context = await browser.newContext({
      viewport,
      deviceScaleFactor, // trace/linked replay must use the same CSS viewport + DPR on both sides
      ...(videoDir ? { recordVideo: { dir: videoDir, size: viewport } } : {}),
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    return { browser, context, page, cdp };
  } catch (error) {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    const detail = error instanceof Error ? error.message : String(error);
    if (videoDir) {
      const remedy = launchRemedy(detail);
      throw new Error(`Motion video recording could not start: ${detail}${remedy ? `. ${remedy}` : ''}`, { cause: error });
    }
    throw error;
  }
}

// ppk-style settle: never a fixed guess-sleep. Wait for load, then for a mutation-quiet
// window, then require two stable reads of scrollHeight + node count.
export async function settle(page, { quietMs = 350, maxMs = 6000 } = {}) {
  await page.waitForLoadState('load');
  await page.evaluate(
    ({ quietMs, maxMs }) =>
      new Promise((resolve) => {
        const started = performance.now();
        let last = performance.now();
        const mo = new MutationObserver(() => {
          last = performance.now();
        });
        mo.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['class', 'style'],
        });
        const readState = () => [document.documentElement.scrollHeight, document.querySelectorAll('*').length].join(':');
        let prev = readState();
        const check = () => {
          const now = performance.now();
          if (now - started > maxMs) return done();
          if (now - last >= quietMs) {
            const cur = readState();
            if (cur === prev) return done();
            prev = cur;
          }
          setTimeout(check, 120);
        };
        const done = () => {
          mo.disconnect();
          resolve();
        };
        setTimeout(check, quietMs);
      }),
    { quietMs, maxMs },
  );
}
