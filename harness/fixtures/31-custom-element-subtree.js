// fixtures/31-custom-element-subtree.js — THE INSTRUMENT'S OWN COPY STEP DELETED THE CONTENT.
//
// Paid for on chrono24 (2026-07-13). The site mounts its MAIN SEARCH BAR into an upgraded custom
// element: <c24-main-search-app data-v-app> — 22 nodes, 662x50, the most prominent control on the
// homepage. Measured on the live page:
//
//   app.outerHTML                     → 1928 chars (the whole <form>)   ← faithful
//   app.cloneNode(true).children      → 0                               ← DESTROYED
//
// Because cloneNode(true) on an UPGRADED custom element constructs a *fresh* instance — the
// browser runs the element's constructor, and a framework-defined element (Vue
// defineCustomElement, Lit, Stencil, …) re-initialises itself there, dropping the hydrated
// subtree. pxDomHtml() serialized from `document.documentElement.cloneNode(true)` (the clone was
// introduced by #24, so the agent-overlay strip would never mutate the live page). So the capture
// wrote `<c24-main-search-app><!----></c24-main-search-app>`, capture-build shipped an empty mount
// point, and NO number of re-captures could fix it: every capture destroyed it again.
//
// This is LEARNINGS #23 in its purest form — a measurement must be INVARIANT under the kit's own
// transforms. The clone step existed to protect the live page; it was quietly deleting the page.
//
// THE FIX: serialize the LIVE tree to a string first (outerHTML walks the real children), then
// re-parse it in a DOMParser document — which has no custom-element registry, so nothing upgrades
// and no constructor runs. The live page is still never mutated.
//
// NARROW BY CONSTRUCTION: the fix changes only HOW the detached copy is obtained. It is not keyed
// on tag names, frameworks, or attributes — controls 4/5 prove ordinary elements and the agent
// strip are untouched, so nothing about a plain page changes.
"use strict";
let bad = 0;
const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

// ── A mini-DOM good enough to drive the REAL pxDomHtml (no deps, no jsdom) ───────────
// The one behavior that matters: a CUSTOM element (hyphenated tag, "upgraded") loses its
// children when cloned — exactly what Chrome does when the constructor re-initialises it.
class El {
  constructor(tag, attrs, kids) {
    this.tagName = tag;
    this.attrs = attrs || {};
    this.children = kids || [];
    this.parent = null;
    this.nodeType = 1;
    for (const k of this.children) k.parent = this;
  }
  get id() { return this.attrs.id || ""; }
  get isCustom() { return this.tagName.includes("-"); }   // an upgraded custom element
  cloneNode() {
    // THE BROWSER'S BEHAVIOR: cloning an upgraded custom element runs its constructor, which
    // re-initialises it — the cloned node comes back WITHOUT the hydrated subtree.
    if (this.isCustom) return new El(this.tagName, { ...this.attrs }, []);
    return new El(this.tagName, { ...this.attrs }, this.children.map((k) => k.cloneNode()));
  }
  get all() { const out = []; const walk = (e) => { for (const k of e.children) { out.push(k); walk(k); } }; walk(this); return out; }
  querySelectorAll(sel) {
    if (!/claude-agent-|claude-phantom-/.test(sel)) throw new Error(`shim got unexpected selector: ${sel}`);
    return this.all.filter((e) => /^claude-(agent|phantom)-/.test(e.id));
  }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((k) => k !== this); }
  get outerHTML() {
    const a = Object.entries(this.attrs).map(([k, v]) => ` ${k}="${v}"`).join("");
    return `<${this.tagName}${a}>${this.children.map((k) => k.outerHTML).join("")}</${this.tagName}>`;
  }
}

