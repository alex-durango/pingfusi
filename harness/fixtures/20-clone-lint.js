// fixtures/20-clone-lint.js — the BUILT clone must not need JavaScript or the network to
// look right. Found on aloyoga: `--visual 156/156` + strict 568/568 + coverage 12/12 all
// went green while four sections of the page were missing, empty, invisible, or served
// from a live CDN. None of the gates could see it: live.json and clone.json are BOTH
// produced by tools/browser-capture.js, so a property the capture can't see is one the two
// snapshots AGREE about. A shared blind spot, not a gate bug.
//
// tools/clone-lint.js closes it statically (no browser, no capture). This fixture fails
// WITHOUT that lint. Every rule carries a CONTROL — a clean static clone must stay silent,
// or the lint would just cry wolf on every target and get ignored.
// SEVERITIES are part of the contract (calibrated the hard way — v1 FAILed remote images
// without reading capture-build.js, which absolutizes them BY DESIGN for byte-identical
// pixels; a lint that fails designed behavior gets ignored):
//   remote-assets = WARN always; empty-mount-point / frozen-reveal = FAIL, downgraded to
//   WARN when the clone ships fixes.js (the behavior phase may legitimately mount/reveal).
const { lintHtml } = require("../../tools/clone-lint.js");
let bad = 0; const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };
const fired = (html, id) => { const r = lintHtml(html).rules.find((x) => x.id === id); return r ? r.count : 0; };
const levelOf = (html, id) => { const r = lintHtml(html).rules.find((x) => x.id === id); return r ? r.level : null; };
const FIXES = `<script src="fixes.js" defer></script>`;

// ---------- CONTROL: a clean, self-contained static clone trips NOTHING ----------
const CLEAN = `<!doctype html><html><head><link rel=stylesheet href="assets/css/01-layout.css"></head>
<body><header><a class="logo"><img src="assets/img/logo.svg" alt="alo"></a>
<nav><a href="/women">WOMEN</a><a href="/men">MEN</a></nav></header>
<section><h3>Shades of Sport</h3><img src="assets/img/hero.jpg" alt="hero"></section>
<div class="card" style="opacity: 1; transform: none;">Most-Loved Pieces</div></body></html>`;
{
  const { ok, rules } = lintHtml(CLEAN);
  check("CONTROL — clean self-contained clone passes (no false positives)", ok && rules.length === 0);
}

// ---------- 1. remote-assets — surfaced as a WARN, never a FAIL ----------
// capture-build absolutizes image refs to the live origin ON PURPOSE (byte-identical
// bytes, nothing re-encoded). The lint must surface the tradeoff (network-dependent,
// origin drifts) without failing designed behavior.
{
  const defect = `<body><img src="https://cdn.builder.io/api/v1/image/assets%2Fabc%2Fdef"><img src="//cdn.shopify.com/x.jpg"></body>`;
  check("lint surfaces <img> served from the live origin", fired(defect, "remote-assets") === 2);
  check("  …as WARN — remote images are capture-build's documented design, not a defect", levelOf(defect, "remote-assets") === "WARN");
  check("  …so a clone whose ONLY finding is remote images still passes (ok=true)", lintHtml(defect).ok === true);
  check("CONTROL — self-hosted images do not trip remote-assets", fired(CLEAN, "remote-assets") === 0);
  // a relative/rooted path is local — must NOT fire (this is the over-fit trap: a greedy
  // rule that flags any src with a slash would flag every clone ever built)
  check("CONTROL — root-relative src is local, not remote", fired(`<img src="/assets/a.png"><img src="./b.png">`, "remote-assets") === 0);
}

