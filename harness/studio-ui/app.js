// studio-ui/app.js — the studio page: a READ-ONLY viewer over the local cache API
// (/api/rounds, /api/round/<id>, /media/...). No route here writes anything: verdicts
// come from the independent reviewer on the service, findings from the agent-written
// annotations.json — this page only renders both. All feedback text is untrusted input
// and reaches the DOM via textContent only.
(() => {
  "use strict";

  const rail = document.getElementById("rail");
  const view = document.getElementById("view");
  const roundCache = new Map();
  let rounds = [];
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
  const fmtMs = (ms) => {
    const s = Math.max(0, Math.round(Number(ms) / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  const parseScore = (answer) => {
    const m = /^\s*([+-]?\d+)/.exec(String(answer == null ? "" : answer));
    return m ? Number(m[1]) : null;
  };
  const fmtWhen = (iso) => { try { return new Date(iso).toLocaleString(); } catch (e) { return iso || ""; } };

  async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) { const err = new Error(`HTTP ${res.status}`); err.status = res.status; throw err; }
    return res.json();
  }

  async function loadRound(id) {
    if (!roundCache.has(id)) roundCache.set(id, await getJson(`/api/round/${id}`));
    return roundCache.get(id);
  }

  // ── router: #/round/<id>[/findings|/sessions|/session/<i>] ─────────────────
  function parseHash() {
    const m = /^#\/round\/([0-9a-f-]{36})(?:\/(findings|sessions|session\/(\d+)))?$/i.exec(location.hash);
    if (!m) return { page: "home" };
    if (m[3] != null) return { page: "round", id: m[1].toLowerCase(), tab: "session", session: Number(m[3]) };
    return { page: "round", id: m[1].toLowerCase(), tab: m[2] || "overview" };
  }

  async function route() {
    const r = parseHash();
    renderRail(r.page === "round" ? r.id : null);
    if (r.page === "home") return renderHome();
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
  function renderRail(activeId) {
    const brand = el("div", "brand", "pingfusi studio");
    brand.appendChild(el("small", null, "results viewer — sessions, transcripts, findings"));
    const groups = new Map();
    for (const r of rounds) {
      if (!groups.has(r.kind)) groups.set(r.kind, []);
      groups.get(r.kind).push(r);
    }
    const parts = [brand];
    for (const [kind, list] of groups) {
      const g = el("div", "group");
      g.appendChild(el("div", "group-title", `${kind} (${list.length})`));
      for (const r of list) {
        const a = link(`#/round/${r.ping_id}`, "round" + (r.ping_id === activeId ? " active" : ""));
        a.appendChild(el("span", "label", r.label || r.ping_id));
        const meta = el("span", "meta");
        meta.appendChild(el("span", `chip status-${r.status}`, r.status));
        meta.appendChild(el("span", "dim small", `${r.n_received}/${r.n_target == null ? "?" : r.n_target}`));
        if (r.has_media) meta.appendChild(el("span", "dim small", "media"));
        if (r.has_transcript) meta.appendChild(el("span", "dim small", "transcript"));
        a.appendChild(meta);
        g.appendChild(a);
      }
      parts.push(g);
    }
    if (!rounds.length) {
      const empty = el("div", "empty");
      empty.appendChild(document.createTextNode("Nothing cached yet. Fetch a round: "));
      empty.appendChild(el("code", null, "pingfusi studio <ping_id>"));
      parts.push(empty);
    }
    rail.replaceChildren(...parts);
  }

  // ── home ───────────────────────────────────────────────────────────────────
  function renderHome() {
    const intro = el("div", "card");
    intro.appendChild(el("p", null, "Pick a round from the rail to see its sessions: what each human playtester said, their recording and think-aloud transcript when the round produced one, the questionnaire answers, and the findings your agent pinned to the footage."));
    const p2 = el("p", "dim small");
    p2.appendChild(document.createTextNode("This page is a read-only viewer. Fetch or refresh a round from the terminal: "));
    p2.appendChild(el("code", null, "pingfusi studio <ping_id>"));
    intro.appendChild(p2);
    view.replaceChildren(el("h1", null, "pingfusi studio"), intro);
  }

  // ── round page ─────────────────────────────────────────────────────────────
  function renderRound(id, data, tab, sessionIdx) {
    if (data.receipt) return renderReceipt(id, data);
    const rec = data.result || {};
    const header = el("div");
    const h1 = el("h1", null, `${rec.kind || "review"} round`);
    header.appendChild(h1);
    const meta = el("p", "dim small");
    meta.appendChild(el("span", "chip kind", rec.kind || "review"));
    meta.appendChild(document.createTextNode(" "));
    meta.appendChild(el("span", `chip status-${rec.status}`, rec.status));
    meta.appendChild(document.createTextNode(` ${rec.n_received}/${rec.n_target == null ? "?" : rec.n_target} result(s) · fetched ${fmtWhen(rec.fetched_at)} · `));
    meta.appendChild(el("code", null, id));
    header.appendChild(meta);
    const links = el("p", "small");
    if (rec.report_url) { links.appendChild(extLink(rec.report_url, "hosted report ↗")); links.appendChild(document.createTextNode("  ")); }
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
    const header = el("div");
    header.appendChild(el("h1", null, data.label || id));
    const meta = el("p", "dim small");
    meta.appendChild(el("span", "chip kind", data.source));
    meta.appendChild(document.createTextNode(" local receipt — recorded by a kit workflow; shown as-is"));
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

    // verdict tally
    const tally = new Map();
    for (const r of responses) tally.set(r.choice || "(no verdict)", (tally.get(r.choice || "(no verdict)") || 0) + 1);
    const verdicts = el("div", "card");
    verdicts.appendChild(el("h2", null, "Verdicts"));
    for (const [v, n] of tally) {
      const row = el("div");
      row.appendChild(el("span", "chip verdict", v));
      row.appendChild(el("span", "dim small", `  ×${n}`));
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
        tr.appendChild(el("td", "num mean", mean == null ? "—" : (mean > 0 ? "+" : "") + mean.toFixed(1)));
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

  // ── findings tab (agent-written annotations.json, rendered read-only) ──────
  function renderFindings(id, data, root) {
    const ann = data.annotations;
    const nSessions = (data.result.responses || []).length;
    if (!ann || !Array.isArray(ann.findings) || !ann.findings.length) {
      const card = el("div", "card");
      card.appendChild(el("p", null, "No agent findings yet for this round."));
      const p = el("p", "dim small");
      p.appendChild(document.createTextNode("Ask your agent to analyze the sessions — it writes its observations to "));
      p.appendChild(el("code", null, `.pingfusi/studio/${id}/annotations.json`));
      p.appendChild(document.createTextNode(" and the studio renders them here. The studio itself never generates findings."));
      card.appendChild(p);
      root.appendChild(card);
      return;
    }
    if (ann.summary) {
      const s = el("div", "card");
      s.appendChild(el("h2", null, "Summary"));
      s.appendChild(el("p", null, ann.summary));
      root.appendChild(s);
    }
    for (const f of ann.findings) {
      const card = el("div", "card finding");
      const head = el("div", "head");
      head.appendChild(el("span", "title", f.title || "(untitled finding)"));
      const sentiment = f.sentiment === "positive" ? "pos" : f.sentiment === "negative" ? "neg" : "neu";
      if (f.sentiment) head.appendChild(el("span", `chip ${sentiment}`, f.sentiment));
      for (const t of f.tags || []) head.appendChild(el("span", "tag", `#${t}`));
      card.appendChild(head);
      if (f.body) card.appendChild(el("div", "body", f.body));
      const evidence = Array.isArray(f.evidence) ? f.evidence : [];
      const distinct = new Set(evidence.map((e) => e.response_index).filter((n) => n != null));
      if (distinct.size && nSessions) card.appendChild(el("div", "dim small", `Reported by ${distinct.size}/${nSessions} session(s)`));
      if (evidence.length) {
        const chips = el("div", "evidence");
        for (const e of evidence) {
          const n = Number(e.response_index) || 0;
          const label = e.time_ms != null ? `S${n + 1} · ${fmtMs(e.time_ms)}` : e.step_index != null ? `S${n + 1} · Q${e.step_index}` : `S${n + 1}`;
          const chip = el("span", "chip time", label);
          if (e.quote) chip.title = `“${e.quote}”`;
          chip.addEventListener("click", () => {
            pendingSeek = e.time_ms != null ? { time_ms: Number(e.time_ms) } : null;
            location.hash = `#/round/${id}/session/${n}`;
          });
          chips.appendChild(chip);
        }
        card.appendChild(chips);
      }
      root.appendChild(card);
    }
  }

  // ── sessions tab ───────────────────────────────────────────────────────────
  function renderSessions(id, rec, root) {
    const responses = rec.responses || [];
    if (!responses.length) { root.appendChild(el("p", "dim", "No sessions yet.")); return; }
    responses.forEach((r, i) => {
      const card = el("div", "card");
      card.style.cursor = "pointer";
      const head = el("div");
      head.appendChild(el("strong", null, `Session ${i + 1}  `));
      if (r.choice) head.appendChild(el("span", "chip verdict", r.choice));
      head.appendChild(el("span", "dim small", `  ${fmtWhen(r.answered_at)}`));
      card.appendChild(head);
      if (r.free_text) card.appendChild(el("p", "dim", r.free_text.length > 160 ? `${r.free_text.slice(0, 160)}…` : r.free_text));
      const badges = el("div", "dim small");
      if (r.media && r.media.file) badges.appendChild(el("span", "chip", "recording"));
      if (r.media && r.media.unavailable) badges.appendChild(el("span", "chip", `media: ${r.media.unavailable}`));
      if (r.transcript) badges.appendChild(el("span", "chip", "transcript"));
      if (badges.childNodes.length) card.appendChild(badges);
      card.addEventListener("click", () => { location.hash = `#/round/${id}/session/${i}`; });
      root.appendChild(card);
    });
  }

  // ── one session: recording + pins, transcript rail, answers, comments ──────
  function renderSession(id, data, i, root) {
    const rec = data.result;
    const r = (rec.responses || [])[i];
    if (!r) { root.appendChild(el("p", "dim", "No such session.")); return; }

    const head = el("div", "card");
    const line = el("div");
    line.appendChild(el("strong", null, `Session ${i + 1}  `));
    if (r.choice) line.appendChild(el("span", "chip verdict", r.choice));
    line.appendChild(el("span", "dim small", `  ${fmtWhen(r.answered_at)}`));
    head.appendChild(line);
    if (r.free_text) {
      head.appendChild(el("div", "dim small", "Reviewer note"));
      head.appendChild(el("p", null, r.free_text));
    }
    root.appendChild(head);

    const grid = el("div", "session-grid");
    const left = el("div");
    const right = el("div");
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
        if (c && c.video_anchor && c.video_anchor.time_ms != null) pins.push({ t: Number(c.video_anchor.time_ms), cls: "pin comment", label: c.text || "comment" });
      }
      const ann = data.annotations;
      for (const f of (ann && ann.findings) || []) {
        for (const e of f.evidence || []) {
          if (Number(e.response_index) === i && e.time_ms != null) pins.push({ t: Number(e.time_ms), cls: "pin", label: f.title || "finding" });
        }
      }
      video.addEventListener("loadedmetadata", () => {
        const total = video.duration * 1000;
        if (total > 0) for (const p of pins) {
          const dot = el("span", p.cls);
          dot.style.left = `${Math.min(100, Math.max(0, (p.t / total) * 100))}%`;
          dot.title = `${fmtMs(p.t)} — ${p.label}`;
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
          li.appendChild(document.createTextNode("  "));
          li.appendChild(el("span", "chip", s.answer));
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
          const chip = el("span", "chip time", fmtMs(c.video_anchor.time_ms));
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
        const row = el("div", "seg");
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

  // ── boot ───────────────────────────────────────────────────────────────────
  window.addEventListener("hashchange", route);
  (async () => {
    try {
      rounds = (await getJson("/api/rounds")).rounds || [];
    } catch (e) {
      rounds = [];
    }
    route();
  })();
})();
