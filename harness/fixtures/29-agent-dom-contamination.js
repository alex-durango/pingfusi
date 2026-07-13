// fixtures/29-agent-dom-contamination.js — THE INSTRUMENT MEASURED ITSELF.
//
// Paid for on gorjana (2026-07-13), and it is the miss a fully green sweep did not catch:
// --visual 1300/1300, strict 4144/4144, coverage 88/88, clone-lint clean.
//
// The browser-automation extension driving the capture injects its own overlay DOM into the page
// it is measuring. Claude-in-Chrome paints:
//   • <div id="claude-agent-glow-border"> + #claude-agent-glow-border-inner — a border that
//     PULSES, driven by @keyframes `claude-pulse` in a <style id="claude-agent-animation-styles">
//     the extension also injects;
//   • <div id="claude-phantom-cursor"> — a fake cursor with two <svg> children.
// They are injected WHILE the agent acts, so whether they land in a capture is a matter of timing.
//
// Three artifacts were contaminated on gorjana, all through green gates:
//   behaviors-live.json  "reveal:claude-agent-glow-border-inner" — the glow's own pulse
//                        (opacity 0.697 → 0.609 across the scroll sweep) recorded as a BEHAVIOR
//                        OF GORJANA. The clone can never reproduce it: the behavior gate would
//                        report a miss on a page where nothing is wrong.
//   behaviors-live.json  "declared:claude-phantom-cursor" — the agent's cursor, filed as site
//                        choreography awaiting reproduction.
//   discovery.keyframesFound  "claude-pulse" — listed among the SITE's keyframes.
// And pxDomHtml() returned #claude-agent-glow-border live, so a DOM captured a moment later would
// have BAKED THE AGENT'S CURSOR AND BORDER INTO THE CLONE — shipped to a reviewer as gorjana.
//
// This is LEARNINGS #23 ("the build is part of the instrument") taken to its sharpest form: not
// the build transforming the page, but the MEASURING APPARATUS PAINTING ON IT. A defect the gate
// invents about a page where nothing is wrong costs the same trust as a defect it misses.
//
// NARROW BY CONSTRUCTION: keyed on the extension's own ID NAMESPACE (#claude-agent-*,
// #claude-phantom-*), never on a class or text match — a site is perfectly free to ship a class
// named "claude-something", and control 5 below proves such an element is untouched.
"use strict";
let bad = 0; const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

// ── 1+2. THE CAPTURE — pxDomHtml must not serialize the agent's overlay ──────────────
// A mini-DOM (no deps, no jsdom) good enough to drive the REAL pxDomHtml removal loop.
{
  class El {
    constructor(tag, id, kids) { this.tagName = tag; this.id = id || ""; this.children = kids || []; this.parent = null; this.nodeType = 1; for (const k of this.children) k.parent = this; }
    cloneNode() { const c = new El(this.tagName, this.id, this.children.map((k) => k.cloneNode())); return c; }
    get all() { const out = []; const walk = (e) => { for (const k of e.children) { out.push(k); walk(k); } }; walk(this); return out; }
    // only the agent selector is ever passed here — match it structurally
    querySelectorAll(sel) {
      if (!/claude-agent-|claude-phantom-/.test(sel)) throw new Error(`shim got unexpected selector: ${sel}`);
      return this.all.filter((e) => /^claude-(agent|phantom)-/.test(e.id));
    }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((k) => k !== this); }
    get outerHTML() {
      const attr = this.id ? ` id="${this.id}"` : "";
      return `<${this.tagName}${attr}>${this.children.map((k) => k.outerHTML).join("")}</${this.tagName}>`;
    }
  }
  const build = () => new El("html", "", [
    new El("head", "", [new El("style", "claude-agent-animation-styles", [])]),
    new El("body", "", [
      new El("header", "site-header", []),
      new El("div", "claude-agent-glow-border", [new El("div", "claude-agent-glow-border-inner", [])]),
      new El("div", "claude-phantom-cursor", [new El("svg", "claude-phantom-cursor-plain", [])]),
      new El("main", "content", []),
    ]),
  ]);

  require("../../tools/browser-capture.js"); // attaches pxDomHtml to globalThis
  const root = build();
  global.document = { doctype: { name: "html", publicId: "", systemId: "" }, documentElement: root };
  const html = global.pxDomHtml();

  check("pxDomHtml strips the agent's glow border (+ inner) from the captured DOM",
    !/claude-agent-glow-border/.test(html));
  check("pxDomHtml strips the agent's phantom cursor and its <svg> children",
    !/claude-phantom-cursor/.test(html));
  check("pxDomHtml strips the agent's injected <style> of @keyframes",
    !/claude-agent-animation-styles/.test(html));
  check("…while the SITE's own content survives untouched (header + main)",
    /id="site-header"/.test(html) && /id="content"/.test(html));
  check("the LIVE page is never mutated — the strip happens on a clone",
    root.all.some((e) => e.id === "claude-agent-glow-border"));
  check("the doctype is still emitted (#18 — capture the doctype or its absence)",
    /^<!DOCTYPE html>/.test(html));
}

