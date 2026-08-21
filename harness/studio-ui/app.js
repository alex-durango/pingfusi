// studio-ui/app.js — the studio page: a READ-ONLY viewer over the local cache API
// (/api/rounds, /api/round/<id>, /api/runs, /api/run/<id>, /media/...). No route here
// writes anything: verdicts come from the independent reviewer on the service, findings
// from the agent-written annotations.json — this page only renders both. Machine (rig)
// runs are a separate axis — written locally by the rig harness, listed grouped by gym,
// and always labeled "machine run" so they never read as a human session. All feedback
// text is untrusted input and reaches the DOM via textContent only.
(() => {
  "use strict";

  const rail = document.getElementById("rail");
  const view = document.getElementById("view");
  const roundCache = new Map();
  const runCache = new Map();
  let rounds = [];
  let runs = []; // machine-run summaries in time order; gym groups derive from gym_id
  // A findings evidence chip can jump into a session AND seek — the seek survives the
  // hash-driven re-render here until the target video's metadata arrives.
  let pendingSeek = null;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const frag = (...kids) => { const f = document.createDocumentFragment(); for (const k of kids) if (k) f.appendChild(k); return f; };
  const link = (href, cls, text) => { const a = el("a", cls, text); a.href = href; return a; };
  const extLink = (href, text) => { const a = link(href, null, text); a.target = "_blank"; a.rel = "noopener"; return a; };
  // Everything clickable is a real button or link; rows that must stay divs (transcript
  // segments carry their own layout) get the same keyboard affordance explicitly.
  const btn = (cls, text) => { const b = el("button", cls, text); b.type = "button"; return b; };
  const keyable = (node) => {
    node.tabIndex = 0;
    node.setAttribute("role", "button");
    node.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); node.click(); } });
    return node;
  };
  const fmtMs = (ms) => {
    const s = Math.max(0, Math.round(Number(ms) / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  // A clip anchor (time_ms + end_ms) labels as a span; an instant as one stamp.
  const fmtSpan = (t, end) => (end != null && Number(end) > Number(t) ? `${fmtMs(t)}–${fmtMs(end)}` : fmtMs(t));
  const parseScore = (answer) => {
    const m = /^\s*([+-]?\d+)/.exec(String(answer == null ? "" : answer));
    return m ? Number(m[1]) : null;
  };
  const fmtWhen = (iso) => {
    try {
      const when = new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      return when === "Invalid Date" ? iso || "" : when;
    } catch (e) { return iso || ""; }
  };

  async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) { const err = new Error(`HTTP ${res.status}`); err.status = res.status; throw err; }
    return res.json();
  }

  async function loadRound(id) {
    if (!roundCache.has(id)) roundCache.set(id, await getJson(`/api/round/${id}`));
    return roundCache.get(id);
  }

  async function loadRun(id) {
    if (!runCache.has(id)) runCache.set(id, await getJson(`/api/run/${id}`));
    return runCache.get(id);
  }

  // ── router: #/round/<id>[/findings|/sessions|/session/<i>], #/run/<id>, #/gym/<id>
  function parseHash() {
    let m = /^#\/round\/([0-9a-f-]{36})(?:\/(findings|sessions|session\/(\d+)))?$/i.exec(location.hash);
    if (m) {
      if (m[3] != null) return { page: "round", id: m[1].toLowerCase(), tab: "session", session: Number(m[3]) };
      return { page: "round", id: m[1].toLowerCase(), tab: m[2] || "overview" };
    }
    m = /^#\/run\/([a-z0-9][a-z0-9-]{7,63})$/.exec(location.hash);
    if (m) return { page: "run", id: m[1] };
    m = /^#\/gym\/([^/]+)$/.exec(location.hash);
    if (m) { try { return { page: "gym", gym: decodeURIComponent(m[1]) }; } catch (e) {} }
    return { page: "home" };
  }

  async function route() {
    const r = parseHash();
    renderRail(r.page === "round" ? { round: r.id } : r.page === "run" ? { run: r.id } : r.page === "gym" ? { gym: r.gym } : null);
    if (r.page === "home") return renderHome();
    if (r.page === "gym") return renderGym(r.gym);
    if (r.page === "run") {
      try {
        renderRun(r.id, await loadRun(r.id));
      } catch (e) {
        view.replaceChildren(el("h1", null, "run not available"), el("p", "dim", e.status === 404
          ? "This machine run is not in the cache — the rig writes runs under .pingfusi/studio/runs/<run_id>/."
          : `Could not load the run (${e.message}).`));
      }
      return;
    }
    try {
      const data = await loadRound(r.id);
      renderRound(r.id, data, r.tab, r.session);
    } catch (e) {
      view.replaceChildren(el("h1", null, "round not available"), el("p", "dim", e.status === 404
        ? "This round is not cached yet — fetch it first: pingfusi studio <ping_id>"
        : `Could not load the round (${e.message}).`));
    }
  }

  // ── rail ───────────────────────────────────────────────────────────────────
  function renderRail(active) {
    const brand = el("div", "brand");
    brand.appendChild(el("span", "mark"));
    const brandText = el("div");
    brandText.appendChild(el("div", "brand-name", "pingfusi studio"));
    brandText.appendChild(el("small", null, "results viewer"));
    brand.appendChild(brandText);
    const groups = new Map();
    for (const r of rounds) {
      if (!groups.has(r.kind)) groups.set(r.kind, []);
      groups.get(r.kind).push(r);
    }
    const parts = [brand];
    for (const [kind, list] of groups) {
      const g = el("div", "group");
      g.appendChild(el("div", "group-title", `${kind} · ${list.length}`));
      for (const r of list) {
        const a = link(`#/round/${r.ping_id}`, "round" + (active && active.round === r.ping_id ? " active" : ""));
        a.appendChild(el("span", "label", r.label || r.ping_id));
        const meta = el("span", "meta");
        meta.appendChild(el("span", `dot s-${r.status}`));
        meta.appendChild(el("span", "count", `${r.n_received}/${r.n_target == null ? "?" : r.n_target}`));
        if (r.has_media) meta.appendChild(el("span", null, "media"));
        if (r.has_transcript) meta.appendChild(el("span", null, "transcript"));
        a.appendChild(meta);
        g.appendChild(a);
      }
      parts.push(g);
    }
    // Gym runs: the machine (rig) axis, grouped by gym — never mixed into the human
    // review groups above, and every row says "machine".
    const byGym = new Map();
    for (const r of runs) {
      const key = r.gym_id || "";
      if (!byGym.has(key)) byGym.set(key, []);
      byGym.get(key).push(r);
    }
    for (const [gymId, list] of byGym) {
      const g = el("div", "group");
      if (gymId) {
        g.appendChild(link(`#/gym/${encodeURIComponent(gymId)}`, "group-title gym" + (active && active.gym === gymId ? " active" : ""), `gym · ${gymId} · ${list.length}`));
      } else {
        g.appendChild(el("div", "group-title", `ad-hoc runs · ${list.length}`));
      }
      for (const r of [...list].reverse()) { // rail reads newest first; the gym view keeps time order
        const a = link(`#/run/${r.run_id}`, "round" + (active && active.run === r.run_id ? " active" : ""));
        a.appendChild(el("span", "label", r.build_label || r.run_id));
        const meta = el("span", "meta");
        meta.appendChild(el("span", `dot s-${r.result || "unknown"}`));
        if (r.mode) meta.appendChild(el("span", null, r.mode));
        meta.appendChild(el("span", "machine-tag", "machine"));
        if (r.has_media) meta.appendChild(el("span", null, "media"));
        a.appendChild(meta);
        g.appendChild(a);
      }
      parts.push(g);
    }
    if (!rounds.length && !runs.length) {
      const empty = el("div", "empty");
      empty.appendChild(document.createTextNode("Nothing cached yet. Fetch a round: "));
      empty.appendChild(el("code", null, "pingfusi studio <ping_id>"));
      parts.push(empty);
    }
    rail.replaceChildren(...parts);
  }

  // ── home ───────────────────────────────────────────────────────────────────
  function renderHome() {
    const lede = el("p", "lede", "Watch what each human reviewer did with your build — the recording, the think-aloud transcript, the questionnaire answers, and the findings your agent pinned to the footage, side by side.");
    const how = el("div", "card");
    how.appendChild(el("h2", null, "How it works"));
    const steps = el("ol", "steps");
    const step = (...kids) => { const li = el("li"); li.appendChild(frag(...kids)); steps.appendChild(li); };
    step(document.createTextNode("Fetch a round's results into the local cache: "), el("code", null, "pingfusi studio <ping_id>"), document.createTextNode(" — media bytes are downloaded next to the JSON, so old rounds replay after the signed links lapse."));
    step(document.createTextNode("Pick the round in the rail to browse its sessions, transcripts, and answers."));
    step(document.createTextNode("Ask your agent to analyze the sessions — its findings land in the Findings tab, each anchored to the exact moment in the footage."));
    how.appendChild(steps);
    const note = el("p", "dim small");
    note.appendChild(document.createTextNode("This page is a read-only viewer: verdicts come from the independent human reviewer on the service, findings from your agent. Refresh a round from the terminal with the same command."));
    how.appendChild(note);
    const parts = [el("h1", null, "pingfusi studio"), lede, how];
    if (runs.length) {
      const mr = el("div", "card");
      mr.appendChild(el("h2", null, "Machine runs"));
      const p = el("p", "dim small");
      p.appendChild(document.createTextNode("The rig's gamepad playtest runs live in the rail under their gyms — per-gym pass/fail with causes and performance across builds, plus each run's recording and events. A machine run is written locally into "));
      p.appendChild(el("code", null, ".pingfusi/studio/runs/"));
      p.appendChild(document.createTextNode(" and is a separate artifact family from human review rounds — always labeled as such."));
      mr.appendChild(p);
      parts.push(mr);
    }
    view.replaceChildren(...parts);
  }

  // ── round page ─────────────────────────────────────────────────────────────
  function renderRound(id, data, tab, sessionIdx) {
    if (data.receipt) return renderReceipt(id, data);
    const rec = data.result || {};
    const header = el("header", "page-head");
    header.appendChild(el("h1", null, `${rec.kind || "review"} round`));
    const meta = el("div", "meta");
    meta.appendChild(el("span", "chip kind", rec.kind || "review"));
    meta.appendChild(el("span", `chip status-${rec.status}`, rec.status));
    meta.appendChild(el("span", null, `${rec.n_received}/${rec.n_target == null ? "?" : rec.n_target} result(s)`));
    meta.appendChild(el("span", null, `fetched ${fmtWhen(rec.fetched_at)}`));
    meta.appendChild(el("code", null, id));
    header.appendChild(meta);
    const links = el("div", "links");
    if (rec.report_url) links.appendChild(extLink(rec.report_url, "hosted report ↗"));
    if (rec.poll_url) links.appendChild(extLink(rec.poll_url, "round page ↗"));
    if (links.childNodes.length) header.appendChild(links);

    const tabs = el("div", "tabs");
    const tabLink = (t, label, href) => {
      const a = link(href, tab === t ? "active" : null, label);
      tabs.appendChild(a);
    };
    const findingCount = data.annotations && Array.isArray(data.annotations.findings) ? data.annotations.findings.length : 0;
    tabLink("overview", "Overview", `#/round/${id}`);
    tabLink("findings", `Findings${findingCount ? ` (${findingCount})` : ""}`, `#/round/${id}/findings`);
    tabLink("sessions", `Sessions (${(rec.responses || []).length})`, `#/round/${id}/sessions`);
    tabLink("session", tab === "session" ? `Session ${sessionIdx + 1}` : "", tab === "session" ? `#/round/${id}/session/${sessionIdx}` : "#");
    if (tab !== "session") tabs.lastChild.remove();

    const body = el("div");
    if (tab === "overview") renderOverview(id, data, body);
    else if (tab === "findings") renderFindings(id, data, body);
    else if (tab === "sessions") renderSessions(id, rec, body);
    else if (tab === "session") renderSession(id, data, sessionIdx, body);
    view.replaceChildren(header, tabs, body);
  }

  function renderReceipt(id, data) {
    const header = el("header", "page-head");
    header.appendChild(el("h1", null, data.label || id));
    const meta = el("div", "meta");
    meta.appendChild(el("span", "chip kind", data.source));
    meta.appendChild(el("span", null, "local receipt — recorded by a kit workflow; shown as-is"));
    header.appendChild(meta);
    const pre = el("pre", "card small");
    pre.style.overflowX = "auto";
    pre.textContent = JSON.stringify(data.receipt, null, 2);
    view.replaceChildren(header, pre);
  }

  // ── overview tab ───────────────────────────────────────────────────────────
  function renderOverview(id, data, root) {
    const rec = data.result;
    const responses = rec.responses || [];
    if (rec.status !== "complete") {
      const b = el("div", "card banner");
      b.appendChild(el("div", null, rec.status === "pending" ? "This round is still in flight — snapshot below." : `Round ${rec.status}.`));
      const p = el("div", "dim small");
      p.appendChild(document.createTextNode("Refresh from the terminal: "));
      p.appendChild(el("code", null, `pingfusi studio ${id}`));
      b.appendChild(p);
      root.appendChild(b);
    }
    if (!responses.length) { root.appendChild(el("p", "dim", "No results yet.")); return; }

    // verdict tally, largest first, with a proportion meter per verdict
    const tally = new Map();
    for (const r of responses) tally.set(r.choice || "(no verdict)", (tally.get(r.choice || "(no verdict)") || 0) + 1);
    const verdicts = el("div", "card");
    verdicts.appendChild(el("h2", null, "Verdicts"));
    for (const [v, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
      const row = el("div", "verdict-row");
      row.appendChild(el("span", "chip verdict", v));
      const meter = el("span", "meter");
      const fill = el("span");
      fill.style.width = `${Math.round((n / responses.length) * 100)}%`;
      meter.appendChild(fill);
      row.appendChild(meter);
      row.appendChild(el("span", "count", String(n)));
      verdicts.appendChild(row);
    }
    root.appendChild(verdicts);

    // questionnaire matrix from steps_result — item text rides in the results, so the
    // page needs no canonical questionnaire list.
    const maxSteps = Math.max(0, ...responses.map((r) => (r.steps_result || []).length));
    if (!maxSteps) return;
    const isPlaytest = rec.kind === "playtest";
    const rows = [];
    for (let i = 0; i < maxSteps; i++) {
      const first = responses.find((r) => r.steps_result && r.steps_result[i]);
      if (!first) continue;
      rows.push({ index: i, text: first.steps_result[i].text, answers: responses.map((r) => (r.steps_result && r.steps_result[i] ? r.steps_result[i].answer : null)) });
    }
    const directive = isPlaytest ? rows.shift() : null;
    const numericRows = rows.filter((row) => row.answers.some((a) => parseScore(a) != null));
    const textRows = rows.filter((row) => !row.answers.some((a) => parseScore(a) != null));

    if (numericRows.length) {
      const card = el("div", "card");
      card.appendChild(el("h2", null, isPlaytest ? "Player experience questionnaire" : "Scored answers"));
      if (directive) card.appendChild(el("p", "dim small", directive.text));
      const table = el("table", "qmatrix");
      const thead = el("tr");
      thead.appendChild(el("th", null, "statement"));
      thead.appendChild(el("th", null, `sessions (${responses.length})`));
      thead.appendChild(el("th", null, "mean"));
      table.appendChild(thead);
      for (const row of numericRows) {
        const tr = el("tr");
        tr.appendChild(el("td", null, row.text));
        const cell = el("td", "num");
        const scores = [];
        row.answers.forEach((a, i) => {
          const s = parseScore(a);
          const chip = el("span", `score ${s == null ? "zero" : s > 0 ? "pos" : s < 0 ? "neg" : "zero"}`, s == null ? "—" : (s > 0 ? `+${s}` : String(s)));
          chip.title = `session ${i + 1}${a ? `: ${a}` : ""}`;
          cell.appendChild(chip);
          if (s != null) scores.push(s);
        });
        tr.appendChild(cell);
        const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
        const sign = mean == null || mean === 0 ? "zero" : mean > 0 ? "pos" : "neg";
        tr.appendChild(el("td", `num mean ${sign}`, mean == null ? "—" : (mean > 0 ? "+" : "") + mean.toFixed(1)));
        table.appendChild(tr);
      }
      card.appendChild(table);
      root.appendChild(card);
    }
    if (textRows.length) {
      const card = el("div", "card");
      card.appendChild(el("h2", null, isPlaytest ? "Agent questions" : "Free-text answers"));
      for (const row of textRows) {
        card.appendChild(el("p", null, row.text));
        const ul = el("ul", "plain");
        row.answers.forEach((a, i) => {
          const li = el("li");
          li.appendChild(el("span", "dim small", `S${i + 1}  `));
          li.appendChild(document.createTextNode(a || "—"));
          ul.appendChild(li);
        });
        card.appendChild(ul);
      }
      root.appendChild(card);
    }
  }

  // ── findings (agent-written annotations.json, rendered read-only) ──────────
  // One renderer for rounds AND machine runs — the card shape is shared; only the
  // evidence chips differ (a round jumps into a session, a run seeks its own video).
  function renderFindingCards(ann, root, opts) {
    if (!ann || !Array.isArray(ann.findings) || !ann.findings.length) { root.appendChild(opts.empty()); return; }
    if (ann.summary) {
      const s = el("div", "card");
      s.appendChild(el("h2", null, "Summary"));
      s.appendChild(el("p", null, ann.summary));
      root.appendChild(s);
    }
    for (const f of ann.findings) {
      const sentiment = f.sentiment === "positive" ? "pos" : f.sentiment === "negative" ? "neg" : "neu";
      const card = el("div", `card finding s-${sentiment}`);
      const head = el("div", "head");
      head.appendChild(el("span", "title", f.title || "(untitled finding)"));
      if (f.sentiment) head.appendChild(el("span", `chip ${sentiment}`, f.sentiment));
      for (const t of f.tags || []) head.appendChild(el("span", "tag", `#${t}`));
      card.appendChild(head);
      if (f.body) card.appendChild(el("div", "body", f.body));
      const evidence = Array.isArray(f.evidence) ? f.evidence : [];
      const coverage = opts.coverage ? opts.coverage(evidence) : null;
      if (coverage) card.appendChild(el("div", "dim small coverage", coverage));
      if (evidence.length) {
        const chips = el("div", "evidence");
        for (const e of evidence) {
          const chip = btn("chip time", opts.chipLabel(e));
          if (e.quote) chip.title = `“${e.quote}”`;
          chip.addEventListener("click", () => opts.onChip(e));
          chips.appendChild(chip);
        }
        card.appendChild(chips);
      }
      root.appendChild(card);
    }
  }

  function renderFindings(id, data, root) {
    const nSessions = (data.result.responses || []).length;
    renderFindingCards(data.annotations, root, {
      empty: () => {
        const card = el("div", "card");
        card.appendChild(el("p", null, "No agent findings yet for this round."));
        const p = el("p", "dim small");
        p.appendChild(document.createTextNode("Ask your agent to analyze the sessions — it writes its observations to "));
        p.appendChild(el("code", null, `.pingfusi/studio/${id}/annotations.json`));
        p.appendChild(document.createTextNode(" (contract and guidance: "));
        p.appendChild(el("code", null, "docs/STUDIO.md"));
        p.appendChild(document.createTextNode(" in the kit install) and the studio renders them here. The studio itself never generates findings."));
        card.appendChild(p);
        return card;
      },
      coverage: (evidence) => {
        const distinct = new Set(evidence.map((e) => e.response_index).filter((n) => n != null));
        return distinct.size && nSessions ? `Reported by ${distinct.size}/${nSessions} session(s)` : null;
      },
      chipLabel: (e) => {
        const n = Number(e.response_index) || 0;
        return e.time_ms != null ? `S${n + 1} · ${fmtSpan(e.time_ms, e.end_ms)}` : e.step_index != null ? `S${n + 1} · Q${e.step_index}` : `S${n + 1}`;
      },
      onChip: (e) => {
        pendingSeek = e.time_ms != null ? { time_ms: Number(e.time_ms) } : null;
        location.hash = `#/round/${id}/session/${Number(e.response_index) || 0}`;
      },
    });
  }

  // ── sessions tab ───────────────────────────────────────────────────────────
  function renderSessions(id, rec, root) {
    const responses = rec.responses || [];
    if (!responses.length) { root.appendChild(el("p", "dim", "No sessions yet.")); return; }
    responses.forEach((r, i) => {
      const card = link(`#/round/${id}/session/${i}`, "card session");
      const head = el("div", "session-head");
      head.appendChild(el("strong", null, `Session ${i + 1}`));
      if (r.choice) head.appendChild(el("span", "chip verdict", r.choice));
      head.appendChild(el("span", "when", fmtWhen(r.answered_at)));
      card.appendChild(head);
      if (r.free_text) card.appendChild(el("p", "session-note", r.free_text.length > 160 ? `${r.free_text.slice(0, 160)}…` : r.free_text));
      const badges = el("div", "session-badges");
      if (r.media && r.media.file) badges.appendChild(el("span", "chip", "recording"));
      if (r.media && r.media.unavailable) badges.appendChild(el("span", "chip", `media: ${r.media.unavailable}`));
      if (r.transcript) badges.appendChild(el("span", "chip", "transcript"));
      if (badges.childNodes.length) card.appendChild(badges);
      root.appendChild(card);
    });
  }

  // ── one session: recording + pins, transcript rail, answers, comments ──────
  function renderSession(id, data, i, root) {
    const rec = data.result;
    const r = (rec.responses || [])[i];
    if (!r) { root.appendChild(el("p", "dim", "No such session.")); return; }

    const head = el("div", "card");
    const line = el("div", "session-head");
    line.appendChild(el("strong", null, `Session ${i + 1}`));
    if (r.choice) line.appendChild(el("span", "chip verdict", r.choice));
    line.appendChild(el("span", "when", fmtWhen(r.answered_at)));
    head.appendChild(line);
    if (r.free_text) {
      head.appendChild(el("h2", null, "Reviewer note"));
      head.appendChild(el("p", "session-note", r.free_text));
    }
    root.appendChild(head);

    const grid = el("div", "session-grid");
    const left = el("div");
    const right = el("div", "side");
    grid.appendChild(left);
    grid.appendChild(right);
    root.appendChild(grid);

    // recording + timeline pins
    let video = null;
    if (r.media && r.media.file) {
      video = document.createElement("video");
      video.controls = true;
      video.preload = "metadata";
      video.src = `/media/${id}/${encodeURIComponent(r.media.file.replace(/^media\//, ""))}`;
      left.appendChild(video);
      const timeline = el("div", "timeline");
      left.appendChild(timeline);
      const pins = [];
      for (const c of rec.comments || []) {
        if (c && c.video_anchor && c.video_anchor.time_ms != null) pins.push({ t: Number(c.video_anchor.time_ms), end: null, cls: "pin comment", label: c.text || "comment" });
      }
      const ann = data.annotations;
      for (const f of (ann && ann.findings) || []) {
        for (const e of f.evidence || []) {
          if (Number(e.response_index) === i && e.time_ms != null) pins.push({ t: Number(e.time_ms), end: e.end_ms != null ? Number(e.end_ms) : null, cls: "pin", label: f.title || "finding" });
        }
      }
      video.addEventListener("loadedmetadata", () => {
        const total = video.duration * 1000;
        const pct = (ms) => `${Math.min(100, Math.max(0, (ms / total) * 100))}%`;
        // Clip spans render first so the dots sit on top of them.
        if (total > 0) for (const p of pins) {
          if (!(p.end > p.t)) continue;
          const span = btn("pin-range");
          span.style.left = pct(p.t);
          span.style.width = pct(Math.min(p.end, total) - p.t);
          span.title = `${fmtSpan(p.t, p.end)} — ${p.label}`;
          span.setAttribute("aria-label", `${fmtSpan(p.t, p.end)} — ${p.label}`);
          span.addEventListener("click", () => { video.currentTime = p.t / 1000; video.play(); });
          timeline.appendChild(span);
        }
        if (total > 0) for (const p of pins) {
          const dot = btn(p.cls);
          dot.style.left = pct(p.t);
          dot.title = `${fmtSpan(p.t, p.end)} — ${p.label}`;
          dot.setAttribute("aria-label", `${fmtSpan(p.t, p.end)} — ${p.label}`);
          dot.addEventListener("click", () => { video.currentTime = p.t / 1000; video.play(); });
          timeline.appendChild(dot);
        }
        if (pendingSeek && pendingSeek.time_ms != null) { video.currentTime = pendingSeek.time_ms / 1000; pendingSeek = null; }
      });
    } else {
      const card = el("div", "card");
      const reason = r.media && r.media.unavailable;
      card.appendChild(el("p", null, reason === "skipped"
        ? "Media download was skipped for this round (--no-media)."
        : reason
          ? "The recording is no longer available — signed links lapse and recordings are retention-swept."
          : "No recording for this session."));
      if (reason) {
        const p = el("p", "dim small");
        p.appendChild(document.createTextNode(reason === "skipped" ? "Fetch it: " : "A refetch re-signs while the file still exists: "));
        p.appendChild(el("code", null, `pingfusi studio ${id}`));
        card.appendChild(p);
        if (r.transcript) card.appendChild(el("p", "dim small", "The transcript below is kept either way."));
      }
      left.appendChild(card);
    }

    // this session's answers
    const steps = r.steps_result || [];
    if (steps.length) {
      const card = el("div", "card");
      card.appendChild(el("h2", null, "Answers"));
      const ul = el("ul", "plain");
      for (const s of steps) {
        const li = el("li");
        li.appendChild(document.createTextNode(s.text || ""));
        if (s.answer != null && s.answer !== "") {
          const score = parseScore(s.answer);
          li.appendChild(document.createTextNode("  "));
          li.appendChild(el("span", `chip${score == null ? "" : score > 0 ? " pos" : score < 0 ? " neg" : ""}`, s.answer));
        }
        ul.appendChild(li);
      }
      card.appendChild(ul);
      left.appendChild(card);
    }

    // reviewer comments (round-level; time-anchored ones seek)
    const comments = rec.comments || [];
    if (comments.length) {
      const card = el("div", "card");
      card.appendChild(el("h2", null, "Reviewer comments"));
      const ul = el("ul", "plain");
      for (const c of comments) {
        const li = el("li");
        if (c.video_anchor && c.video_anchor.time_ms != null) {
          const chip = btn("chip time", fmtMs(c.video_anchor.time_ms));
          chip.addEventListener("click", () => { if (video) { video.currentTime = c.video_anchor.time_ms / 1000; video.play(); } });
          li.appendChild(chip);
          li.appendChild(document.createTextNode("  "));
        }
        if (c.step_index != null) { li.appendChild(el("span", "dim small", `Q${c.step_index}  `)); }
        li.appendChild(document.createTextNode(c.text || ""));
        ul.appendChild(li);
      }
      card.appendChild(ul);
      left.appendChild(card);
    }

    // Key moments: this session's insight rail — the agent's evidence anchors and the
    // reviewer's anchored comments merged in timeline order, each row a seek. Transcript
    // markers stay inline in the transcript below; this rail is analysis, not raw signal.
    const moments = [];
    const anns = data.annotations;
    for (const f of (anns && anns.findings) || []) {
      const cls = f.sentiment === "positive" ? "s-pos" : f.sentiment === "negative" ? "s-neg" : "s-neu";
      for (const e of f.evidence || []) {
        if (Number(e.response_index) !== i || e.time_ms == null) continue;
        moments.push({ t: Number(e.time_ms), end: e.end_ms != null ? Number(e.end_ms) : null, cls, tag: (f.tags || [])[0] || null, text: e.quote ? `“${e.quote}”` : (f.title || "finding"), title: f.title || "finding" });
      }
    }
    for (const c of rec.comments || []) {
      if (c && c.video_anchor && c.video_anchor.time_ms != null) moments.push({ t: Number(c.video_anchor.time_ms), end: null, cls: "comment", tag: "reviewer", text: c.text || "comment", title: "reviewer comment" });
    }
    moments.sort((a, b) => a.t - b.t);
    if (moments.length) {
      const card = el("div", "card");
      card.appendChild(el("h2", null, "Key moments"));
      const rail_ = el("div", "moments");
      for (const m of moments) {
        const row = btn(`moment ${m.cls}`);
        const line = el("span", "head-row");
        line.appendChild(el("span", "time", fmtSpan(m.t, m.end)));
        if (m.tag) line.appendChild(el("span", "tag", `#${m.tag}`));
        row.appendChild(line);
        row.appendChild(el("span", "text", m.text));
        row.title = m.title;
        row.addEventListener("click", () => { if (video) { video.currentTime = m.t / 1000; video.play(); } });
        rail_.appendChild(row);
      }
      card.appendChild(rail_);
      right.appendChild(card);
    }

    // transcript rail
    const t = r.transcript;
    if (t && Array.isArray(t.segments) && t.segments.length) {
      const card = el("div", "card");
      card.appendChild(el("h2", null, "Think-aloud transcript"));
      if (t.transcript_status && t.transcript_status !== "ok") {
        card.appendChild(el("p", "dim small", t.transcript_status === "locale_unsupported"
          ? "Transcription was unavailable for this session's language."
          : "Transcription failed for this session — the recording is unaffected."));
      }
      const box = el("div", "transcript");
      const entries = [
        ...t.segments.map((s) => ({ t: Number(s.t_ms) || 0, end: Number(s.end_ms) || 0, text: s.text, seg: true })),
        ...(t.markers || []).map((m) => ({ t: Number(m.t_ms) || 0, text: m.label, seg: false })),
      ].sort((a, b) => a.t - b.t);
      const segEls = [];
      for (const entry of entries) {
        if (!entry.seg) { box.appendChild(el("div", "marker", `⚑ ${fmtMs(entry.t)} ${entry.text || ""}`)); continue; }
        const row = keyable(el("div", "seg"));
        row.appendChild(el("span", "t", fmtMs(entry.t)));
        row.appendChild(el("span", null, entry.text || ""));
        row.addEventListener("click", () => { if (video) { video.currentTime = entry.t / 1000; video.play(); } });
        box.appendChild(row);
        segEls.push({ el: row, from: entry.t, to: entry.end });
      }
      card.appendChild(box);
      right.appendChild(card);
      if (video) {
        video.addEventListener("timeupdate", () => {
          const now = video.currentTime * 1000;
          for (const s of segEls) {
            const active = now >= s.from && (s.to ? now < s.to : false);
            if (active !== s.el.classList.contains("active")) {
              s.el.classList.toggle("active", active);
              if (active) s.el.scrollIntoView({ block: "nearest" });
            }
          }
        });
      }
    } else if (rec.kind === "playtest") {
      right.appendChild(el("p", "dim small", "No transcript for this session."));
    }
  }

  // ── machine runs: shared SVG helpers (zero-dep, CSS-variable themed) ────────
  const svgNode = (tag, attrs, text) => {
    const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  };

  // The gym chart: avg fps across runs in time order (x labeled by build), with the
  // 1%-low series as a faint dashed polyline when any run recorded one.
  function fpsChart(entries) {
    const W = 640, H = 220, padL = 44, padR = 30, padT = 12, padB = 34; // padR fits the last x label
    const svg = svgNode("svg", { viewBox: `0 0 ${W} ${H}`, class: "fps-chart", role: "img", "aria-label": "average fps across builds" });
    const values = [];
    for (const e of entries) { values.push(e.avg_fps); if (e.one_percent_low_fps != null) values.push(e.one_percent_low_fps); }
    const top = Math.max(20, Math.ceil(Math.max(...values) / 20) * 20);
    const x = (i) => (entries.length === 1 ? padL + (W - padL - padR) / 2 : padL + (i * (W - padL - padR)) / (entries.length - 1));
    const y = (v) => padT + (1 - v / top) * (H - padT - padB);
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      svg.appendChild(svgNode("line", { x1: padL, x2: W - padR, y1: y(top * f), y2: y(top * f), class: "grid" }));
      svg.appendChild(svgNode("text", { x: padL - 6, y: y(top * f) + 3, "text-anchor": "end", class: "axis" }, String(Math.round(top * f))));
    }
    const points = (get) => entries.map((e, i) => (get(e) == null ? null : `${x(i)},${y(get(e))}`)).filter(Boolean).join(" ");
    if (entries.some((e) => e.one_percent_low_fps != null)) svg.appendChild(svgNode("polyline", { points: points((e) => e.one_percent_low_fps), class: "line low" }));
    svg.appendChild(svgNode("polyline", { points: points((e) => e.avg_fps), class: "line avg" }));
    entries.forEach((e, i) => {
      const c = svgNode("circle", { cx: x(i), cy: y(e.avg_fps), r: 3.5, class: `pt ${e.result === "fail" ? "fail" : e.result === "error" ? "error" : "pass"}` });
      c.appendChild(svgNode("title", {}, `${e.build_label || e.run_id} — ${e.avg_fps} fps${e.one_percent_low_fps != null ? ` (1% low ${e.one_percent_low_fps})` : ""}${e.result ? ` — ${e.result}` : ""}`));
      svg.appendChild(c);
    });
    const every = Math.ceil(entries.length / 8);
    entries.forEach((e, i) => {
      if (i % every) return;
      const label = String(e.build_label || e.run_id);
      svg.appendChild(svgNode("text", { x: x(i), y: H - padB + 16, "text-anchor": "middle", class: "axis" }, label.length > 12 ? `${label.slice(0, 11)}…` : label));
    });
    return svg;
  }

  // The run sparkline: performance.summary.series_1s, one fps sample per second.
  function fpsSparkline(series) {
    const vals = series.map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0));
    const W = 600, H = 64, pad = 4;
    const top = Math.max(1, ...vals);
    const x = (i) => (vals.length === 1 ? W / 2 : pad + (i * (W - 2 * pad)) / (vals.length - 1));
    const y = (v) => pad + (1 - v / top) * (H - 2 * pad);
    const svg = svgNode("svg", { viewBox: `0 0 ${W} ${H}`, class: "fps-spark", preserveAspectRatio: "none", role: "img", "aria-label": "fps per second over the run" });
    svg.appendChild(svgNode("line", { x1: pad, x2: W - pad, y1: H - pad, y2: H - pad, class: "base" }));
    svg.appendChild(svgNode("polyline", { points: vals.map((v, i) => `${x(i)},${y(v)}`).join(" ") }));
    return svg;
  }

  const resultChipClass = (result) => (result === "pass" ? "pos" : result === "fail" ? "neg" : "neu");
  const fmtFps = (v) => (v == null ? "—" : Number(v).toFixed(1));

  // ── gym view: pass/fail with causes + performance over time across builds ──
  function renderGym(gymId) {
    const list = runs.filter((r) => r.gym_id === gymId);
    if (!list.length) {
      view.replaceChildren(el("h1", null, "gym not found"), el("p", "dim", "No machine runs recorded for this gym yet — the rig writes them under .pingfusi/studio/runs/<run_id>/."));
      return;
    }
    const latest = list[list.length - 1];
    const header = el("header", "page-head");
    header.appendChild(el("h1", null, `gym · ${gymId}`));
    const meta = el("div", "meta");
    meta.appendChild(el("span", "chip machine", "machine runs"));
    if (latest.gym_version) meta.appendChild(el("span", "chip", `v${latest.gym_version}`));
    const passes = list.filter((r) => r.result === "pass").length;
    const fails = list.filter((r) => r.result === "fail").length;
    const errors = list.filter((r) => r.result === "error").length;
    meta.appendChild(el("span", null, `${list.length} run(s)`));
    if (passes) meta.appendChild(el("span", "chip pos", `${passes} pass`));
    if (fails) meta.appendChild(el("span", "chip neg", `${fails} fail`));
    if (errors) meta.appendChild(el("span", "chip neu", `${errors} error`));
    header.appendChild(meta);

    const body = el("div");
    const perf = list.filter((r) => r.avg_fps != null);
    const chart = el("div", "card");
    chart.appendChild(el("h2", null, "Performance across builds"));
    if (perf.length) {
      chart.appendChild(fpsChart(perf));
      const legend = el("div", "chart-legend");
      legend.appendChild(el("span", "key", "avg fps"));
      if (perf.some((r) => r.one_percent_low_fps != null)) legend.appendChild(el("span", "key low", "1% low"));
      chart.appendChild(legend);
    } else {
      chart.appendChild(el("p", "dim small", "No performance summaries recorded for this gym yet."));
    }
    body.appendChild(chart);

    const card = el("div", "card");
    card.appendChild(el("h2", null, "Runs in time order"));
    const table = el("table", "qmatrix");
    const thead = el("tr");
    for (const h of ["build", "mode", "result", "avg fps", "1% low", "when"]) thead.appendChild(el("th", null, h));
    table.appendChild(thead);
    for (const r of list) {
      const tr = el("tr");
      const tdBuild = el("td");
      tdBuild.appendChild(link(`#/run/${r.run_id}`, null, r.build_label || r.run_id));
      tr.appendChild(tdBuild);
      const tdMode = el("td");
      if (r.mode) tdMode.appendChild(el("span", "chip", r.mode));
      tr.appendChild(tdMode);
      const tdResult = el("td");
      tdResult.appendChild(el("span", `chip ${resultChipClass(r.result)}`, r.result || "?"));
      if (r.failure_message) tdResult.appendChild(el("span", "dim small fail-note", ` ${r.failure_kind ? `${r.failure_kind}: ` : ""}${r.failure_message}`));
      tr.appendChild(tdResult);
      tr.appendChild(el("td", "num", fmtFps(r.avg_fps)));
      tr.appendChild(el("td", "num", fmtFps(r.one_percent_low_fps)));
      tr.appendChild(el("td", "num dim small", fmtWhen(r.at)));
      table.appendChild(tr);
    }
    card.appendChild(table);
    body.appendChild(card);
    view.replaceChildren(header, body);
  }

  // ── run view: one machine run — verdict, perf, events, recording, findings ─
  function renderRun(id, data) {
    const rec = data.receipt || {};
    const summary = runs.find((r) => r.run_id === id) || null;
    const build = rec.build && typeof rec.build === "object" ? rec.build : {};
    const perf = (rec.performance && rec.performance.summary) || {};
    const failure = rec.failure_cause && typeof rec.failure_cause === "object" ? rec.failure_cause : null;
    const result = rec.result || (rec.ok === true ? "pass" : rec.ok === false ? "fail" : null);

    let video = null;
    const seek = (ms) => { if (video && ms != null) { video.currentTime = Number(ms) / 1000; video.play(); } };

    const header = el("header", "page-head");
    header.appendChild(el("h1", null, "machine run"));
    const meta = el("div", "meta");
    meta.appendChild(el("span", "chip machine", "machine run"));
    if (result) meta.appendChild(el("span", `chip ${resultChipClass(result)}`, result));
    if (rec.mode) meta.appendChild(el("span", "chip", rec.mode));
    const buildLabel = build.label || build.filename || (summary && summary.build_label) || null;
    if (buildLabel) meta.appendChild(el("span", "chip verdict", buildLabel));
    if (rec.duration_ms != null) meta.appendChild(el("span", null, `ran ${fmtMs(rec.duration_ms)}`));
    if (rec.at) meta.appendChild(el("span", null, fmtWhen(rec.at)));
    meta.appendChild(el("code", null, id));
    header.appendChild(meta);
    if (rec.gym && rec.gym.id) {
      const links = el("div", "links");
      links.appendChild(link(`#/gym/${encodeURIComponent(String(rec.gym.id))}`, null, `gym · ${rec.gym.id} ›`));
      header.appendChild(links);
    }

    const body = el("div");
    if (failure) {
      const b = el("div", "card banner neg");
      const line = el("div", "session-head");
      line.appendChild(el("span", "chip neg", failure.kind || "failure"));
      if (failure.at_ms != null) {
        const chip = btn("chip time", fmtMs(failure.at_ms));
        chip.addEventListener("click", () => seek(failure.at_ms));
        line.appendChild(chip);
      }
      b.appendChild(line);
      if (failure.message) b.appendChild(el("p", "session-note", failure.message));
      body.appendChild(b);
    }

    const grid = el("div", "session-grid");
    const left = el("div");
    const right = el("div", "side");
    grid.appendChild(left);
    grid.appendChild(right);
    body.appendChild(grid);

    // recording — served from the run's own media dir; event rows and screenshot
    // chips seek it (the transcript-seek pattern).
    const rel = rec.media && typeof rec.media.recording === "string" ? /^(media|shots)\/([A-Za-z0-9._-]+)$/.exec(rec.media.recording) : null;
    if (rel && (!summary || summary.has_media)) {
      video = document.createElement("video");
      video.controls = true;
      video.preload = "metadata";
      video.src = `/media/run/${id}/${rel[1]}/${encodeURIComponent(rel[2])}`;
      left.appendChild(video);
    } else {
      left.appendChild(el("p", "dim small", "No recording captured for this run."));
    }

    // screenshots strip — each chip seeks the recording to its moment
    const shots = rec.media && Array.isArray(rec.media.screenshots) ? rec.media.screenshots : [];
    const shotEls = [];
    for (const s of shots) {
      const m = s && typeof s.file === "string" ? /^(media|shots)\/([A-Za-z0-9._-]+)$/.exec(s.file) : null;
      if (!m) continue;
      const chip = btn("shot");
      const img = document.createElement("img");
      img.src = `/media/run/${id}/${m[1]}/${encodeURIComponent(m[2])}`;
      img.alt = s.why || "screenshot";
      img.loading = "lazy";
      chip.appendChild(img);
      chip.appendChild(el("span", "cap", `${s.t_ms != null ? fmtMs(s.t_ms) : ""}${s.why ? ` · ${s.why}` : ""}`));
      chip.addEventListener("click", () => seek(s.t_ms));
      shotEls.push(chip);
    }
    if (shotEls.length) {
      const card = el("div", "card");
      card.appendChild(el("h2", null, "Screenshots"));
      const strip = el("div", "shots");
      for (const c of shotEls) strip.appendChild(c);
      card.appendChild(strip);
      left.appendChild(card);
    }

    // findings — same renderer as rounds; evidence chips seek the run's own video
    renderFindingCards(data.annotations, left, {
      empty: () => {
        const card = el("div", "card");
        card.appendChild(el("p", null, "No findings for this machine run yet."));
        const p = el("p", "dim small");
        p.appendChild(document.createTextNode("The rig's report step (or your agent) writes them to "));
        p.appendChild(el("code", null, `.pingfusi/studio/runs/${id}/annotations.json`));
        p.appendChild(document.createTextNode(" — same contract as review rounds: "));
        p.appendChild(el("code", null, "docs/STUDIO.md"));
        p.appendChild(document.createTextNode("."));
        card.appendChild(p);
        return card;
      },
      coverage: null,
      chipLabel: (e) => (e.time_ms != null ? fmtSpan(e.time_ms, e.end_ms) : "evidence"),
      onChip: (e) => seek(e.time_ms),
    });

    // performance: headline numbers + the per-second fps sparkline
    const series = Array.isArray(perf.series_1s) ? perf.series_1s : [];
    if (series.length || perf.avg_fps != null) {
      const card = el("div", "card");
      card.appendChild(el("h2", null, "Performance"));
      const stats = el("div", "perf-stats");
      const stat = (label, value) => { const s = el("span"); s.appendChild(el("b", null, value)); s.appendChild(document.createTextNode(` ${label}`)); stats.appendChild(s); };
      if (perf.avg_fps != null) stat("avg fps", fmtFps(perf.avg_fps));
      if (perf.one_percent_low_fps != null) stat("1% low", fmtFps(perf.one_percent_low_fps));
      if (perf.p95_ms != null) stat("p95 ms", String(perf.p95_ms));
      if (perf.p99_ms != null) stat("p99 ms", String(perf.p99_ms));
      if (Array.isArray(perf.stutters) && perf.stutters.length) stat("stutter(s)", String(perf.stutters.length));
      if (Array.isArray(perf.load_stalls) && perf.load_stalls.length) stat("load stall(s)", String(perf.load_stalls.length));
      card.appendChild(stats);
      if (series.length) card.appendChild(fpsSparkline(series));
      right.appendChild(card);
    }

    // events timeline — every row seeks the recording
    const events = Array.isArray(rec.events) ? rec.events : [];
    if (events.length) {
      const card = el("div", "card");
      card.appendChild(el("h2", null, "Events"));
      const rail_ = el("div", "moments");
      for (const ev of [...events].sort((a, b) => (Number(a && a.t_ms) || 0) - (Number(b && b.t_ms) || 0))) {
        if (!ev) continue;
        const bad = ev.kind === "crash" || ev.kind === "hang" || ev.kind === "stuck";
        const row = btn(`moment ${bad ? "s-neg" : "s-neu"}`);
        const line = el("span", "head-row");
        line.appendChild(el("span", "time", fmtMs(ev.t_ms)));
        if (ev.kind) line.appendChild(el("span", "tag", `#${ev.kind}`));
        row.appendChild(line);
        row.appendChild(el("span", "text", ev.detail || ev.kind || "event"));
        row.addEventListener("click", () => seek(ev.t_ms));
        rail_.appendChild(row);
      }
      card.appendChild(rail_);
      right.appendChild(card);
    }

    // warnings — the rig's receipts-and-warnings doctrine, shown as-is
    const warnings = Array.isArray(rec.warnings) ? rec.warnings : [];
    if (warnings.length) {
      const card = el("div", "card");
      card.appendChild(el("h2", null, "Warnings"));
      const ul = el("ul", "plain");
      for (const w of warnings) ul.appendChild(el("li", "warn-item", String(w)));
      card.appendChild(ul);
      right.appendChild(card);
    }

    view.replaceChildren(header, body);
  }

  // ── boot ───────────────────────────────────────────────────────────────────
  window.addEventListener("hashchange", route);
  (async () => {
    try {
      rounds = (await getJson("/api/rounds")).rounds || [];
    } catch (e) {
      rounds = [];
    }
    try {
      runs = (await getJson("/api/runs")).runs || [];
    } catch (e) {
      runs = [];
    }
    route();
  })();
})();
