/**
 * pixel-diff.js — exhaustive measure + numeric diff for pixel-perfect cloning.
 *
 * The point of this tool is to make "pixel-perfect" a PASS/FAIL fact, never an
 * eyeball judgement. For every target element it captures the COMPLETE box
 * (geometry, text-glyph box, full box-model, font INCLUDING line-height &
 * letter-spacing, layout, and the parent's flex/grid gap), then diffs the two
 * snapshots property-by-property. Any numeric delta over the tolerance, or any
 * mismatched string, is a failure — printed in a table, and (in Node) a non-zero
 * exit code so it can gate CI.
 *
 * Why it would have caught the bug it was written for: the "NEW" badge looked
 * fine but its box was 12px tall vs the live 14.5px (a collapsed line-height).
 * x / y / size / weight all matched — so a 4-property spot check passed. This
 * tool measures `font.line` and `text.h` for EVERY element, so that row fails
 * loudly instead of hiding behind a screenshot that "looks close".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE
 *
 *  A) Measure each page (paste into DevTools console, or run via a browser
 *     automation javascript_tool — once on the LIVE site, once on the clone,
 *     both at the SAME viewport width):
 *
 *        copy(pxCapture())            // returns a JSON snapshot string
 *
 *     Save them as e.g. live.json and clone.json.
 *
 *  B) Diff them deterministically in Node (exit 1 on any failure):
 *
 *        node tools/pixel-diff.js live.json clone.json
 *        node tools/pixel-diff.js live.json clone.json --tol 0.5 --all
 *
 *     Or diff in the browser without leaving the page:
 *
 *        pxDiff(liveSnapshotObj, cloneSnapshotObj)
 *
 *  C) Customise what gets measured by editing pxTargets (see TARGETS below).
 *     Finders match by TEXT / ROLE / aria-label — never by class name — so the
 *     same target resolves on both the live DOM and your clone.
 *
 *  D) On a strict-CSP live site driven by BROWSER AUTOMATION (not the DevTools
 *     console), the convenience paths are blocked — `copy()` doesn't exist,
 *     `eval()` is refused by script-src, the Clipboard API needs focus, and
 *     `fetch` to localhost is refused by connect-src. Use the CSP-proof path:
 *       1. Inject this file's SOURCE DIRECTLY (paste the whole file as the code
 *          to evaluate). A debugger-injected script is NOT gated by script-src,
 *          so the IIFE self-installs pxCapture/pxStash. Do NOT load it via
 *          fetch(...).then(eval) — that IS gated and will hang/fail.
 *       2. Call pxStash()  → writes the snapshot into a hidden <textarea> and
 *          returns {bytes, chunks, chunkSize}. Default chunk is 1000 chars to fit
 *          a typical automation result cap (~1–2KB); pass pxStash(null, N) to
 *          change it (a DevTools console has no cap — just use copy(pxCapture())).
 *       3. Call pxRead(0), pxRead(1), … pxRead(chunks-1) → slices that fit inside
 *          one automation result without truncation. Concatenate them and save as
 *          live.json. (getComputedStyle/Range are never CSP-blocked, so the
 *          measurement itself always works.)
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function (root) {
  "use strict";

  // ===========================================================================
  // 1. PURE DIFF ENGINE  (runs in browser AND Node — no DOM needed)
  // ===========================================================================

  const DEFAULT_TOL = 0.5; // px — anything over this is a real, visible miss

  // Flatten a nested measurement object to dotted leaf keys: {rect:{x:1}} -> {"rect.x":1}
  function flatten(obj, prefix, out) {
    out = out || {};
    prefix = prefix || "";
    if (obj == null || typeof obj !== "object") {
      out[prefix.replace(/\.$/, "")] = obj;
      return out;
    }
    for (const k of Object.keys(obj)) flatten(obj[k], prefix + k + ".", out);
    return out;
  }

  // Compare two leaf values. Returns {pass, delta} where delta is numeric or "".
  function cmp(a, b, tol) {
    const an = typeof a === "number" && isFinite(a);
    const bn = typeof b === "number" && isFinite(b);
    if (an && bn) {
      const d = Math.round(Math.abs(a - b) * 100) / 100;
      return { pass: d <= tol, delta: d };
    }
    // strings / booleans / nulls compare exactly
    return { pass: a === b, delta: "" };
  }

  /**
   * diffSnapshots(live, clone, opts) -> { ok, rows, summary }
   *   rows: [{ target, prop, live, clone, delta, pass }]
   * Only failing rows are kept unless opts.all is true.
   */
  // --visual judges the VISIBLE MARK and ignores wrapper/structure (see the
  // per-element logic in diffSnapshots): text elements compare their text-glyph
  // box + font metrics; graphics (icons/logo) compare center + width. Two valid
  // CSS techniques (flex+gap vs grid; a tall hit-area vs a tight box) can render
  // identical pixels, so those structural differences are not visual failures.
  // Strict mode (default) still compares every property so nothing is hidden.

  function diffSnapshots(live, clone, opts) {
    opts = opts || {};
    const tol = opts.tol == null ? DEFAULT_TOL : opts.tol;
    const rows = [];
    const warnings = [];
    let compared = 0; // total properties actually compared (not just kept rows)

    if (live.viewport && clone.viewport) {
      if (live.viewport.width !== clone.viewport.width)
        warnings.push(
          `viewport width differs: live ${live.viewport.width} vs clone ${clone.viewport.width} — ` +
            `x positions are not comparable. Re-measure both at the same width.`
        );
    }

    // Rendering-mode mismatch is a DEFECT row, not a warning: quirks ("BackCompat") vs
    // standards ("CSS1Compat") silently shifts line boxes everywhere with every computed
    // style identical — a doctype the live page doesn't have (or vice versa) must fail
    // loudly (LEARNINGS #18). Skipped when either snapshot predates the field.
    if (live.mode && clone.mode) {
      compared++;
      if (live.mode !== clone.mode)
        rows.push({ target: "page", prop: "mode", live: live.mode, clone: clone.mode, delta: "", pass: false });
      else if (opts.all)
        rows.push({ target: "page", prop: "mode", live: live.mode, clone: clone.mode, delta: "", pass: true });
    }

    const names = new Set([
      ...Object.keys(live.elements || {}),
      ...Object.keys(clone.elements || {}),
    ]);

    for (const name of names) {
      const L = live.elements[name];
      const C = clone.elements[name];

      // presence mismatch is the loudest possible failure
      const lPresent = L && L.present;
      const cPresent = C && C.present;
      if (!lPresent || !cPresent) {
        rows.push({
          target: name,
          prop: "present",
          live: !!lPresent,
          clone: !!cPresent,
          delta: "",
          pass: lPresent === cPresent, // both-absent is a "pass" but surfaced as a warning
        });
        if (!lPresent && !cPresent)
          warnings.push(`target "${name}" not found on EITHER page — finder needs fixing.`);
        continue;
      }

      // --visual compares the VISIBLE MARK, not the wrapper box:
      //  • text element  → the text-glyph box (text.*) + font metrics. The element
      //    rect is ignored (it may be a full-width bar or wrap an icon — invisible).
      //  • graphic (icon/logo) → the PAINTED glyph (glyph.*: center, size, and
      //    background-position), NOT the wrapper rect. A top-aligned glyph in a
      //    taller control makes rect.cy lie (control 91.25 vs glyph 89); glyph.cy
      //    is the pixel truth. Falls back to the rect center only if no glyph was
      //    captured. Strict mode (default) still compares every flattened property.
      if (opts.visual) {
        const add = (prop, a, b) => {
          const { pass, delta } = cmp(a, b, tol);
          compared++;
          if (!pass || opts.all) rows.push({ target: name, prop, live: a, clone: b, delta, pass });
        };
        // `smoothing` (-webkit-font-smoothing) changes perceived weight while
        // font-weight matches — a "looks thicker" no weight/size check catches
        // (LEARNINGS #13). `underline` is compared as a BOX below, not here.
        // `strut` is the line-box CONTAINER's line-height — a leaf can match while
        // the container that positions the line differs (`normal` vs 16px), which
        // drifts across platforms even when the same-machine delta is sub-tolerance
        // (LEARNINGS #17). Skipped when either side predates the strut capture.
        const FONT = ["weight", "size", "line", "spacing", "transform", "color", "decoration", "underline", "smoothing", "strut"];
        const isText = "text" in L || "text" in C; // text targets carry `text`; graphics carry `glyph`
        if (isText) {
          // Font metrics — INCLUDING color, decoration, underline, and smoothing — are
          // compared for EVERY text target, even when the glyph box came back null. A
          // finder that resolves a non-text WRAPPER (its own text node is empty) used
          // to fall through to the rect-only branch below, silently skipping color and
          // size. That blind spot is exactly how an invisible blue-on-blue
          // announcement (text color == background) passed `--visual`.
          if (L.font && C.font) for (const f of FONT) {
            // strut arrived in a schema update — skip when EITHER capture predates it
            // (undefined vs "normal" would false-positive a mixed old/new pair)
            if (f === "strut" && (L.font.strut === undefined || C.font.strut === undefined)) continue;
            add(`font.${f}`, L.font[f], C.font[f]);
          }
          if (L.text && C.text) {
            for (const k of ["x", "right", "top", "bottom", "w", "h"]) add(`text.${k}`, L.text[k], C.text[k]);
          } else {
            // present:true but no text-glyph box on a side → the finder grabbed a
            // wrapper, not the text. Surface it (fix the finder) instead of hiding it.
            add("text.present", !!L.text, !!C.text);
          }
          // An underline is a painted mark with a box (thickness/width/offset), not a
          // boolean — compare its geometry whenever either side draws one, so a too-thin
          // / too-short / mis-offset underline fails on run one (LEARNINGS #12).
          const lu = L.underline || { present: false }, cu = C.underline || { present: false };
          if (lu.present || cu.present) {
            add("underline.present", !!lu.present, !!cu.present);
            if (lu.present && cu.present)
              for (const k of ["thickness", "x", "right", "w", "top", "bottom"]) add(`underline.${k}`, lu[k], cu[k]);
          }
        } else if (L.glyph && C.glyph) {
          for (const k of ["cx", "cy", "w", "h"]) add(`glyph.${k}`, L.glyph[k], C.glyph[k]);
          if (L.glyph.bgPos !== undefined || C.glyph.bgPos !== undefined) add("glyph.bgPos", L.glyph.bgPos, C.glyph.bgPos);
        } else {
          add("rect.cx", L.rect.x + L.rect.w / 2, C.rect.x + C.rect.w / 2);
          add("rect.cy", L.rect.y + L.rect.h / 2, C.rect.y + C.rect.h / 2);
          add("rect.w", L.rect.w, C.rect.w);
        }
        // The painted BACKDROP colour (announcement bar / button / badge) — a
        // solid background is a painted mark, but it lives on a container the
        // per-target capture never measured, so a wrong bar colour slipped a green
        // sweep (the aloyoga miss). Compare it, but ONLY when BOTH sides paint an
        // OPAQUE colour: a translucent layer composites to pixels we can't
        // reconstruct from the declared string (comparing it would false-positive a
        // translucent-vs-solid pair that looks identical — proven in the detection
        // battery), and transparent-on-white text/icons should add no noise. Whitespace
        // is normalised so "rgb(0,0,0)" == "rgb(0, 0, 0)".
        const OPAQUE = (v) => typeof v === "string" && /^rgb\(|^#|^[a-z]+$/i.test(v) && !/rgba\(/.test(v);
        const norm = (v) => (typeof v === "string" ? v.replace(/\s+/g, "") : v);
        if (OPAQUE(L.bg) && OPAQUE(C.bg)) add("bg", norm(L.bg), norm(C.bg));
        continue;
      }

      const lf = flatten(L);
      const cf = flatten(C);
      const keys = new Set([...Object.keys(lf), ...Object.keys(cf)]);
      for (const key of keys) {
        if (key === "present" || key === "text") continue; // text is an object container
        const { pass, delta } = cmp(lf[key], cf[key], tol);
        compared++;
        if (!pass || opts.all) {
          rows.push({ target: name, prop: key, live: lf[key], clone: cf[key], delta, pass });
        }
      }
    }

    const fails = rows.filter((r) => !r.pass).length;
    return {
      ok: fails === 0,
      rows,
      warnings,
      summary: { targets: names.size, comparisons: compared, failures: fails, tol },
    };
  }

  // Render a diff result as a console-friendly table string.
  function formatDiff(result) {
    const lines = [];
    const pad = (s, n) => String(s == null ? "" : s).padEnd(n).slice(0, n);
    for (const w of result.warnings) lines.push("⚠  " + w);
    if (result.warnings.length) lines.push("");

    const fails = result.rows.filter((r) => !r.pass);
    const show = result.rows.length === fails.length ? fails : result.rows; // --all keeps passes
    if (show.length) {
      lines.push(
        pad("element", 18) + pad("property", 22) + pad("live", 16) + pad("clone", 16) + pad("Δ", 8) + "ok"
      );
      lines.push("─".repeat(86));
      for (const r of show) {
        lines.push(
          pad(r.target, 18) +
            pad(r.prop, 22) +
            pad(r.live, 16) +
            pad(r.clone, 16) +
            pad(r.delta === "" ? "" : r.delta, 8) +
            (r.pass ? "✓" : "❌")
        );
      }
      lines.push("");
    }
    const s = result.summary;
    lines.push(
      result.ok
        ? `✓ PASS — ${s.comparisons} comparisons across ${s.targets} targets, all within ${s.tol}px.`
        : `❌ FAIL — ${s.failures} of ${s.comparisons} comparisons over ${s.tol}px tolerance. Fix or explain each row above.`
    );
    return lines.join("\n");
  }

  // ===========================================================================
  // 1b. SINGLE-ELEMENT INSPECTOR DIFF  (the "operator points → we measure it" path)
  //
  // When a operator says "this looks wrong here", we don't want to guess which
  // property matters — we diff the ELEMENT'S ENTIRE computed style (plus its
  // painted marks) live-vs-clone and let every real difference surface. This is
  // the opposite of pxTargets' curated allowlist: here the default is "compare
  // everything, hide only provably-irrelevant props", so a novel property (a
  // border, a shadow, a text-decoration) is caught the first time, not after
  // someone notices. Feed it two `pxInspect(...)` dumps (same element, both pages).
  // ===========================================================================

  // Props that never change the rendered pixels — the ONLY things we hide.
  const INSPECT_IGNORE =
    /^(transition|animation|cursor|pointer-events|(-webkit-)?user-select|user-drag|will-change|scroll-|overscroll|touch-action|-webkit-tap-highlight|-webkit-locale|orphans|widows|speak|-webkit-line-break|-webkit-user-modify)/;
  // Props that determine what's PAINTED (surfaced first — the fix is almost always here).
  const INSPECT_PAINT =
    /^(color|background|border(?!-collapse)|outline|box-shadow|text-decoration|text-shadow|text-transform|text-emphasis|-webkit-text-stroke|-webkit-text-fill-color|font|letter-spacing|word-spacing|line-height|opacity|visibility|transform|filter|backdrop-filter|fill|stroke|caret-color|accent-color|list-style|object-fit|object-position|mix-blend-mode|clip-path|-webkit-mask|mask|-webkit-font-smoothing)/;

  // Compare two single-element inspector snapshots. Buckets every difference into
  // paint (visible → fix these) / structural (layout technique → usually fine) and
  // drops the ignore set. Geometry/text/glyph/underline are always paint.
  function inspectDiff(a, b, opts) {
    opts = opts || {};
    const tol = opts.tol == null ? DEFAULT_TOL : opts.tol;
    const paint = [], structural = [];
    const push = (bucket, prop, la, lb) => {
      const { pass, delta } = cmp(la, lb, tol);
      if (!pass || opts.all) bucket.push({ prop, live: la, clone: lb, delta, pass });
    };

    if (!a || !a.present || !b || !b.present) {
      return { ok: false, paint: [{ prop: "present", live: !!(a && a.present), clone: !!(b && b.present), delta: "", pass: false }], structural: [], summary: { paint: 1, structural: 0, tol } };
    }

    // 1) painted marks & geometry (the numbers that decide where pixels land)
    const geo = flatten({ rect: a.rect, text: a.text, glyph: a.glyph, underline: a.underline });
    const geoB = flatten({ rect: b.rect, text: b.text, glyph: b.glyph, underline: b.underline });
    for (const k of new Set([...Object.keys(geo), ...Object.keys(geoB)])) push(paint, k, geo[k], geoB[k]);

    // 2) the FULL computed style, classified
    const sa = a.style || {}, sb = b.style || {};
    for (const p of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
      if (INSPECT_IGNORE.test(p)) continue;
      const bucket = INSPECT_PAINT.test(p) ? paint : structural;
      push(bucket, p, sa[p], sb[p]);
    }
    const fails = [...paint, ...structural].filter((r) => !r.pass).length;
    return { ok: paint.filter((r) => !r.pass).length === 0, paint, structural, summary: { paint: paint.length, structural: structural.length, fails, tol } };
  }

  function formatInspect(res) {
    const lines = [], pad = (s, n) => String(s == null ? "" : s).padEnd(n).slice(0, n);
    const table = (rows) => {
      for (const r of rows) lines.push(pad(r.prop, 26) + pad(r.live, 22) + pad(r.clone, 22) + pad(r.delta === "" ? "" : r.delta, 7) + (r.pass ? "✓" : "❌"));
    };
    const paintFails = res.paint.filter((r) => !r.pass);
    lines.push("── PAINT (visible — fix these) ─────────────────────────────────────────────");
    if (paintFails.length || res.paint.some((r) => r.pass)) { lines.push(pad("property", 26) + pad("live", 22) + pad("clone", 22) + pad("Δ", 7) + "ok"); table(res.paint.length && res.paint.length === paintFails.length ? paintFails : (paintFails.length ? paintFails : res.paint)); }
    else lines.push("  (none — every painted property matches)");
    const structFails = res.structural.filter((r) => !r.pass);
    lines.push("");
    lines.push(`── STRUCTURAL (layout technique — usually fine): ${structFails.length} differ ──`);
    table(structFails);
    lines.push("");
    lines.push(res.ok
      ? `✓ PIXEL-PERFECT — 0 paint differences (${res.summary.structural} structural shown for context).`
      : `❌ ${paintFails.length} paint differences to fix. Structural: ${structFails.length}.`);
    return lines.join("\n");
  }

  // ===========================================================================
  // 2. BROWSER CAPTURE  (needs a real DOM + getComputedStyle)
  // ===========================================================================

  function buildBrowserApi() {
    const num = (v) => {
      const n = parseFloat(v);
      return isNaN(n) ? v : Math.round(n * 100) / 100;
    };

    // --- finders: resolve by TEXT / ROLE, so they work on live AND clone ---
    const ownText = (el) =>
      [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join("")
        .trim();

    // Region to search. Header/section clones must scope finders, or the SAME
    // text elsewhere on the page silently wins (e.g. a footer "Shoes" link beat
    // the nav item — found at y=318 instead of y=56). Default: top 200px (the
    // header band). Override with pxRegion = {maxY: N} or {sel: "header"} before
    // pxCapture/pxStash for a different section.
    root.pxRegion = root.pxRegion || { maxY: 200 };
    const inRegion = (el) => {
      const reg = root.pxRegion || {};
      if (reg.sel && !el.closest(reg.sel)) return false;
      const r = el.getBoundingClientRect();
      if (reg.maxY != null && r.top > reg.maxY) return false;
      if (reg.minY != null && r.bottom < reg.minY) return false;
      return r.width > 0;
    };

    // smallest element whose OWN text matches re, WITHIN the active region
    // (avoids matching ancestors and same-text elements elsewhere on the page)
    const byText = (re) => {
      const hits = [...document.querySelectorAll("a,button,span,p,li,h1,h2,h3,h4,div,sup,small,strong")]
        .filter((e) => re.test(ownText(e)) && inRegion(e));
      return hits.sort((a, b) => ownText(a).length - ownText(b).length)[0] || null;
    };
    const byAria = (re) =>
      [...document.querySelectorAll("[aria-label]")].find((e) => re.test(e.getAttribute("aria-label")) && inRegion(e)) ||
      null;
    // leftmost icon-sized control in the right half of the header band — used as a
    // label-agnostic fallback (e.g. a search icon that carries no aria-label).
    const leftmostRightIcon = () =>
      [...document.querySelectorAll("a,button")]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return inRegion(e) && r.x > window.innerWidth / 2 && r.width > 10 && r.width < 40 && r.height > 10 && r.height < 40;
        })
        .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x)[0] || null;

    // The STRUT of the line box that positions the glyphs: the nearest line-box
    // CONTAINER's line-height. A leaf's own line-height can match live exactly
    // (12 vs 12) while the container differs (authored 16px vs `normal`) — the
    // glyphs then land lower/higher, sub-tolerance on the capture machine but
    // visibly off on platforms where `normal` resolves differently (the HN header
    // miss — LEARNINGS #17). `normal` vs a number is a TECHNIQUE mismatch, so it
    // is kept as the string "normal", never coerced — the compare fails loudly.
    const strutOf = (el) => {
      let e = el, hops = 0;
      while (e && hops < 8) {
        const s = getComputedStyle(e);
        if (/^(block|table-cell|list-item|flex|grid|inline-block|table-caption)$/.test(s.display)) {
          return s.lineHeight === "normal" ? "normal" : num(s.lineHeight);
        }
        e = e.parentElement; hops++;
      }
      return null;
    };

    // glyph box of an element's own text via Range (ignores padding) — this is
    // what actually aligns visually, unlike getBoundingClientRect on the box.
    const textBox = (el) => {
      const tn = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
      if (!tn) return null;
      const r = document.createRange();
      r.selectNodeContents(tn);
      const b = r.getBoundingClientRect();
      return { x: num(b.x), right: num(b.right), top: num(b.top), bottom: num(b.bottom), w: num(b.width), h: num(b.height) };
    };

    // An underline is a painted mark with a BOX — measure it like one (thickness,
    // x/right/width, y top/bottom), not as a boolean. A boolean "has underline: true"
    // passed on both sides while the live line was 2px and mine 1px, spanned the
    // icon+text (211px) not just the text (185px), and sat at a different Y — three
    // defects hidden behind one green flag (LEARNINGS #12). The mark is often drawn by
    // an ANCESTOR or a sibling, so we resolve WHICH element paints it, then return its
    // box. Detection order (aloyoga uses a `border-bottom` on an ancestor group):
    //   (a) `text-decoration-line: underline` on the element or a near ancestor,
    //   (b) a `border-bottom` on the element or a near ancestor (a short wrapper),
    //   (c) a thin horizontal rule (an <hr>/absolute <span>, by border or by height)
    //       painted just below the text, within the nearest link/li.
    // Returns { present, thickness, x, right, w, top, bottom } (top/bottom null for a
    // text-decoration underline, whose rect isn't directly queryable). All geometry —
    // so `--visual` and `--inspect` compare where the line actually paints.
    const NO_UL = { present: false };
    const underlineBox = (el) => {
      let e = el, hops = 0;
      while (e && hops < 4) {
        const s = getComputedStyle(e);
        if ((s.textDecorationLine || "").includes("underline")) {
          const tb = textBox(el) || {};
          const th = s.textDecorationThickness && s.textDecorationThickness !== "auto"
            ? num(parseFloat(s.textDecorationThickness)) : "auto";
          return { present: true, thickness: th, x: tb.x ?? null, right: tb.right ?? null, w: tb.w ?? null, top: null, bottom: null };
        }
        const bbw = parseFloat(s.borderBottomWidth) || 0;
        const r = e.getBoundingClientRect();
        if (bbw > 0 && s.borderBottomStyle !== "none" && r.height < 60)
          return { present: true, thickness: num(bbw), x: num(r.x), right: num(r.right), w: num(r.width), top: num(r.bottom - bbw), bottom: num(r.bottom) };
        e = e.parentElement; hops++;
      }
      const tb = textBox(el);
      const base = el.closest("a,li") || el.parentElement;
      if (tb && base) {
        for (const cand of base.querySelectorAll("*")) {
          if (cand === el || cand.contains(el)) continue;
          const cs = getComputedStyle(cand);
          const r = cand.getBoundingClientRect();
          const bbw = parseFloat(cs.borderBottomWidth) || 0;
          const isBorder = bbw > 0 && cs.borderBottomStyle !== "none";
          const isFill = r.height <= 4;
          if ((isBorder || isFill) && r.width >= tb.w * 0.4 && r.bottom >= tb.bottom - 1 && r.bottom <= tb.bottom + 8) {
            const th = isBorder ? bbw : r.height;
            return { present: true, thickness: num(th), x: num(r.x), right: num(r.right), w: num(r.width), top: num(r.bottom - th), bottom: num(r.bottom) };
          }
        }
      }
      return NO_UL;
    };
    const underlineOf = (el) => underlineBox(el).present; // boolean shorthand

    // The PAINTED mark of a graphic (icon/logo), NOT its wrapper box. The wrapper
    // often lies: live top-aligns a 20px glyph inside a 24.5px control, so the
    // control centers at 91.25 while the visible glyph centers at 89. Measuring
    // the wrapper reports "aligned" while the pixels are 2.25px off — the exact
    // miss this guards against. Resolution order:
    //   1) inline <svg> → union of its shape bboxes (the actual drawn pixels)
    //   2) background-image → the DEEPEST element carrying it (a wrapper may also
    //      have one), plus its background-position/size (top-aligned vs centered
    //      changes the pixels)
    //   3) fallback → the element's own box
    // The painted BACKDROP behind an element — a solid `background-color` is a
    // painted mark too (an announcement bar, a button, a badge), but it lives on a
    // CONTAINER, not on the text/icon leaf, so the per-target capture never saw it:
    // a bright-red bar passed a green `--visual` because the colour was nowhere in
    // the schema (the aloyoga miss — DEVELOP meta-loop). Walk self→ancestors and
    // return the first non-transparent background-color (the colour actually painted
    // behind this mark), capped so we stay within the section. Compared by --visual,
    // so a wrong bar/button colour fails on run one — the LEARNINGS #10 lesson
    // (invisible blue-on-blue text) generalised from the glyph to its backdrop.
    const TRANSPARENT_BG = "rgba(0, 0, 0, 0)";
    const isTransparent = (bc) => !bc || bc === TRANSPARENT_BG || bc === "transparent" || /,\s*0\)\s*$/.test(bc);
    const paintedBg = (el) => {
      // Walk self→ancestors to the ROOT for the first opaque background-color. If the
      // whole chain is transparent, the visible colour is the CANVAS default — white,
      // unless html/body paint one (found in the walk). Resolving to the canvas is what
      // makes a clone's explicit `body{background:#fff}` compare EQUAL to a live site
      // that leaves the canvas transparent — same painted pixels, same value.
      let e = el, hops = 0;
      while (e && hops < 40) {
        const bc = getComputedStyle(e).backgroundColor;
        if (!isTransparent(bc)) return bc;
        e = e.parentElement; hops++;
      }
      return "rgb(255, 255, 255)";
    };

    const depth = (e) => { let d = 0; while ((e = e.parentElement)) d++; return d; };
    const glyphBox = (el) => {
      const wrap = (b, extra) => ({
        cx: num(b.left + b.width / 2), cy: num(b.top + b.height / 2),
        top: num(b.top), bottom: num(b.bottom), w: num(b.width), h: num(b.height),
        ...extra,
      });
      const svg = el.tagName.toLowerCase() === "svg" ? el : el.querySelector("svg");
      if (svg) {
        const shapes = [...svg.querySelectorAll("path,circle,rect,polygon,polyline,line,ellipse,use")];
        let t = Infinity, l = Infinity, rr = -Infinity, bb = -Infinity;
        for (const s of shapes) { const r = s.getBoundingClientRect(); if (r.width || r.height) { t = Math.min(t, r.top); l = Math.min(l, r.left); rr = Math.max(rr, r.right); bb = Math.max(bb, r.bottom); } }
        if (isFinite(t)) return wrap({ left: l, top: t, width: rr - l, height: bb - t }, { src: "svg-path" });
        return wrap(svg.getBoundingClientRect(), { src: "svg" });
      }
      // deepest-first: a background on the glyph itself beats one on a wrapper.
      const withBg = [...el.querySelectorAll("*"), el].filter((e) => getComputedStyle(e).backgroundImage !== "none");
      const bgEl = withBg.sort((a, b) => depth(b) - depth(a))[0];
      if (bgEl) {
        const bc = getComputedStyle(bgEl);
        return wrap(bgEl.getBoundingClientRect(), { src: "bg", bgPos: bc.backgroundPosition, bgSize: bc.backgroundSize });
      }
      return wrap(el.getBoundingClientRect(), { src: "box" });
    };

    // `rect.prevGap` is a LAYOUT fact, so it must be measured against a sibling that actually
    // LAYS OUT. previousElementSibling counts elements that render nothing (<script>, <style>,
    // <link>, <meta>, <template>, <noscript>) — and capture-build STRIPS exactly those (#19), so
    // a leaf preceded by a <script> gets a different "previous sibling" on live than in the
    // clone and strict reports a delta for a page where nothing moved: a false positive the kit
    // manufactures itself. (lelabo: a screenreader <h1> preceded by `<script>headerInitialize()`
    // → live prevGap -1, clone prevGap -1729, while --visual was green on all 1394 comparisons.)
    // Kept schema-identical with browser-capture.js's measure().
    const NON_RENDERED = /^(SCRIPT|STYLE|LINK|META|TEMPLATE|NOSCRIPT|TITLE|BASE|HEAD)$/;
    const prevRenderedSibling = (el) => {
      let p = el.previousElementSibling;
      while (p && (NON_RENDERED.test(p.tagName) || getComputedStyle(p).display === "none")) p = p.previousElementSibling;
      return p;
    };

    // FULL measurement of one element — every property that can shift a pixel.
    function measure(el, want) {
      if (!el) return { present: false };
      const r = el.getBoundingClientRect();
      const c = getComputedStyle(el);
      const vw = window.innerWidth;
      const parent = el.parentElement;
      const pc = parent ? getComputedStyle(parent) : null;
      const prev = prevRenderedSibling(el);
      const out = {
        present: true,
        rect: {
          x: num(r.x),
          y: num(r.y),
          w: num(r.width),
          h: num(r.height),
          top: num(r.top),
          right: num(r.right),
          bottom: num(r.bottom),
          fromRight: num(vw - r.right), // for right-anchored elements
        },
        font: {
          family: (c.fontFamily || "").split(",")[0].replace(/["']/g, "").trim(),
          weight: c.fontWeight,
          size: num(c.fontSize),
          line: c.lineHeight === "normal" ? "normal" : num(c.lineHeight), // ← the one people skip
          spacing: c.letterSpacing === "normal" ? "normal" : num(c.letterSpacing),
          transform: c.textTransform,
          color: c.color,
          decoration: c.textDecorationLine || "none", // underline/line-through/none
          smoothing: c.webkitFontSmoothing || c.getPropertyValue("-webkit-font-smoothing") || "auto", // antialiased vs auto → perceived weight
        },
        box: {
          padT: num(c.paddingTop), padR: num(c.paddingRight), padB: num(c.paddingBottom), padL: num(c.paddingLeft),
          marT: num(c.marginTop), marR: num(c.marginRight), marB: num(c.marginBottom), marL: num(c.marginLeft),
          bT: num(c.borderTopWidth), bR: num(c.borderRightWidth), bB: num(c.borderBottomWidth), bL: num(c.borderLeftWidth),
          sizing: c.boxSizing,
        },
        layout: {
          display: c.display,
          position: c.position,
          top: c.top === "auto" ? "auto" : num(c.top),
          left: c.left === "auto" ? "auto" : num(c.left),
          vAlign: c.verticalAlign,
        },
        parent: pc ? { display: pc.display, gap: pc.gap === "normal" ? 0 : num(pc.gap) } : null,
        // the colour actually painted behind this mark (self or nearest painted
        // ancestor) — so a wrong announcement-bar / button / badge colour is caught
        bg: paintedBg(el),
      };
      if (want && want.text) {
        out.text = textBox(el);
        out.font.strut = strutOf(el);            // the line-box container's line-height (LEARNINGS #17)
        out.underline = underlineBox(el);        // the underline as a painted BOX
        out.font.underline = out.underline.present; // boolean shorthand (back-compat)
        // relation to previous sibling (catches wrong gaps between nav items)
        if (prev) out.rect.prevGap = num(r.left - prev.getBoundingClientRect().right);
      } else {
        // graphic: measure the painted mark, not just the wrapper box
        out.glyph = glyphBox(el);
      }
      return out;
    }

    // ----- default TARGETS — REPLACE THESE with your own page's elements -----
    // Each entry is [name, () => findElement(), measureTextBox?].
    //   • measureTextBox = true  → text element: measures the text-glyph box (Range)
    //                              + font metrics (incl. color, line, spacing, underline)
    //   • measureTextBox = false → graphic (icon/logo): measures the PAINTED glyph
    //                              (SVG bbox, or bg element + background-position)
    // Finders resolve by TEXT / ROLE / aria-label / selector — never by class name —
    // so the SAME target resolves on both the live DOM and your clone. Scope them
    // with pxRegion (default: top 200px) so the same text elsewhere can't win.
    // See docs/PLAYBOOK.md → "Step 5: close coverage" to build this list completely.
    const TARGETS = [
      // examples — delete and write your own:
      ["logo", () => document.querySelector("header svg, nav svg, [class*=logo] svg"), false],
      ["nav_first", () => byText(/^(home|shop|products|women)$/i), true],
      ["cart_icon", () => byAria(/cart|bag|basket/i) || leftmostRightIcon(), false],
    ];

    function capture(targets, opts) {
      const T = targets || (root.pxTargets = root.pxTargets || TARGETS);
      const elements = {};
      for (const [name, find, text] of T) {
        let el = null;
        try { el = find(); } catch (e) { /* finder threw → treat as absent */ }
        elements[name] = measure(el, { text });
      }
      const snap = {
        url: location.href,
        viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
        // rendering mode (quirks "BackCompat" vs standards "CSS1Compat") — pixel-determining
        // for the whole page; kept schema-identical with browser-capture.js (LEARNINGS #18)
        mode: document.compatMode,
        elements,
      };
      // compact for machine export (smaller → fewer chunk reads); pretty for operators
      return opts && opts.compact ? JSON.stringify(snap) : JSON.stringify(snap, null, 2);
    }

    // ----- single-element inspector (the "operator points → measure it" path) -----
    // Resolve ONE element the operator flagged — by visible text, aria-label, CSS
    // selector, or a click coordinate — then dump its rect, painted marks, AND its
    // FULL computed style. Same call on live and clone; diff the two with
    // `inspectDiff` (node --inspect) to get every real difference, ranked
    // paint-first. resolver: {text:"sign in"} | {aria:/cart/} | {sel:".x"} |
    // {at:[x,y]} | a function returning an element.
    function resolveOne(resolver) {
      if (typeof resolver === "function") return resolver() || null;
      const rq = resolver || {};
      if (rq.sel) return document.querySelector(rq.sel);
      if (rq.at) return document.elementFromPoint(rq.at[0], rq.at[1]);
      if (rq.aria) { const re = rq.aria instanceof RegExp ? rq.aria : new RegExp(rq.aria, "i"); return byAria(re); }
      if (rq.text) {
        const re = rq.text instanceof RegExp ? rq.text : new RegExp(rq.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        // smallest element whose OWN text matches, in region (same rule as byText)
        return byText(re);
      }
      return null;
    }

    function inspect(resolver, opts) {
      const el = resolveOne(resolver);
      if (!el) return JSON.stringify({ present: false, resolver: String(resolver && (resolver.text || resolver.aria || resolver.sel || resolver.at)) });
      const c = getComputedStyle(el), r = el.getBoundingClientRect();
      const style = {};
      for (let i = 0; i < c.length; i++) { const p = c[i]; style[p] = c.getPropertyValue(p); }
      const hasGraphic = el.tagName.toLowerCase() === "svg" || el.querySelector("svg") ||
        [...el.querySelectorAll("*"), el].some((e) => getComputedStyle(e).backgroundImage !== "none");
      const snap = {
        present: true,
        tag: el.tagName.toLowerCase(),
        cls: (el.className && el.className.toString ? el.className.toString() : "").slice(0, 60),
        rect: { x: num(r.x), y: num(r.y), w: num(r.width), h: num(r.height), top: num(r.top), right: num(r.right), bottom: num(r.bottom), fromRight: num(window.innerWidth - r.right) },
        text: textBox(el),
        glyph: hasGraphic ? glyphBox(el) : null,
        underline: underlineBox(el), // the underline as a painted box (thickness/width/y), not a boolean
        style,
      };
      return opts && opts.compact ? JSON.stringify(snap) : JSON.stringify(snap, null, 2);
    }

    return { capture, measure, inspect, resolveOne, byText, byAria, TARGETS };
  }

  // ===========================================================================
  // 3. WIRE UP per environment
  // ===========================================================================

  if (typeof window !== "undefined" && window.document) {
    const api = buildBrowserApi();
    root.pxCapture = api.capture; // -> JSON string snapshot (copy() it)
    root.pxTargets = api.TARGETS; // editable array of [name, finder, measureText]
    root.pxMeasure = api.measure; // measure one element ad hoc
    root.pxByText = api.byText;
    root.pxInspect = api.inspect; // full-computed-style dump of ONE flagged element
    root.pxDiff = function (live, clone, opts) {
      const a = typeof live === "string" ? JSON.parse(live) : live;
      const b = typeof clone === "string" ? JSON.parse(clone) : clone;
      const res = diffSnapshots(a, b, opts);
      console.log(formatDiff(res));
      return res;
    };
    // Diff two pxInspect dumps in the browser (paint-first). For the operator-flagged
    // element: pxInspect on live + clone, then pxInspectDiff(liveDump, cloneDump).
    root.pxInspectDiff = function (a, b, opts) {
      const A = typeof a === "string" ? JSON.parse(a) : a;
      const B = typeof b === "string" ? JSON.parse(b) : b;
      const res = inspectDiff(A, B, opts);
      console.log(formatInspect(res));
      return res;
    };
    // Compact stash/read of a single-element inspect dump (CSP-proof, like pxStash).
    root.pxStashInspect = function (resolver, chunk) {
      return root.pxStash(null, chunk, api.inspect(resolver, { compact: true }));
    };

    // --- CSP-proof export for browser AUTOMATION (no clipboard, no network) ---
    // On a strict-CSP third-party site, `copy()` doesn't exist, the Clipboard API
    // needs focus, and `fetch` to localhost is blocked by connect-src. So instead
    // stash the snapshot in a hidden <textarea> in the page itself, then read it
    // back in bounded slices with follow-up evaluate calls.
    //   1) pxStash(targets, chunk?)   → writes snapshot to #__pixeldiff, returns {bytes,chunks,chunkSize}
    //   2) pxRead(i)                  → returns the i-th chunk (sized to fit one result)
    // Reassemble the chunks on your side and save as live.json / clone.json.
    //
    // chunkSize must be SMALLER than the per-result cap of whatever is reading the
    // value. A operator in the DevTools console has no cap → pass a big number (or
    // just use copy(pxCapture())). A browser-automation harness typically truncates
    // each result at ~1–2KB → keep the default 1000. Pass an explicit size if your
    // harness differs; pxStash remembers it so pxRead uses the same slicing.
    // One call, same-origin (or any origin whose CSP allows connect to `url`):
    // capture + POST in a single round-trip. Fastest path when not CSP-blocked —
    // use it for the clone (localhost) and skip stash/read entirely.
    //   pxSend("http://localhost:7799/clone.json")   → returns the sink's reply
    root.pxSend = function (url, targets) {
      return fetch(url, { method: "POST", body: api.capture(targets, { compact: true }) }).then((r) => r.text());
    };

    const DEFAULT_CHUNK = 1000;
    root.pxStash = function (targets, chunk, preJson) {
      // preJson lets callers (e.g. pxStashInspect) stash an already-built payload
      const json = preJson != null ? preJson : api.capture(targets, { compact: true }); // compact → ~40% fewer chunks
      const size = chunk || DEFAULT_CHUNK;
      let ta = document.getElementById("__pixeldiff");
      if (!ta) {
        ta = document.createElement("textarea");
        ta.id = "__pixeldiff";
        ta.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px";
        document.body.appendChild(ta);
      }
      ta.value = json;
      ta.dataset.chunk = size; // remember slicing so pxRead matches
      return { bytes: json.length, chunks: Math.ceil(json.length / size), chunkSize: size };
    };
    root.pxRead = function (i) {
      const ta = document.getElementById("__pixeldiff");
      if (!ta) return null;
      const size = Number(ta.dataset.chunk) || DEFAULT_CHUNK;
      return ta.value.slice(i * size, (i + 1) * size);
    };

    console.log(
      "%cpixel-diff loaded.",
      "font-weight:bold",
      "\n  console:      copy(pxCapture())             snapshot this page" +
        "\n  same-origin:  pxSend(sinkUrl)              1-call capture+POST (fastest)" +
        "\n  CSP/live:     pxStash() then pxRead(0..n)  inject once, batch the reads" +
        "\n  diff:         pxDiff(liveObj, cloneObj)    add {visual:true} for pixels-only" +
        "\n  edit pxTargets to add elements; pxRegion to scope the search"
    );
  } else if (typeof module !== "undefined" && module.exports) {
    module.exports = { diffSnapshots, formatDiff, flatten, inspectDiff, formatInspect };
    if (require.main === module) {
      const fs = require("fs");
      // Parse args properly: --tol consumes the NEXT token as its value (the old
      // `filter(!startsWith("--"))` counted that value as a file, so `--tol 0.5` broke
      // and printed usage). Unknown --flags are rejected, not silently ignored.
      const argv = process.argv.slice(2);
      const files = [];
      let tol = DEFAULT_TOL, tolGiven = false, tolRaw;
      for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--tol") { tolRaw = argv[++i]; tol = parseFloat(tolRaw); tolGiven = true; }
        else if (a === "--all" || a === "--visual" || a === "--inspect") { /* boolean flag */ }
        else if (a.startsWith("--")) { console.error(`unknown flag "${a}". valid: --visual --inspect --all --tol <px>`); process.exit(2); }
        else files.push(a);
      }
      const opts = { all: argv.includes("--all"), visual: argv.includes("--visual"), tol };
      const inspect = argv.includes("--inspect");
      const USAGE =
        "usage: node tools/pixel-diff.js <live.json> <clone.json> [--tol 0.5] [--all] [--visual]\n" +
        "       node tools/pixel-diff.js --inspect <live-el.json> <clone-el.json> [--tol] [--all]\n" +
        "  --visual   compare only pixel-determining props (ignore structural CSS differences)\n" +
        "  --inspect  diff two single-element pxInspect() dumps, ranked paint-first";
      // --- input validation with self-describing, actionable errors (exit 2 = bad input) ---
      if (files.length !== 2) {
        console.error(`expected 2 snapshot files, got ${files.length}${files.length ? " (" + files.join(", ") + ")" : ""}.\n` + USAGE);
        process.exit(2);
      }
      if (tolGiven && !(isFinite(tol) && tol >= 0)) {
        console.error(`--tol needs a non-negative number (got "${tolRaw}").`);
        process.exit(2);
      }
      const load = (f) => {
        if (!fs.existsSync(f)) { console.error(`${f} not found — capture it first (see tools/RUNBOOK.md). Both a live and a clone snapshot are required.`); process.exit(2); }
        let txt; try { txt = fs.readFileSync(f, "utf8"); } catch (e) { console.error(`could not read ${f}: ${e.message}`); process.exit(2); }
        if (/^\s*\[BLOCKED/.test(txt)) { console.error(`${f} holds a "[BLOCKED…]" automation sentinel, not a snapshot — the capture was blocked. Re-capture via the sink/stash path (RUNBOOK).`); process.exit(2); }
        try { return JSON.parse(txt); } catch (e) { console.error(`${f} is not valid JSON: ${e.message}. Re-capture it (a truncated or partial paste is the usual cause).`); process.exit(2); }
      };
      const a = load(files[0]);
      const b = load(files[1]);
      if (!inspect) {
        // a full-snapshot diff needs .elements on both; a single-element pxInspect() dump here is a mix-up.
        for (const [f, s] of [[files[0], a], [files[1], b]])
          if (!s || !s.elements) { console.error(`${f} has no "elements" — is it a pxCapture() snapshot? (a pxInspect() dump goes with --inspect.)`); process.exit(2); }
      }
      if (inspect) {
        const res = inspectDiff(a, b, opts);
        console.log(formatInspect(res));
        process.exit(res.ok ? 0 : 1); // "ok" = zero PAINT differences
      }
      const res = diffSnapshots(a, b, opts);
      console.log(formatDiff(res));
      process.exit(res.ok ? 0 : 1); // CI gate: 0 pass, 1 diff failure, 2 bad input
    }
  }
})(typeof window !== "undefined" ? window : globalThis);