// ── 3. THE BEHAVIOR CAPTURE — the agent's nodes are not the site's behaviors ─────────
{
  const closestOf = (el) => (sel) => {
    if (!/claude-agent-|claude-phantom-/.test(sel)) return null;
    let e = el;
    while (e) { if (/^claude-(agent|phantom)-/.test(e.id || "")) return e; e = e.parent; }
    return null;
  };
  const mk = (id, parent) => { const e = { id, nodeType: 1, parent: parent || null }; e.closest = closestOf(e); return e; };

  const cap = require("../../tools/behavior-capture.js");
  check("behavior-capture exports isAgentDom (the capture half is testable without a browser)",
    typeof cap.isAgentDom === "function");
  if (typeof cap.isAgentDom === "function") {
    const glow = mk("claude-agent-glow-border");
    const inner = mk("claude-agent-glow-border-inner", glow);
    const cursor = mk("claude-phantom-cursor");
    const siteEl = mk("hero");
    check("the glow border is recognised as AGENT dom (never a site behavior)", cap.isAgentDom(glow));
    check("a CHILD of the agent's overlay is agent dom too (the pulse lives on the inner div)", cap.isAgentDom(inner));
    check("the phantom cursor is agent dom", cap.isAgentDom(cursor));
    check("CONTROL: the site's own element is NOT agent dom", !cap.isAgentDom(siteEl));
    // 5) THE FALSE-POSITIVE HUNTER — the rule is keyed on the ID NAMESPACE, so a site that ships
    //    a class (or an id that merely CONTAINS "claude") is untouched. Over-fitting here would
    //    silently delete a real site's content from every clone.
    const siteClaude = mk("claude-monet-hero"); // a jewelry line named for the painter, say
    check("CONTROL: a site element whose id merely CONTAINS 'claude' is NOT stripped (namespace, not substring)",
      !cap.isAgentDom(siteClaude));
  }
}

// ── 4. THE ARTIFACT — clone-lint refuses a clone that ships the agent's overlay ──────
{
  const { lintHtml } = require("../../tools/clone-lint.js");
  const wrap = (body) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

  const dirty = lintHtml(wrap(`<header>real</header><div id="claude-agent-glow-border"><div id="claude-agent-glow-border-inner"></div></div><div id="claude-phantom-cursor"></div>`));
  const agentRule = dirty.rules.find((r) => r.id === "agent-dom");
  check("clone-lint FAILs a clone containing the agent's injected overlay", !!agentRule && agentRule.level === "FAIL" && dirty.ok === false);
  check("…and names every injected node it found", !!agentRule && agentRule.hits.length === 3);

  const clean = lintHtml(wrap(`<header>real</header><main id="content">jewelry</main>`));
  check("CONTROL: a clean clone raises no agent-dom rule", !clean.rules.some((r) => r.id === "agent-dom"));

  const siteClaude = lintHtml(wrap(`<div id="claude-monet-collection">necklaces</div><p class="claude">x</p>`));
  check("CONTROL: a site's own 'claude-*' id/class is not mistaken for the agent's overlay",
    !siteClaude.rules.some((r) => r.id === "agent-dom"));
}

console.log(bad ? `\n❌ 29-agent-dom-contamination: ${bad} check(s) failed.` : "\n✓ 29-agent-dom-contamination: the automation's own overlay DOM is excluded from the capture, from behavior discovery, and refused in the shipped clone — and a site's own 'claude-*' names are untouched.");
process.exit(bad ? 1 : 0);
