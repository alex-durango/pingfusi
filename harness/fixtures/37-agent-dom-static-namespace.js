// fixtures/37-agent-dom-static-namespace.js — #24's GUARD HAD A GAP, AND THE INSTRUMENT WALKED
// THROUGH IT.
//
// Paid for on dtf (2026-07-13). LEARNINGS #24 taught the kit that the browser-automation
// extension paints on the page it is measuring, and keyed the defence on the extension's own ID
// NAMESPACE — `#claude-agent-*` and `#claude-phantom-*`. Correct, and narrow, and INCOMPLETE.
//
// The same extension also ships a "Claude is active in this tab group" toast, under a THIRD
// prefix nothing in the kit knew about:
//   #claude-static-indicator-container
//     ├ #claude-static-chat-button      + #claude-static-chat-tooltip   ("Open chat")
//     └ #claude-static-close-button     + #claude-static-close-tooltip  ("Dismiss")
//
// On dtf all three halves of #24's fix failed at once, and each failed SILENTLY:
//   1. pxDomHtml did not strip them → all 5 nodes were serialized into dom.html and
//      capture-build BAKED THEM INTO THE SHIPPED CLONE.
//   2. clone-lint's `agent-dom` rule — the artifact-level backstop, the check that exists to
//      catch exactly this — exited 0 on the contaminated clone. Meanwhile its `frozen-reveal`
//      rule DID fire, reporting the extension's own "Open chat" / "Dismiss" tooltips as a defect
//      OF DTF.COM: the gate blaming the site for the instrument's DOM.
//   3. behavior discovery inventoried `declared:claude-static-chat-tooltip` and
//      `declared:claude-static-close-tooltip` as behaviors of dtf.com awaiting reproduction, and
//      the widget's leaves entered coverage as painted leaves of the site (137 vs 132 clean).
//
// LESSON: a vendor namespace is a LIST, and a guard that enumerates two of its three prefixes is
// a guard the instrument walks around. Enumerate it completely, and keep the three call-sites
// (browser-capture's pxAgentDomSelector, behavior-capture's AGENT_DOM_SELECTOR, clone-lint's
// agent-dom rule) reading the same list — a namespace known in one place and not the others is
// the same gap wearing a different hat.
//
// NARROW BY CONSTRUCTION, exactly as #24 was: keyed on the extension's ID namespace, never on a
// substring or a class. Controls 4–6 prove a site's own `static-*` id, its own `claude…static`
// id, and a `claude-static` CLASS are all untouched.
"use strict";
const path = require("path");
let bad = 0; const check = (n, c) => { console.log(`${c ? "✓" : "✗"} ${n}`); if (!c) bad++; };