// A DOMParser stub that really PARSES the string it is handed (the subset our shim emits). It must
// parse, not deep-copy: if pxDomHtml cloned the live tree first, the string it passes here has
// ALREADY lost the subtree, and this fixture must fail. That is the whole point.
class DOMParserShim {
  parseFromString(str) {
    const re = /<(\/)?([a-z][a-z0-9-]*)((?:\s+[a-z-]+="[^"]*")*)\s*>/gi;
    const stack = [];
    let m, root = null;
    while ((m = re.exec(str))) {
      const [, closing, tag, attrStr] = m;
      if (closing) { stack.pop(); continue; }
      const attrs = {};
      for (const am of attrStr.matchAll(/([a-z-]+)="([^"]*)"/gi)) attrs[am[1]] = am[2];
      const el = new El(tag, attrs, []);
      const top = stack[stack.length - 1];
      if (top) { top.children.push(el); el.parent = top; } else root = el;
      stack.push(el);
    }
    return { documentElement: root };
  }
}

// chrono24's shape: an upgraded custom element holding the site's main search bar, plus the
// agent's overlay, plus ordinary content.
const buildPage = () => new El("html", {}, [
  new El("head", {}, [new El("style", { id: "claude-agent-animation-styles" }, [])]),
  new El("body", {}, [
    new El("header", { id: "site-header" }, [
      new El("c24-main-search-app", { class: "wt-main-search-app", "data-v-app": "" }, [
        new El("form", { id: "search-form" }, [
          new El("label", { id: "search-label" }, []),
          new El("input", { id: "search-input" }, []),
        ]),
      ]),
    ]),
    new El("div", { id: "claude-agent-glow-border" }, [new El("div", { id: "claude-agent-glow-border-inner" }, [])]),
    new El("div", { id: "claude-phantom-cursor" }, []),
    new El("main", { id: "content" }, [new El("p", { id: "copy" }, [])]),
  ]),
]);

require("../../tools/browser-capture.js"); // attaches pxDomHtml to globalThis

// ── 1. THE DEFECT IS REAL — the shim reproduces the browser's destructive clone ──────
{
  const page = buildPage();
  const cloned = page.cloneNode(true);
  const appInClone = cloned.all.find((e) => e.tagName === "c24-main-search-app");
  check("the shim reproduces the browser: cloneNode(true) DROPS an upgraded custom element's subtree",
    !!appInClone && appInClone.children.length === 0);
  check("…while the LIVE element still holds its subtree (outerHTML is faithful)",
    /id="search-form"/.test(page.outerHTML));
}

// ── 2. THE FIX — pxDomHtml must preserve the custom element's subtree ────────────────
// FAILS WITHOUT THE CHANGE: the old pxDomHtml cloneNode(true)s the documentElement, so the search
// form is gone from the captured HTML and every assertion below about it fails.
{
  const page = buildPage();
  global.document = { doctype: { name: "html", publicId: "", systemId: "" }, documentElement: page };
  global.DOMParser = DOMParserShim;
  const html = global.pxDomHtml();

  check("pxDomHtml CAPTURES the custom element's hydrated subtree (the site's main search bar)",
    /<c24-main-search-app[^>]*>\s*<form/.test(html) && /id="search-form"/.test(html));
  check("…including its leaves (the label + input the coverage gate enumerates)",
    /id="search-label"/.test(html) && /id="search-input"/.test(html));
  check("the custom element is NOT captured as an empty mount point",
    !/<c24-main-search-app[^>]*><\/c24-main-search-app>/.test(html));

  // 3. #24 still holds — the agent's overlay is stripped on the DOMParser path too.
  check("#24 HOLDS: the agent's glow border is still stripped", !/claude-agent-glow-border/.test(html));
  check("#24 HOLDS: the agent's phantom cursor is still stripped", !/claude-phantom-cursor/.test(html));
  check("#24 HOLDS: the agent's injected <style> is still stripped", !/claude-agent-animation-styles/.test(html));
  check("#24 HOLDS: the LIVE page is never mutated (the strip happens off to the side)",
    page.all.some((e) => e.id === "claude-agent-glow-border"));
  check("#18 HOLDS: the doctype is still emitted", /^<!DOCTYPE html>/.test(html));

  // 4. CONTROL — ordinary elements are untouched by the new copy path (no over-fit).
  check("CONTROL: the site's ordinary content survives unchanged (header, main, copy)",
    /id="site-header"/.test(html) && /id="content"/.test(html) && /id="copy"/.test(html));
}

// ── 5. CONTROL — the no-DOMParser fallback still honours the #24 contract ────────────
{
  const page = buildPage();
  global.document = { doctype: { name: "html", publicId: "", systemId: "" }, documentElement: page };
  delete global.DOMParser;
  const html = global.pxDomHtml();
  check("CONTROL: with no DOMParser (non-browser host) the agent strip still works",
    !/claude-agent-glow-border/.test(html) && !/claude-phantom-cursor/.test(html));
  check("CONTROL: …and ordinary content still survives", /id="content"/.test(html));
}

console.log(bad ? `\n✗ ${bad} check(s) failed` : "\n✓ 31-custom-element-subtree: the capture preserves upgraded custom elements' subtrees.");
process.exit(bad ? 1 : 0);