// ---------- 2. empty-mount-point — a config blob rendering nothing ----------
{
  // the real aloyoga shape: NOT literally empty — it holds a skeleton child that paints
  // nothing. "is it empty" has to mean "does its subtree PAINT anything".
  const defect = `<div class="react-carousel-container" data-carousel-config="{ &quot;section_title&quot;: &quot;Most-Loved Pieces&quot; }"><div id="HomepageReactCarousel"></div></div>`;
  check("gate catches an unmounted JS carousel (skeleton child, paints nothing)", fired(defect, "empty-mount-point") === 1);
  check("gate names the missing section from its config JSON",
    lintHtml(defect).rules.find((r) => r.id === "empty-mount-point").hits[0].includes("Most-Loved Pieces"));
  check("  …and it is a FAIL when the clone ships no fixes.js (nothing will ever mount it)", levelOf(defect, "empty-mount-point") === "FAIL");
  // fixes.js (capture-build --fixes) is the behavior phase's sanctioned reproduction
  // script — with it present, mounting IS possible at runtime, so downgrade to WARN
  // ("verify it"), don't FAIL a clone for the mechanism the kit itself prescribes.
  check("  …but downgrades to WARN when fixes.js is present (behavior phase may mount it)", levelOf(FIXES + defect, "empty-mount-point") === "WARN");
  // CONTROL: same container, but JS DID render into it (or the build reproduced it) —
  // a mount point that actually paints is fine and must not fire.
  const mounted = `<div class="react-carousel-container" data-carousel-config="{ &quot;section_title&quot;: &quot;Most-Loved Pieces&quot; }"><h3>Most-Loved Pieces</h3><img src="assets/p1.jpg"></div>`;
  check("CONTROL — a mount point that actually paints does not fire", fired(mounted, "empty-mount-point") === 0);
}

// ---------- 3. frozen-reveal — a scroll-reveal caught at its start state ----------
{
  const defect = `<div style="opacity: 0; transform: translate3d(0px, 20px, 0px); transition: 1s cubic-bezier(0.37, 0.01, 0, 0.98);"><h3><span>Shades of Sport</span></h3></div>`;
  check("gate catches an inline opacity:0 scroll-reveal (invisible forever without JS)", fired(defect, "frozen-reveal") === 1);
  check("  …as FAIL without fixes.js, and the fix message routes to pxScrollSettle re-capture",
    levelOf(defect, "frozen-reveal") === "FAIL" && /pxScrollSettle/.test(lintHtml(defect).rules.find((r) => r.id === "frozen-reveal").summary));
  check("  …but WARN with fixes.js (opacity:0 may be a reveal's legit initial state)", levelOf(FIXES + defect, "frozen-reveal") === "WARN");
  check("gate reports the text that will never be seen",
    lintHtml(defect).rules.find((r) => r.id === "frozen-reveal").hits[0].includes("Shades of Sport"));
  check("CONTROL — opacity:1 (revealed) does not fire", fired(`<div style="opacity: 1; transition: 1s;">Shades of Sport</div>`, "frozen-reveal") === 0);
  // NARROW BY CONSTRUCTION (LEARNINGS #15): only INLINE opacity:0 counts. A stylesheet
  // .fade-in{opacity:0} that JS toggles is a different, legitimate pattern, and an
  // intentionally-hidden element (a closed dropdown) is not a miss. Do NOT widen this.
  check("CONTROL — a class-based hidden element does not fire (rule stays narrow)", fired(`<div class="fade-in">menu</div>`, "frozen-reveal") === 0);
}

// ---------- 4. stripped-scripts — JS-rendered page shipping zero <script> ----------
{
  const defect = `<body><div class="react-carousel-container" data-carousel-config="{}"><span>x</span></div></body>`;
  check("gate warns when a JS-rendered page ships no <script>", fired(defect, "stripped-scripts") === 1);
  check("CONTROL — a plain static page with no JS markers does not fire", fired(CLEAN, "stripped-scripts") === 0);
}

