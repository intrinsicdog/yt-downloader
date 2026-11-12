(() => {
  "use strict";

  const ID_RE = /(?:[?&]v=|\/shorts\/)([\w-]{11})/;
  const LINK_SEL = 'a[href*="/watch?v="], a[href*="/shorts/"]';
  const BOX_SEL =
    "ytd-video-renderer, yt-lockup-view-model, ytm-video-with-context-renderer, ytd-rich-item-renderer";

  const QUALITIES = {
    video: [["best", "Best available"], ["1080", "1080p"], ["720", "720p"], ["480", "480p"], ["360", "360p"]],
    mp3: [["320", "320 kbps"], ["192", "192 kbps"], ["128", "128 kbps"]],
    m4a: [["best", "Best (original)"]],
  };

  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)");

  const selected = new Map(); // videoId -> title
  let lastJobs = {}; // latest job snapshot from the helper: videoId -> {status, progress, error}
  let ui = null;
  let pollTimer = null;

  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    n.append(...kids);
    return n;
  }

  function send(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (r) => {
        void chrome.runtime.lastError;
        resolve(r || { ok: false, error: "No response from extension" });
      });
    });
  }

  // Restart a one-shot CSS animation class (and remove it when it finishes).
  function play(node, cls) {
    node.classList.remove(cls);
    void node.offsetWidth; // force reflow so the animation restarts
    node.classList.add(cls);
    node.addEventListener("animationend", () => node.classList.remove(cls), { once: true });
  }

  // ---------- Panel ----------
  function buildPanel() {
    const num = el("span", { class: "ythd-num", text: "0" });
    const count = el("span", { class: "ythd-count" }, num, " selected");
    const format = el("select", {},
      el("option", { value: "video", text: "Video (MP4)" }),
      el("option", { value: "mp3", text: "Audio (MP3)" }),
      el("option", { value: "m4a", text: "Audio (M4A)" }));
    const quality = el("select");
    const go = el("button", { class: "ythd-go", text: "Download", disabled: "" });
    const status = el("div", { class: "ythd-status" });
    const quick = buildQuick();

    const fill = el("div", { class: "ythd-fill" });
    const pct = el("span", { class: "ythd-pct", text: "0% overall" });
    const cancelAll = el("button", { class: "ythd-cancel-all", text: "Cancel all", hidden: "" });
    const overall = el("div", { class: "ythd-overall" },
      el("div", { class: "ythd-track" }, fill),
      el("div", { class: "ythd-overall-row" }, pct, cancelAll));

    const fillQuality = () => {
      quality.replaceChildren(
        ...QUALITIES[format.value].map(([v, t]) => el("option", { value: v, text: t }))
      );
    };
    format.addEventListener("change", fillQuality);
    fillQuality();

    const panel = el("div", { id: "ythd-panel", class: "ythd-hidden" },
      el("div", { class: "ythd-title", text: "History downloader" }),
      el("div", { class: "ythd-row" },
        el("button", { text: "Select all", onclick: () => selectAll(true) }),
        el("button", { text: "Clear", onclick: () => selectAll(false) }),
        count),
      el("div", { class: "ythd-row" }, el("label", { text: "Format " }, format)),
      el("div", { class: "ythd-row" }, el("label", { text: "Quality " }, quality)),
      quick.root,
      go,
      overall,
      status);
    document.body.appendChild(panel);
    void panel.offsetWidth; // commit the hidden state so tick() can animate the panel in

    go.addEventListener("click", startDownload);
    cancelAll.addEventListener("click", () => cancelIds(null));
    quick.run.addEventListener("click", runQuickSelect);
    quick.stop.addEventListener("click", stopQuickSelect);
    ui = { panel, num, format, quality, go, status, overall, fill, pct, cancelAll, quick };
  }

  function setStatus(text, isError = false) {
    ui.status.textContent = text;
    ui.status.classList.toggle("ythd-error", isError);
  }

  // "N selected" counter that ticks up/down instead of jumping.
  let shownCount = 0;
  let countRaf = 0;
  function setCount(n) {
    const from = shownCount;
    shownCount = n;
    cancelAnimationFrame(countRaf);
    if (REDUCED.matches || from === n) {
      ui.num.textContent = n;
      return;
    }
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 220);
      ui.num.textContent = Math.round(from + (n - from) * k);
      if (k < 1) countRaf = requestAnimationFrame(step);
    };
    countRaf = requestAnimationFrame(step);
  }

  function refreshCount() {
    setCount(selected.size);
    if (selected.size) {
      if (ui.go.hasAttribute("disabled")) play(ui.go, "ythd-pulse");
      ui.go.removeAttribute("disabled");
    } else {
      ui.go.setAttribute("disabled", "");
    }
  }

  // ---------- Checkboxes on video cards ----------
  function boxTitle(box) {
    const t = box.querySelector("#video-title, h3, [title]");
    return ((t && (t.getAttribute("title") || t.textContent)) || "video").trim().slice(0, 200);
  }

  function toggle(id, title, on) {
    if (on) selected.set(id, title);
    else selected.delete(id);
    refreshCount();
  }

  function selectAll(on) {
    document.querySelectorAll(".ythd-cb").forEach((cb) => {
      if (!cb.dataset.id) return;
      if (cb.checked !== on) play(cb, "ythd-pop");
      cb.checked = on;
      toggle(cb.dataset.id, boxTitle(cb.parentElement), on);
    });
    if (!on) selected.clear();
    refreshCount();
  }

  // ---------- Per-card status: badge, cancel button, progress bar ----------
  const isActive = (s) => s === "queued" || s === "downloading";

  function removeDecor(cb) {
    if (cb._badge) cb._badge.remove();
    if (cb._bar) cb._bar.remove();
    cb._badge = cb._bar = cb._text = cb._x = cb._fill = null;
  }

  function buildDecor(cb, instant) {
    const text = el("span", { class: "ythd-badge-text" });
    const x = el("button", {
      class: "ythd-x", title: "Cancel this download", text: "✕",
      onclick: (e) => {
        e.stopPropagation();
        e.preventDefault();
        cancelIds([cb.dataset.id]); // read the id at click time: YouTube recycles cards
      },
    });
    const badge = el("span", { class: "ythd-badge" }, text, x);
    cb.after(badge);
    if (!instant) play(badge, "ythd-enter");

    const fill = el("div", { class: "ythd-bar-fill" });
    const bar = el("div", { class: "ythd-bar" }, fill);
    cb.parentElement.appendChild(bar);

    cb._badge = badge; cb._text = text; cb._x = x; cb._bar = bar; cb._fill = fill;
  }

  // instant = true when a recycled card gets a different video's state (no animation).
  function renderCard(cb, job, instant = false) {
    if (!job) {
      cb._status = undefined;
      removeDecor(cb);
      return;
    }
    if (!cb._badge) buildDecor(cb, instant);
    const status = job.status;
    const changed = cb._status !== undefined && cb._status !== status;
    cb._status = status;

    const pct = status === "done" ? 100 : Math.round(job.progress || 0);
    cb._text.textContent =
      status === "done" ? "✓ done" :
      status === "error" ? "✗ failed" :
      status === "cancelled" ? "⊘ cancelled" :
      status === "queued" ? "… queued" : `⬇ ${pct}%`;
    cb._badge.title = job.error || "";
    cb._badge.dataset.state = status;
    cb._x.hidden = !isActive(status);
    cb._bar.dataset.state = status;

    if (instant) cb._bar.classList.add("ythd-notrans");
    cb._fill.style.transform = `scaleX(${status === "error" || status === "cancelled" ? 0 : pct / 100})`;
    if (instant) {
      void cb._bar.offsetWidth;
      cb._bar.classList.remove("ythd-notrans");
    }
    if (changed) play(cb._badge, "ythd-flip");
  }

  function renderAllCards() {
    document.querySelectorAll(".ythd-cb").forEach((cb) => {
      if (cb.dataset.id) renderCard(cb, lastJobs[cb.dataset.id]);
    });
  }

  function scan() {
    document.querySelectorAll(LINK_SEL).forEach((a) => {
      const m = (a.getAttribute("href") || "").match(ID_RE);
      if (!m) return;
      const box = a.closest(BOX_SEL);
      if (!box) return;

      let cb = box._ythdCb;
      if (!cb) {
        cb = el("input", { type: "checkbox", class: "ythd-cb" });
        cb.addEventListener("click", (e) => e.stopPropagation());
        cb.addEventListener("change", () => {
          play(cb, "ythd-pop");
          toggle(cb.dataset.id, boxTitle(box), cb.checked);
        });
        box.style.position = "relative";
        box.appendChild(cb);
        box._ythdCb = cb;
      }
      // YouTube recycles elements while scrolling, so keep the id (and its status) in sync.
      if (cb.dataset.id !== m[1]) {
        cb.dataset.id = m[1];
        cb.checked = selected.has(m[1]);
        const job = lastJobs[m[1]];
        cb._status = job ? job.status : undefined;
        renderCard(cb, job, true);
      }
    });
  }

  // ---------- Download, cancel + progress ----------
  async function startDownload() {
    const payload = {
      format: ui.format.value,
      quality: ui.quality.value,
      items: [...selected].map(([id, title]) => ({ id, title })),
    };
    ui.go.setAttribute("disabled", "");
    const r = await send({ type: "download", payload });
    refreshCount();
    if (!r.ok) return setStatus(r.error, true);
    setStatus(`Queued ${r.data.queued} item(s)…`);
    startPolling();
  }

  // ids = array of video ids, or null to cancel everything that is queued or running.
  async function cancelIds(ids) {
    const r = await send({ type: "cancel", payload: ids ? { ids } : {} });
    if (!r.ok) return setStatus(r.error, true);
    poll(); // refresh right away instead of waiting for the next tick
  }

  function renderOverall(jobs) {
    const counted = Object.values(jobs).filter((j) => j.status !== "cancelled");
    const active = counted.filter((j) => isActive(j.status)).length;
    if (!counted.length) {
      ui.overall.classList.remove("ythd-open");
      return;
    }
    const sum = counted.reduce(
      (s, j) => s + (j.status === "done" || j.status === "error" ? 100 : j.progress || 0), 0);
    const pct = Math.round(sum / counted.length);
    ui.fill.style.transform = `scaleX(${pct / 100})`;
    ui.pct.textContent = `${pct}% overall`;
    ui.cancelAll.hidden = active === 0;
    ui.overall.classList.add("ythd-open");
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(poll, 1500);
    poll();
  }

  async function poll() {
    const r = await send({ type: "status" });
    if (!r.ok) {
      setStatus(r.error, true);
      clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    const jobs = r.data.jobs || {};
    lastJobs = jobs;
    let done = 0, active = 0, failed = 0, cancelled = 0;
    for (const j of Object.values(jobs)) {
      if (j.status === "done") done++;
      else if (j.status === "error") failed++;
      else if (j.status === "cancelled") cancelled++;
      else active++;
    }
    renderAllCards();
    renderOverall(jobs);
    setStatus(
      `${done} done · ${active} in progress · ${failed} failed` +
      (cancelled ? ` · ${cancelled} cancelled` : "") +
      `\nSaved to: ${r.data.outDir}`,
      failed > 0 && active === 0
    );
    if (active === 0) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ---------- Quick select: filters, ranges and "N most recent" ----------
  // Songs are detected with YouTube's own category ("Music"), fetched through the helper
  // (yt-dlp) and cached, because the history page itself doesn't say what a video is.
  const MAX_SCAN = 1000; // stop after checking this many videos
  const BATCH = 12;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const metaById = new Map(); // videoId -> {categories, duration, ...} or {error}
  let quickState = null;

  function buildQuick() {
    const type = el("select", {},
      el("option", { value: "any", text: "Any video" }),
      el("option", { value: "song", text: "Songs (Music)" }),
      el("option", { value: "other", text: "Not songs" }));
    const field = (ph, val = "") => el("input", {
      type: "number", min: "0", step: "1", placeholder: ph, value: String(val), class: "ythd-num-in",
    });
    const minLen = field("min");
    const maxLen = field("max");
    const from = field("1", 1);
    const to = field("30", 30);
    const run = el("button", { class: "ythd-run", text: "Select" });
    const stop = el("button", { class: "ythd-stop", text: "Stop", hidden: "" });
    const status = el("div", { class: "ythd-fstatus" });
    const root = el("details", { class: "ythd-quick" },
      el("summary", { text: "Quick select" }),
      el("div", { class: "ythd-hint", text: "Songs, 1–30 = your 30 most recent songs. Numbers count matching videos only." }),
      el("div", { class: "ythd-row" }, el("label", { text: "Type " }, type)),
      el("div", { class: "ythd-row" },
        el("label", { text: "Length (min) " }, el("span", { class: "ythd-pair" }, minLen, "–", maxLen))),
      el("div", { class: "ythd-row" },
        el("label", { text: "Videos # ", title: "Position among matching videos; 1 = most recent" },
          el("span", { class: "ythd-pair" }, from, "–", to))),
      el("div", { class: "ythd-row" }, run, stop),
      status);
    return { root, type, minLen, maxLen, from, to, run, stop, status };
  }

  function readFilter() {
    const q = ui.quick;
    const num = (inp) => {
      const v = parseFloat(inp.value);
      return Number.isFinite(v) && v >= 0 ? v : null;
    };
    const from = Math.max(1, Math.floor(num(q.from) || 1));
    const to = Math.max(from, Math.floor(num(q.to) || 30));
    return { type: q.type.value, minLen: num(q.minLen), maxLen: num(q.maxLen), from, to };
  }

  function matches(m, f) {
    if (!m || m.error) return false;
    const isSong = (m.categories || []).includes("Music");
    if (f.type === "song" && !isSong) return false;
    if (f.type === "other" && isSong) return false;
    if (f.minLen != null || f.maxLen != null) {
      if (typeof m.duration !== "number") return false;
      if (f.minLen != null && m.duration < f.minLen * 60) return false;
      if (f.maxLen != null && m.duration > f.maxLen * 60) return false;
    }
    return true;
  }

  function setQuickStatus(text, isError = false) {
    ui.quick.status.textContent = text;
    ui.quick.status.classList.toggle("ythd-error", isError);
  }

  function setQuickBusy(busy) {
    const q = ui.quick;
    q.run.hidden = busy;
    q.stop.hidden = !busy;
    [q.type, q.minLen, q.maxLen, q.from, q.to].forEach((n) => { n.disabled = busy; });
  }

  // Append newly seen videos (history order = newest first) to state.ids.
  function collectIds(state) {
    let added = 0;
    document.querySelectorAll(LINK_SEL).forEach((a) => {
      const m = (a.getAttribute("href") || "").match(ID_RE);
      if (!m || state.seen.has(m[1])) return;
      const box = a.closest(BOX_SEL);
      if (!box) return;
      state.seen.add(m[1]);
      state.ids.push(m[1]);
      state.titles.set(m[1], boxTitle(box));
      added++;
    });
    return added;
  }

  // YouTube loads more history as you scroll. Returns false at the end of the history.
  async function loadMore(state) {
    for (let attempt = 0; attempt < 2 && !state.abort; attempt++) {
      if (attempt) window.scrollBy(0, -600); // nudge, in case the loader didn't trigger
      window.scrollTo(0, document.documentElement.scrollHeight);
      for (let i = 0; i < 10 && !state.abort; i++) {
        await sleep(300);
        if (collectIds(state) > 0) return true;
      }
    }
    return false;
  }

  async function resolveMeta(ids, state) {
    let todo = ids.filter((id) => !metaById.has(id));
    while (todo.length && !state.abort) {
      const r = await send({ type: "inspect", payload: { ids: todo } });
      if (!r.ok) throw new Error(r.error);
      for (const [id, m] of Object.entries(r.data.results || {})) metaById.set(id, m);
      todo = todo.filter((id) => !metaById.has(id));
      if (todo.length) await sleep(700);
    }
  }

  function applySelection(ids, titles) {
    selected.clear();
    for (const id of ids) selected.set(id, titles.get(id) || "video");
    document.querySelectorAll(".ythd-cb").forEach((cb) => {
      const on = selected.has(cb.dataset.id);
      if (cb.checked !== on) {
        cb.checked = on;
        play(cb, "ythd-pop");
      }
    });
    refreshCount();
  }

  async function runQuickSelect() {
    if (quickState) return;
    const f = readFilter();
    const state = { abort: false, seen: new Set(), ids: [], titles: new Map() };
    quickState = state;
    setQuickBusy(true);
    for (const [id, m] of [...metaById]) if (m.error) metaById.delete(id); // retry earlier failures

    const needMeta = f.type !== "any" || f.minLen != null || f.maxLen != null;
    const noun = f.type === "song" ? "song" : f.type === "other" ? "non-song video" : "video";
    const matched = [];
    let evaluated = 0, unknown = 0, ended = false;
    try {
      while (!state.abort && matched.length < f.to && evaluated < MAX_SCAN) {
        collectIds(state);
        if (evaluated >= state.ids.length) {
          setQuickStatus(`Loading more history… ${state.ids.length} videos so far`);
          if (!(await loadMore(state))) {
            ended = !state.abort;
            break;
          }
          continue;
        }
        const batch = state.ids.slice(evaluated, evaluated + BATCH);
        if (needMeta) {
          setQuickStatus(`Checking videos ${evaluated + 1}–${evaluated + batch.length}… ${matched.length} found`);
          await resolveMeta(batch, state);
          if (state.abort) break;
        } else {
          setQuickStatus(`Counting… ${state.ids.length} videos loaded`);
        }
        for (const id of batch) {
          if (matched.length >= f.to) break;
          evaluated++;
          const m = metaById.get(id);
          if (needMeta && m && m.error) unknown++;
          if (!needMeta || matches(m, f)) matched.push(id);
        }
      }
      if (state.abort) {
        setQuickStatus("Stopped. Your selection was not changed.");
        return;
      }
      const picked = matched.slice(f.from - 1, f.to);
      const wanted = f.to - f.from + 1;
      if (picked.length) {
        applySelection(picked, state.titles);
        window.scrollTo(0, 0);
      }
      const tail = unknown ? ` (${unknown} couldn't be checked)` : "";
      if (!picked.length) {
        setQuickStatus(`No matching ${noun}s found in ${evaluated} videos checked${tail}.`);
      } else if (picked.length < wanted) {
        const why = ended ? "reached the end of your history" : "hit the scan limit";
        setQuickStatus(`Selected ${picked.length} ${noun}${picked.length === 1 ? "" : "s"} only: ${why} after ${evaluated} videos${tail}.`);
      } else {
        setQuickStatus(`Selected ${picked.length} ${noun}${picked.length === 1 ? "" : "s"} (#${f.from}–${f.to}), ${evaluated} videos checked${tail}.`);
      }
    } catch (e) {
      setQuickStatus(e.message || String(e), true);
    } finally {
      quickState = null;
      setQuickBusy(false);
    }
  }

  function stopQuickSelect() {
    if (!quickState) return;
    quickState.abort = true;
    send({ type: "inspect", payload: { cancel: true } }); // drop lookups that haven't started
  }

  // ---------- SPA-aware lifecycle ----------
  function tick() {
    const onHistory = location.pathname === "/feed/history";
    if (onHistory && !ui) buildPanel();
    if (ui) ui.panel.classList.toggle("ythd-hidden", !onHistory); // CSS animates the slide in/out
    if (onHistory) scan();
  }

  setInterval(tick, 800);
  tick();
})();