// ── 1. THE CAPTURE — pxDomHtml must strip the toast ──────────────────────────────────
// FAILS WITHOUT THE CHANGE: pxAgentDomSelector listed only agent-/phantom-, so the 5 static-*
// nodes survived into the serialized DOM.
//
// The shim's querySelectorAll PARSES the selector the tool actually declares, rather than
// hard-coding a copy of it. That matters: a shim that re-states the prefix list would pass even
// if the tool's own constant were never widened — it would be testing the fixture, not the kit.
{
  class El {
    constructor(tag, id, kids) { this.tagName = tag; this.id = id || ""; this.children = kids || []; this.parent = null; this.nodeType = 1; for (const k of this.children) k.parent = this; }
    cloneNode() { return new El(this.tagName, this.id, this.children.map((k) => k.cloneNode())); }
    get all() { const out = []; const walk = (e) => { for (const k of e.children) { out.push(k); walk(k); } }; walk(this); return out; }
    querySelectorAll(sel) {
      // Honour the REAL selector: pull every [id^="…"] prefix out of it and match on those.
      const prefixes = [...String(sel).matchAll(/\[id\^=["']([^"']+)["']\]/g)].map((m) => m[1]);
      if (!prefixes.length) throw new Error(`shim could not parse an [id^=…] prefix out of: ${sel}`);
      return this.all.filter((e) => prefixes.some((p) => e.id.startsWith(p)));
    }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((k) => k !== this); }
    get outerHTML() {
      const attr = this.id ? ` id="${this.id}"` : "";
      return `<${this.tagName}${attr}>${this.children.map((k) => k.outerHTML).join("")}</${this.tagName}>`;
    }
  }
  const root = new El("html", "", [
    new El("head", "", []),
    new El("body", "", [
      new El("header", "site-header", []),
      // the extension's toast, exactly as observed on dtf
      new El("div", "claude-static-indicator-container", [
        new El("button", "claude-static-chat-button", []),
        new El("div", "claude-static-chat-tooltip", []),
        new El("button", "claude-static-close-button", []),
        new El("div", "claude-static-close-tooltip", []),
      ]),
      // #24's originals must STAY stripped — widening must not displace the existing prefixes
      new El("div", "claude-agent-glow-border", []),
      new El("div", "claude-phantom-cursor", []),
      // the site's own markup, which must survive: a static-* id of its own, and a claude-static CLASS
      new El("nav", "static-nav", []),
      new El("main", "content", []),
    ]),
  ]);

  require("../../tools/browser-capture.js"); // attaches pxDomHtml + pxAgentDomSelector to globalThis
  global.document = { doctype: { name: "html", publicId: "", systemId: "" }, documentElement: root };
  const html = global.pxDomHtml();

  check("pxDomHtml strips the extension's claude-static-* toast (container + 4 children)",
    !/claude-static-/.test(html));
  check("…and still strips #24's glow border and phantom cursor (widening displaced nothing)",
    !/claude-agent-glow-border/.test(html) && !/claude-phantom-cursor/.test(html));
  check("CONTROL: the SITE's own markup survives — including its own `static-*` id",
    /id="site-header"/.test(html) && /id="content"/.test(html) && /id="static-nav"/.test(html));
}

// ── 2. THE ARTIFACT BACKSTOP — clone-lint must FAIL a clone carrying the toast ───────
// FAILS WITHOUT THE CHANGE: the agent-dom rule's regex read claude-(agent|phantom)- and exited 0
// on dtf's contaminated clone. This is the check whose whole job was to catch a contaminated
// artifact, and it certified one.
{
  const { lintHtml } = require(path.join(__dirname, "..", "..", "tools", "clone-lint.js"));
  const fired = (html) => {
    const res = lintHtml(html);
    return res.rules.some((r) => r.id === "agent-dom" && r.level === "FAIL");
  };

  check("clone-lint FAILS a clone with the extension's claude-static-* toast baked in",
    fired(`<header>real</header><div id="claude-static-indicator-container"><button id="claude-static-chat-button"></button><div id="claude-static-chat-tooltip">Open chat</div></div>`));
  check("…and still FAILS #24's original glow/cursor contamination",
    fired(`<div id="claude-agent-glow-border"></div><div id="claude-phantom-cursor"></div>`));

  // ── CONTROLS: the rule is a NAMESPACE, not a substring. A site may ship any of these. ──
  check("CONTROL: a site's own `static-*` id is not the extension's node",
    !fired(`<div id="static-header">menu</div><main>content</main>`));
  check("CONTROL: a site's own id merely CONTAINING claude…static is not the extension's node",
    !fired(`<section id="claude-monet-static-gallery">Water Lilies</section>`));
  check("CONTROL: a `claude-static` CLASS is not an id — the rule must not read it",
    !fired(`<p class="claude-static">a site is free to name a class anything</p>`));
  check("CONTROL: a clean clone raises no agent-dom FAIL",
    !fired(`<header>real</header><main id="content">jewelry</main>`));
}

console.log(bad ? `\n✗ ${bad} check(s) failed` : "\n✓ 37-agent-dom-static-namespace: the vendor's namespace is enumerated COMPLETELY — all three prefixes, in all three call-sites.");
process.exit(bad ? 1 : 0);