// ---------- 5. dead-canvas — script-painted canvas in a STATIC clone ----------
// bizar.ro (LEARNINGS #37): the page's entire visible painting is a WebGL canvas; the DOM
// skeleton measured identical on both sides (the same shared-blind-spot as this file's
// header, one layer down — pixels the capture cannot see are pixels both snapshots agree
// about), visual passed 1236/1236, and the published draft rendered SOLID BLACK. The
// reviewer wrote "cannot see any draft" and the round burned.
{
  // the bizar.ro shape: a canvas and almost nothing else painted → the canvas IS the page
  const defect = `<body><canvas id="scene" width="1440" height="900"></canvas><div id="app"></div></body>`;
  check("lint catches the canvas-only page (canvas + almost nothing else painted)", fired(defect, "dead-canvas") === 1);
  check("  …as FAIL — a static clone of a canvas-painted page is a blank sheet", levelOf(defect, "dead-canvas") === "FAIL");
  check("  …downgraded to WARN when fixes.js ships (the behavior phase may paint it)", levelOf(FIXES + defect, "dead-canvas") === "WARN");
  // a decorative canvas on a page that paints plenty else: surfaced, never failed
  const decorated = `<body><canvas id="confetti"></canvas><header><h1>Big Summer Sale</h1><p>${"plenty of visible copy here ".repeat(12)}</p></header><img src="assets/a.jpg"><img src="assets/b.jpg"><img src="assets/c.jpg"></body>`;
  check("a decorative canvas on a page that paints plenty else is WARN, not FAIL",
    fired(decorated, "dead-canvas") === 1 && levelOf(decorated, "dead-canvas") === "WARN");
  // canvas FALLBACK content only renders where canvas is unsupported — it must not count
  // as "the page paints something else"
  const fallbackOnly = `<body><canvas id="scene"><p>${"fallback prose that no real visitor sees ".repeat(10)}</p></canvas></body>`;
  check("canvas fallback content does not count as painted page content (still FAIL)", levelOf(fallbackOnly, "dead-canvas") === "FAIL");
  check("CONTROL — the clean canvas-free clone stays silent", fired(CLEAN, "dead-canvas") === 0);
}

// ---------- the real thing: a FROZEN specimen of the defective capture ----------
// scripts/fixtures-data/aloyoga-topofpage-capture.html is the aloyoga clone EXACTLY as the
// top-of-page capture produced it (sha f3d2c53b…) — frozen BEFORE the fix, per the kit's
// own rule ("freeze the PRE-fix pair as a real DEFECT before you touch the tool").
// Deliberately NOT read from targets/aloyoga/clone/ — that's the live working clone, and
// a re-clone with the fixed procedure (pxScrollSettle) will overwrite it with a CLEAN
// page; a check pinned there would go red because things got BETTER, and the reflex fix
// ("delete the failing check") would strip the lint's only real-page test.
// Lives in scripts/ (internal-only, tracked): harness/ ships WHOLESALE to the public
// repo, so a real site's full markup must never sit under harness/fixtures/.
{
  const fs = require("fs"), path = require("path");
  const specimen = path.join(__dirname, "..", "..", "scripts", "fixtures-data", "aloyoga-topofpage-capture.html");
  if (fs.existsSync(specimen)) {
    const { ok, rules } = lintHtml(fs.readFileSync(specimen, "utf8"));
    const fails = rules.filter((r) => r.level === "FAIL").map((r) => r.id).sort();
    const warns = rules.filter((r) => r.level === "WARN").map((r) => r.id).sort();
    check("FROZEN defective capture FAILS on the true capture defects (mount points, frozen reveals)",
      !ok && fails.join(",") === "empty-mount-point,frozen-reveal");
    check("FROZEN defective capture WARNs (not fails) on its by-design remote images",
      warns.includes("remote-assets"));
  } else {
    console.log("· scripts/fixtures-data not present (internal-only, never ships) — specimen check skipped");
  }
}

console.log(bad ? `\n✗ ${bad} check(s) failed` : "\n✓ clone-lint: JS/network-dependent clones are caught, clean clones stay silent");
process.exit(bad ? 1 : 0);
