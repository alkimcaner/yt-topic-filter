/* YT Topic Filter — content script (YouTube) */
(() => {
  "use strict";

  const CARD_SELECTORS = [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-reel-item-renderer",
    "ytd-playlist-panel-video-renderer",
    "ytd-lockup-view-model",
    "yt-lockup-view-model",
  ].join(",");

  const MODEL_ID = "Horizon-Labs/multilingual-zeroshot-small";
  const MODEL_LABEL = "zeroshot-small q8 · local";
  const ERROR_RETRY_MS = 30000; // backoff before a failed card is re-tried
  const PROGRESS_STORE_KEY = "ytf_model_progress_v1"; // written by background.js
  const DEFAULT_TOPICS = [
    { name: "Gaming", description: "video games, gameplay, walkthroughs, esports, Minecraft, Fortnite", color: "#8b5cf6" },
    { name: "Tech", description: "gadgets, smartphones, AI, programming, software, computers, reviews", color: "#0ea5e9" },
    { name: "Cooking", description: "recipes, food, cooking tutorials, restaurants, baking", color: "#f59e0b" },
    { name: "Travel", description: "travel vlogs, tourism, destinations, hotels, flights", color: "#10b981" },
    { name: "Music", description: "songs, music videos, concerts, covers, artists", color: "#ec4899" },
    { name: "Education", description: "tutorials, science, learning, explainers, DIY, how-to, LEGO", color: "#6366f1" },
    { name: "News", description: "breaking news, politics, world events, journalism", color: "#ef4444" },
    { name: "Sports", description: "football, basketball, fitness, workouts, highlights, matches", color: "#22c55e" },
    { name: "Comedy", description: "sketches, stand-up, memes, funny videos, pranks, reactions", color: "#eab308" },
    { name: "Film & TV", description: "movies, trailers, TV shows, anime, celebrity, reviews", color: "#a855f7" },
  ];

  const state = {
    enabled: true,
    showBadges: true,
    hideMode: "hide", // legacy pref, kept for stored settings; hiding is always display:none now
    hiddenTopics: [],
    topics: [],
    minConfidence: 0.35,
  };

  const cards = new Map(); // key -> Set<HTMLElement>
  const pending = new Map(); // key -> Promise
  let stats = { classified: 0, hidden: 0 };
  let scanTimer = null;

  function textOf(el) {
    if (!el) return "";
    const t = (el.textContent || "").trim().replace(/\s+/g, " ");
    return t;
  }

  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function extractVideoId(href) {
    if (!href) return "";
    let m = href.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
    if (m) return m[1];
    m = href.match(/\/shorts\/([A-Za-z0-9_-]{6,})/);
    if (m) return m[1];
    m = href.match(/\/watch\/([A-Za-z0-9_-]{6,})/);
    if (m) return m[1];
    return "";
  }

  function extractInfo(card) {
    // --- title ---
    const titleCandidates = [
      "a#video-title-link",
      "a.yt-lockup-metadata-view-model__title",
      "#video-title",
      "yt-formatted-string#video-title",
      "h3 a",
      "a[title][href*='/watch']",
    ];
    let title = "";
    let linkEl = null;
    for (const sel of titleCandidates) {
      const el = card.querySelector(sel);
      if (el) {
        const t = textOf(el) || el.getAttribute("title") || el.getAttribute("aria-label") || "";
        if (t && t.length > 1) {
          title = t.trim();
          if (el.tagName === "A") linkEl = el;
          break;
        }
      }
    }
    // fallback: any watch/shorts link with accessible name
    if (!title) {
      const a = card.querySelector("a[href*='/watch'], a[href*='/shorts/']");
      if (a) {
        title = a.getAttribute("title") || textOf(a);
        linkEl = a;
      }
    }
    // --- link / video id ---
    if (!linkEl) {
      linkEl =
        card.querySelector("a#thumbnail") ||
        card.querySelector("a[href*='/watch?v=']") ||
        card.querySelector("a[href*='/shorts/']");
    }
    const href = linkEl ? linkEl.getAttribute("href") || "" : "";
    const videoId = extractVideoId(href);

    // --- channel ---
    const channelCandidates = [
      "ytd-channel-name a",
      "ytd-channel-name yt-formatted-string",
      "#channel-name a",
      ".yt-lockup-metadata-view-model__metadata a",
      "ytd-video-meta-block a",
      "#owner-name a",
    ];
    let channel = "";
    for (const sel of channelCandidates) {
      const el = card.querySelector(sel);
      if (el) {
        const t = textOf(el);
        if (t) {
          channel = t;
          break;
        }
      }
    }

    title = (title || "").slice(0, 300);
    channel = (channel || "").slice(0, 150);
    return { title, channel, videoId, href };
  }

  function topicColor(name) {
    const t = (state.topics || []).find((x) => x.name === name);
    if (t?.color) return t.color;
    if (name === "other") return "#64748b";
    // deterministic fallback hue
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `hsl(${h} 70% 45%)`;
  }

  function topicLabel(name) {
    return name === "other" ? "Other" : name;
  }

  function ensureBadge(card) {
    let badge = card.querySelector(":scope > .ytf-badge, .ytf-badge");
    // prefer placing inside thumbnail so it overlays the image
    const thumb =
      card.querySelector("ytd-thumbnail") ||
      card.querySelector("a#thumbnail") ||
      card.querySelector("[class*='thumbnail']");
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "ytf-badge";
      badge.textContent = "…";
      if (thumb) {
        thumb.classList.add("ytf-thumb-host");
        thumb.appendChild(badge);
      } else {
        card.classList.add("ytf-host");
        card.prepend(badge);
      }
    }
    return badge;
  }

  function setBadge(card, topic, confidence, isPending) {
    const badge = ensureBadge(card);
    badge.style.display = state.showBadges ? "" : "none";
    if (isPending) {
      badge.textContent = "…";
      badge.className = "ytf-badge ytf-pending";
      badge.removeAttribute("data-topic");
      return;
    }
    const label = topicLabel(topic);
    const pct = Math.round((confidence || 0) * 100);
    badge.textContent = `${label} · ${pct}%`;
    badge.title = `Topic: ${label} (${pct}% confidence) — via local zero-shot model`;
    badge.className = "ytf-badge ytf-done";
    badge.dataset.topic = topic;
    badge.style.setProperty("--ytf-color", topicColor(topic));
  }

  function hideBadge(card) {
    card.querySelector(".ytf-badge")?.remove();
  }

  function applyFilterToCard(card, topic) {
    card.classList.remove("ytf-hide", "ytf-dim", "ytf-blur");
    card.removeAttribute("data-ytf-hidden");
    let hidden = false;
    // never auto-hide videos we failed to classify (they carry data-ytf-error)
    if (state.enabled && topic && !card.hasAttribute("data-ytf-error") && state.hiddenTopics.includes(topic)) {
      hidden = true;
      card.setAttribute("data-ytf-hidden", topic);
      card.classList.add("ytf-hide");
    }
    return hidden;
  }

  function refreshHiddenCount() {
    stats.hidden = document.querySelectorAll(".ytf-hide").length;
    updateTopbarCount();
  }

  function applyAllFilters() {
    for (const [, set] of cards) {
      for (const card of set) {
        applyFilterToCard(card, card.dataset.ytfTopic || "");
      }
    }
    refreshHiddenCount();
  }

  function classifyOne(key, title, channel) {
    if (pending.has(key)) return pending.get(key);
    const p = new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        pending.delete(key);
        resolve({ topic: "other", confidence: 0, error: "classify timeout" });
      }, 120000);
      chrome.runtime.sendMessage(
        { type: "YTF_CLASSIFY", key, title, channel },
        (resp) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          pending.delete(key);
          if (chrome.runtime.lastError) {
            resolve({ topic: "other", confidence: 0, error: "extension messaging failed" });
            return;
          }
          resolve(resp?.result || { topic: "other", confidence: 0 });
        }
      );
    });
    pending.set(key, p);
    return p;
  }

  async function processCard(card) {
    if (!(card instanceof HTMLElement)) return;
    const { title, channel, videoId } = extractInfo(card);
    if (!title && !videoId) return;

    const key = videoId
      ? `v:${videoId}`
      : `h:${hashStr(title + "|" + channel)}`;

    // register
    if (!cards.has(key)) cards.set(key, new Set());
    cards.get(key).add(card);

    // already classified in this session?
    if (card.dataset.ytfTopic) {
      applyFilterToCard(card, card.dataset.ytfTopic);
      return;
    }
    // same video rendered twice: copy topic if sibling already done
    for (const sib of cards.get(key)) {
      if (sib !== card && sib.dataset.ytfTopic) {
        card.dataset.ytfTopic = sib.dataset.ytfTopic;
        card.dataset.ytfConfidence = sib.dataset.ytfConfidence || "";
        if (sib.dataset.ytfError) {
          card.dataset.ytfError = sib.dataset.ytfError;
          card.dataset.ytfRetryAt = sib.dataset.ytfRetryAt || String(Date.now() + ERROR_RETRY_MS);
          hideBadge(card);
        } else {
          delete card.dataset.ytfError;
          setBadge(card, sib.dataset.ytfTopic, parseFloat(sib.dataset.ytfConfidence || "0"), false);
        }
        applyFilterToCard(card, sib.dataset.ytfTopic);
        refreshHiddenCount();
        return;
      }
    }

    card.dataset.ytfKey = key;
    setBadge(card, "", 0, true);

    const res = await classifyOne(key, title, channel);
    let topic = res.topic || "other";
    // if model returned a topic the user deleted, fold to other
    if (topic !== "other" && !state.topics.some((t) => t.name === topic)) {
      topic = "other";
    }
    const conf = res.confidence || 0;

    // fan-out to every card with this key
    const set = cards.get(key) || new Set([card]);
    for (const c of set) {
      c.dataset.ytfTopic = topic;
      c.dataset.ytfConfidence = String(conf);
      if (res.error) {
        // model unreachable: no badge at all (and error cards never auto-hide).
        // Retry later with backoff (scan() picks these back up) instead of
        // going badge-less forever while cards below keep classifying.
        c.dataset.ytfError = res.error;
        c.dataset.ytfRetryAt = String(Date.now() + ERROR_RETRY_MS);
        hideBadge(c);
      } else {
        delete c.dataset.ytfError;
        setBadge(c, topic, conf, false);
      }
      applyFilterToCard(c, topic);
    }
    stats.classified++;
    refreshHiddenCount();
  }

  function scan() {
    ensureTopbar();
    if (!state.enabled && cards.size === 0) {
      // still scan so badges exist for when user re-enables? skip to save work
    }
    const nodes = document.querySelectorAll(CARD_SELECTORS);
    let n = 0;
    for (const card of nodes) {
      if (!(card instanceof HTMLElement)) continue;
      // Failed cards become eligible again after their backoff (e.g. the
      // model finished loading after they errored) — otherwise the top of
      // the page stays bare while newly scrolled cards get labeled.
      if (card.dataset.ytfError) {
        if (Date.now() < Number(card.dataset.ytfRetryAt || 0)) continue;
        delete card.dataset.ytfError;
        delete card.dataset.ytfRetryAt;
        delete card.dataset.ytfTopic;
        delete card.dataset.ytfConfidence;
        delete card.dataset.ytfScanned;
        delete card.dataset.ytfKey;
      }
      // skip channel avatars / ads that have no title link
      if (card.dataset.ytfScanned && card.dataset.ytfTopic) continue;
      // mark scanned to avoid re-extract cost every pass (re-scan pending ones)
      if (card.dataset.ytfScanned === "1" && pending.has(card.dataset.ytfKey || "")) continue;
      card.dataset.ytfScanned = "1";
      // fire-and-forget, throttled
      if (n < 60) {
        n++;
        processCard(card);
      }
    }
    if (n > 0) refreshHiddenCount();
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      try {
        scan();
      } catch (e) {
        console.warn("[YTF] scan error", e);
      }
    }, 350);
  }

  async function loadSettings() {
    try {
      const data = await chrome.storage.sync.get({
        enabled: true,
        showBadges: true,
        hideMode: "hide",
        hiddenTopics: [],
        topics: [],
        minConfidence: 0.35,
      });
      Object.assign(state, data);
    } catch (e) {
      console.warn("[YTF] settings load failed", e);
    }
  }

  // ---------- top bar controls (no toolbar popup; everything lives here) ----------
  function mastheadEnd() {
    return document.querySelector("ytd-masthead #end") || document.querySelector("#masthead #end") || null;
  }

  function ensureTopbar() {
    if (document.getElementById("ytf-topbar")) return true;
    const end = mastheadEnd();
    if (!end || !end.isConnected) return false;
    const holder = document.createElement("div");
    holder.id = "ytf-topbar";
    const btn = document.createElement("button");
    btn.id = "ytf-topbar-btn";
    btn.title = "YT Topic Filter — topics & filters";
    btn.setAttribute("aria-label", "YT Topic Filter — topics & filters");
    btn.innerHTML = "<svg viewBox=\"0 0 24 24\"><path d=\"M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z\"></path></svg><span class=\"ytf-topbar-label\">Topic filter</span><span id=\"ytf-topbar-count\"></span>";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePanel();
    });
    holder.appendChild(btn);
    end.prepend(holder);
    if (!document.getElementById("ytf-panel")) {
      const panel = document.createElement("div");
      panel.id = "ytf-panel";
      panel.hidden = true;
      document.body.appendChild(panel);
      document.addEventListener("click", (e) => {
        const p = document.getElementById("ytf-panel");
        const tb = document.getElementById("ytf-topbar");
        if (p && !p.hidden && !p.contains(e.target) && !(tb && tb.contains(e.target))) {
          p.hidden = true;
        }
      }, true);
    }
    updateTopbarCount();
    return true;
  }

  function togglePanel(force) {
    const panel = document.getElementById("ytf-panel");
    if (!panel) return;
    const show = typeof force === "boolean" ? force : panel.hidden;
    if (show) renderPanel(panel);
    panel.hidden = !show;
  }

  let panelToastTimer = null;
  function panelToast(msg) {
    const t = document.getElementById("ytf-toast");
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    if (panelToastTimer) clearTimeout(panelToastTimer);
    panelToastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderPanel(panel) {
    panel.innerHTML = "";

    const head = el("div", "ytf-p-head");
    head.appendChild(el("span", "ytf-p-title", "YT Topic Filter"));
    const enLabel = el("label", "ytf-p-enable");
    const enCb = document.createElement("input");
    enCb.type = "checkbox";
    enCb.checked = !!state.enabled;
    enCb.title = "Enable/disable filtering";
    enCb.addEventListener("change", async () => {
      state.enabled = enCb.checked;
      await chrome.storage.sync.set({ enabled: state.enabled });
      applyAllFilters();
    });
    enLabel.append(enCb, el("span", null, "On"));
    head.appendChild(enLabel);
    panel.appendChild(head);

    panel.appendChild(el("div", "ytf-p-count",
      stats.hidden > 0 ? `${stats.hidden} video${stats.hidden > 1 ? "s" : ""} hidden` : "Nothing hidden"));

    panel.appendChild(el("div", "ytf-p-sect", "Topics — uncheck to hide"));
    const list = el("div", "ytf-p-list");
    const all = [...(state.topics || []), { name: "other", description: "Uncertain / low confidence", color: "#64748b", locked: true }];
    for (const t of all) {
      const row = el("div", "ytf-p-row");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !state.hiddenTopics.includes(t.name);
      if (!cb.checked) row.classList.add("ytf-is-hidden");
      cb.title = state.hiddenTopics.includes(t.name) ? "Hidden — check to show" : "Shown — uncheck to hide";
      cb.addEventListener("change", async () => {
        const hidden = new Set(state.hiddenTopics);
        if (cb.checked) hidden.delete(t.name);
        else hidden.add(t.name);
        state.hiddenTopics = [...hidden];
        await chrome.storage.sync.set({ hiddenTopics: state.hiddenTopics });
        applyAllFilters();
        renderPanel(panel);
      });
      const dot = el("span", "ytf-dot");
      dot.style.background = t.color || topicColor(t.name);
      const name = el("div", "ytf-p-name");
      name.appendChild(el("b", null, t.name === "other" ? "Other" : t.name));
      const sub = el("span", null, t.description || "");
      sub.title = t.description || "";
      name.appendChild(sub);
      row.append(cb, dot, name);
      if (!t.locked) {
        const del = el("button", "ytf-p-del", "×");
        del.title = `Delete topic "${t.name}"`;
        del.addEventListener("click", async () => {
          if (del.dataset.armed) {
            const cur = await chrome.storage.sync.get({ topics: [], hiddenTopics: [] });
            const topics = (cur.topics || []).filter((x) => x.name !== t.name);
            await chrome.storage.sync.set({
              topics,
              hiddenTopics: (cur.hiddenTopics || []).filter((x) => x !== t.name),
            });
            state.topics = topics;
            applyAllFilters();
            renderPanel(panel);
            return;
          }
          del.dataset.armed = "1";
          del.textContent = "sure?";
          setTimeout(() => {
            if (del.isConnected) { delete del.dataset.armed; del.textContent = "×"; }
          }, 3000);
        });
        row.appendChild(del);
      }
      list.appendChild(row);
    }
    panel.appendChild(list);

    const prefs = el("div", "ytf-p-prefs");
    const bLabel = el("label", "ytf-p-check");
    const bCb = document.createElement("input");
    bCb.type = "checkbox";
    bCb.checked = !!state.showBadges;
    bCb.addEventListener("change", async () => {
      state.showBadges = bCb.checked;
      await chrome.storage.sync.set({ showBadges: state.showBadges });
      document.querySelectorAll(".ytf-badge").forEach((b) => { b.style.display = state.showBadges ? "" : "none"; });
    });
    bLabel.append(bCb, el("span", null, "badges"));
    prefs.append(bLabel);
    panel.appendChild(prefs);

    const confRow = el("div", "ytf-p-conf");
    const pct = Math.round((state.minConfidence ?? 0.35) * 100);
    const confLab = el("label", null, "Min confidence ");
    const confVal = el("span", null, `${pct}%`);
    confLab.appendChild(confVal);
    const range = document.createElement("input");
    range.type = "range";
    range.min = "0";
    range.max = "90";
    range.step = "5";
    range.value = String(pct);
    range.addEventListener("input", () => { confVal.textContent = `${range.value}%`; });
    range.addEventListener("change", async () => {
      state.minConfidence = Number(range.value) / 100;
      await chrome.storage.sync.set({ minConfidence: state.minConfidence });
    });
    confRow.append(confLab, range);
    panel.appendChild(confRow);

    panel.appendChild(el("div", "ytf-p-sect", "Add topic"));
    const addGrid = el("div", "ytf-p-add");
    const inName = document.createElement("input");
    inName.placeholder = "Name: e.g. Finance";
    inName.className = "ytf-p-wide";
    const inDesc = document.createElement("input");
    inDesc.placeholder = "Description: money, stocks, investing…";
    inDesc.className = "ytf-p-wide";
    const inColor = document.createElement("input");
    inColor.type = "color";
    inColor.value = "#0ea5e9";
    inColor.title = "Badge color";
    const addBtn = el("button", "ytf-p-btn", "Add");
    addBtn.addEventListener("click", async () => {
      const name = inName.value.trim();
      const desc = inDesc.value.trim();
      if (!name || !desc) { panelToast("Need a name and a description."); return; }
      const cur = (await chrome.storage.sync.get({ topics: [] })).topics || [];
      if (cur.some((x) => (x.name || "").toLowerCase() === name.toLowerCase())) { panelToast(`Topic "${name}" already exists.`); return; }
      cur.push({ name, description: desc, color: inColor.value });
      await chrome.storage.sync.set({ topics: cur });
      state.topics = cur;
      renderPanel(panel);
      panelToast(`Added "${name}".`);
    });
    const addRow = el("div", "ytf-p-addrow");
    addRow.append(inColor, addBtn);
    addGrid.append(inName, inDesc, addRow);
    panel.appendChild(addGrid);

    panel.appendChild(el("div", "ytf-p-sect", "Model"));
    const mInfo = el("div", "ytf-p-status", MODEL_LABEL);
    mInfo.title = MODEL_ID;
    panel.appendChild(mInfo);
    const mRow = el("div", "ytf-p-mrow");
    const loadBtn = el("button", "ytf-p-btn", "Load model");
    loadBtn.title = `Download once (~260 MB q8), then run locally (${MODEL_ID})`;
    const mStatus = el("div", "ytf-p-status", "checking…");
    const fmtMB = (n) => `${(Number(n || 0) / 1048576).toFixed(0)} MB`;
    // Set when the user kicks off a load: the poll below fires the toast +
    // rescan once the worker actually reports ready (loads take minutes and
    // outlive any single message round-trip).
    let armedRescan = false;
    const fireReady = () => {
      if (!armedRescan) return;
      armedRescan = false;
      panelToast("Model ready — re-classifying…");
      scheduleScan();
      setTimeout(scan, 300);
    };
    const refreshStatus = () => {
      chrome.runtime.sendMessage({ type: "YTF_MODEL_STATUS" }, (resp) => {
        if (chrome.runtime.lastError) { mStatus.textContent = "extension error"; return; }
        const s = resp?.status;
        if (!s) { mStatus.textContent = "unknown"; return; }
        if (s.state === "ready") {
          mStatus.textContent = `ready (${MODEL_LABEL})`;
          loadBtn.textContent = "Loaded ✓";
          fireReady();
        } else if (s.state === "loading") {
          const pct = Math.round((s.progress || 0) * 100);
          const shortFile = s.file ? String(s.file).split("/").pop() : "";
          const cleared = s.lastCleared && Date.now() - s.lastCleared.at < 300000
            ? ` — cleared ${s.lastCleared.removed}/${s.lastCleared.scanned} files${s.lastCleared.wiped ? " (full wipe)" : ""}`
            : "";
          mStatus.textContent = s.total > 0
            ? `downloading… ${pct}% (${fmtMB(s.loaded)} / ${fmtMB(s.total)})${shortFile ? ` — ${shortFile}` : ""}${cleared}`
            : `loading… ${pct}%${shortFile ? ` — ${shortFile}` : ""}${cleared}`;
          mStatus.title = s.file || "";
          loadBtn.textContent = "Loading…";
          setTimeout(() => { if (mStatus.isConnected) refreshStatus(); }, 1000);
        } else if (s.state === "error") {
          armedRescan = false;
          mStatus.textContent = `error — ${s.error || "failed to load"}`;
          loadBtn.textContent = "Retry load";
        } else {
          mStatus.textContent = "not loaded — click Load (~260 MB first run)";
          loadBtn.textContent = "Load model";
          // Work was kicked off but the worker hasn't reported loading yet
          // (doc still booting): keep polling instead of going quiet.
          if (armedRescan && mStatus.isConnected) {
            setTimeout(refreshStatus, 1000);
          }
        }
      });
    };
    loadBtn.addEventListener("click", () => {
      armedRescan = true;
      mStatus.textContent = "loading…";
      loadBtn.textContent = "Loading…";
      chrome.runtime.sendMessage({ type: "YTF_MODEL_LOAD" }, (resp) => {
        if (chrome.runtime.lastError) { mStatus.textContent = "extension error"; return; }
        if (!resp?.ok) {
          armedRescan = false;
          mStatus.textContent = `error — ${resp?.error || "failed to start"}`;
          loadBtn.textContent = "Retry load";
        }
        // Otherwise the poll loop reports progress and fires the rescan.
      });
      setTimeout(() => { if (mStatus.isConnected) refreshStatus(); }, 1500);
    });
    const reBtn = el("button", "ytf-p-btn ytf-p-ghost", "Redownload");
    reBtn.title = "Delete cached model files and download fresh. Use after a failed download.";
    reBtn.addEventListener("click", () => {
      if (!reBtn.dataset.armed) {
        reBtn.dataset.armed = "1";
        reBtn.textContent = "sure?";
        setTimeout(() => {
          if (reBtn.isConnected) { delete reBtn.dataset.armed; reBtn.textContent = "Redownload"; }
        }, 3000);
        return;
      }
      delete reBtn.dataset.armed;
      reBtn.textContent = "Redownload";
      armedRescan = true;
      mStatus.textContent = "clearing cache…";
      chrome.runtime.sendMessage({ type: "YTF_MODEL_REDOWNLOAD" }, (resp) => {
        if (chrome.runtime.lastError) { mStatus.textContent = "extension error"; return; }
        if (!resp?.ok) {
          armedRescan = false;
          mStatus.textContent = `error — ${resp?.error || "failed to start"}`;
          loadBtn.textContent = "Retry load";
        }
        // Otherwise the poll loop reports progress and fires the rescan.
      });
      setTimeout(() => { if (mStatus.isConnected) refreshStatus(); }, 1500);
    });
    mRow.append(loadBtn, reBtn);
    panel.appendChild(mRow);
    panel.appendChild(mStatus);
    refreshStatus();

    const actions = el("div", "ytf-p-actions");
    const rescan = el("button", "ytf-p-btn", "Rescan");
    rescan.title = "Clear cache and re-classify this page";
    rescan.addEventListener("click", async () => {
      panelToast("Clearing cache…");
      chrome.runtime.sendMessage({ type: "YTF_CLEAR_CACHE" }, () => {
        for (const [, set] of cards) {
          for (const c of set) {
            delete c.dataset.ytfTopic;
            delete c.dataset.ytfConfidence;
            delete c.dataset.ytfError;
            delete c.dataset.ytfScanned;
            delete c.dataset.ytfKey;
          }
        }
        pending.clear();
        scheduleScan();
        setTimeout(scan, 300);
        panelToast("Cache cleared — re-classifying…");
      });
    });
    const reset = el("button", "ytf-p-btn ytf-p-ghost", "Reset topics");
    reset.title = "Reset topics to defaults";
    reset.addEventListener("click", async () => {
      if (!reset.dataset.armed) {
        reset.dataset.armed = "1";
        reset.textContent = "sure?";
        setTimeout(() => {
          if (reset.isConnected) { delete reset.dataset.armed; reset.textContent = "Reset topics"; }
        }, 3000);
        return;
      }
      await chrome.storage.sync.set({ topics: DEFAULT_TOPICS.slice(), hiddenTopics: [] });
      state.topics = DEFAULT_TOPICS.slice();
      state.hiddenTopics = [];
      applyAllFilters();
      renderPanel(panel);
    });
    actions.append(rescan, reset);
    panel.appendChild(actions);

    const toastBox = el("div", "ytf-p-toast");
    toastBox.id = "ytf-toast";
    toastBox.hidden = true;
    panel.appendChild(toastBox);
  }

  function updateTopbarCount() {
    const btn = document.getElementById("ytf-topbar-btn");
    const e = document.getElementById("ytf-topbar-count");
    if (btn) {
      btn.classList.toggle("ytf-off", !state.enabled);
      btn.title = state.enabled
        ? `YT Topic Filter — topics & filters${stats.hidden > 0 ? ` (${stats.hidden} hidden)` : ""}`
        : "YT Topic Filter — off";
    }
    if (!e) return;
    e.textContent = stats.hidden > 0 ? `· ${stats.hidden} hidden` : "";
  }

  // ---------- boot ----------
  async function boot() {
    await loadSettings();
    ensureTopbar();
    updateTopbarCount();

    // panel "Rescan page": full re-classify (clears per-card labels so even
    // cached/cleared results are fetched again)
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === "YTF_RESCAN") {
          for (const [, set] of cards) {
            for (const c of set) {
              delete c.dataset.ytfTopic;
              delete c.dataset.ytfConfidence;
              delete c.dataset.ytfError;
              delete c.dataset.ytfScanned;
              delete c.dataset.ytfKey;
            }
          }
          pending.clear();
        }
        scheduleScan();
        setTimeout(scan, 300);
      });
    } catch { /* ignore */ }

    chrome.storage.onChanged.addListener((changes, area) => {
      // Model just became ready in the worker: immediately retry every
      // failed card instead of waiting out their backoffs.
      if (area === "local" && changes[PROGRESS_STORE_KEY]?.newValue?.state === "ready") {
        let n = 0;
        document.querySelectorAll(CARD_SELECTORS).forEach((card) => {
          if (card instanceof HTMLElement && card.dataset.ytfError) {
            delete card.dataset.ytfError;
            delete card.dataset.ytfRetryAt;
            delete card.dataset.ytfTopic;
            delete card.dataset.ytfConfidence;
            delete card.dataset.ytfScanned;
            delete card.dataset.ytfKey;
            n++;
          }
        });
        if (n > 0) {
          // NB: leave `pending` alone — in-flight requests still resolve
          // and populate badges normally.
          scheduleScan();
          setTimeout(scan, 300);
        }
        return;
      }
      if (area !== "sync") return;
      let needRescan = false;
      if (changes.enabled) state.enabled = changes.enabled.newValue;
      if (changes.showBadges) {
        state.showBadges = changes.showBadges.newValue;
        document.querySelectorAll(".ytf-badge").forEach((b) => {
          b.style.display = state.showBadges ? "" : "none";
        });
      }
      if (changes.hideMode) state.hideMode = changes.hideMode.newValue;
      if (changes.hiddenTopics) state.hiddenTopics = changes.hiddenTopics.newValue || [];
      if (changes.topics) {
        state.topics = changes.topics.newValue || [];
        needRescan = true;
      }
      if (changes.minConfidence) state.minConfidence = changes.minConfidence.newValue;
      applyAllFilters();
      // keep the open panel in sync (unless the user is typing in it)
      const panel = document.getElementById("ytf-panel");
      const ae = document.activeElement;
      const typing = ae && panel && panel.contains(ae) && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName);
      if (panel && !panel.hidden && !typing && (changes.topics || changes.hiddenTopics || changes.enabled)) {
        renderPanel(panel);
      }
      if (needRescan) {
        // clear per-card topics so new topic set re-classifies lazily
        for (const [, set] of cards) {
          for (const c of set) {
            delete c.dataset.ytfTopic;
            delete c.dataset.ytfError;
            delete c.dataset.ytfScanned;
          }
        }
        scheduleScan();
      }
    });

    // YouTube is an SPA — observe DOM + navigation events
    const obs = new MutationObserver(scheduleScan);
    obs.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("yt-navigate-finish", scheduleScan);
    window.addEventListener("yt-navigate-finish", scheduleScan);
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        scheduleScan();
      }
    }, 1500);

    scan();
    // re-scan a few times as YouTube lazy-renders
    setTimeout(scan, 1500);
    setTimeout(scan, 4000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
