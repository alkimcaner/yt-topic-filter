// YT Topic Filter — background service worker (router + result cache).
// The model lives in the offscreen document (src/offscreen.js): WASM cannot
// init in a worker. This file owns the videoId cache, forwards inference to
// the offscreen doc, and serves model status to the panel.
const OFFSCREEN_URL = "src/offscreen.html";
const PROGRESS_STORE_KEY = "ytf_model_progress_v1";
const OFFSCREEN_READY_TIMEOUT_MS = 30000;
const OFFSCREEN_STATUS_TIMEOUT_MS = 8000;
const CLASSIFY_TIMEOUT_MS = 180000;

const CACHE_KEY = "ytf_cache_v1";
const MAX_CACHE_ENTRIES = 2000;

// ---- tiny persistent cache (classification results) ----
let memCache = new Map();
let cacheLoaded = false;

async function loadCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const data = await chrome.storage.local.get(CACHE_KEY);
    const obj = data[CACHE_KEY] || {};
    for (const [k, v] of Object.entries(obj)) memCache.set(k, v);
  } catch { /* ignore */ }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const obj = {};
      const entries = [...memCache.entries()].slice(-MAX_CACHE_ENTRIES);
      for (const [k, v] of entries) obj[k] = v;
      await chrome.storage.local.set({ [CACHE_KEY]: obj });
    } catch { /* ignore */ }
  }, 1000);
}

async function getSettings() {
  const sync = await chrome.storage.sync.get({
    topics: null,
    minConfidence: 0.35,
  });
  if (!sync.topics) {
    sync.topics = getDefaultTopics();
  }
  return sync;
}

function getDefaultTopics() {
  // keep in sync with content.js DEFAULT_TOPICS
  return [
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
}

// ---- model status (mirrored from the offscreen doc, persisted so worker
// restarts don't blank the panel back to 0%) ----
let memStatus = null;
let persistTimer = null;

async function seedStatus() {
  if (memStatus) return;
  try {
    const data = await chrome.storage.local.get(PROGRESS_STORE_KEY);
    memStatus = data[PROGRESS_STORE_KEY] || null;
  } catch {
    memStatus = null;
  }
}

function setStatus(status) {
  memStatus = { ...status };
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      await chrome.storage.local.set({ [PROGRESS_STORE_KEY]: memStatus });
    } catch { /* ignore */ }
  }, 1000);
}

function getStatus() {
  return memStatus ? { ...memStatus } : null;
}

// ---- offscreen document plumbing ----
let offscreenCreating = null;

// chrome.offscreen needs Chromium 109+. hasDocument() needs 116+.
// Tolerate older: without hasDocument, create and treat "already exists"
// as "it is there".
function offscreenAPI() {
  const api = chrome.offscreen;
  if (!api || typeof api.createDocument !== "function") {
    throw new Error(
      "offscreen support is unavailable (needs the 'offscreen' permission and Chromium 109+) — reload the extension, update Brave, or use the server version"
    );
  }
  return api;
}

async function hasOffscreenDoc(api) {
  if (typeof api.hasDocument === "function") return api.hasDocument();
  return null; // unknown on Chromium 109-115
}

async function createOffscreenDoc(api) {
  try {
    await api.createDocument({
      url: OFFSCREEN_URL,
      reasons: [api.Reason.WORKERS],
      justification: "Run the local video-topic model (WASM) off the service worker thread.",
    });
  } catch (e) {
    // A document already exists (the 109-115 path without hasDocument).
    if (!/single offscreen|already exists|only one/i.test(String(e?.message || e))) throw e;
  }
}

let reqSeq = 0;
const pending = new Map();

// Raw correlated post. Does NOT ensure the document (so liveness checks
// and creation don't recurse into each other).
function postToDoc(type, payload, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const id = `r${++reqSeq}`;
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("offscreen request timed out"));
      }, timeoutMs);
    }
    pending.set(id, { resolve, reject, timer });
    try {
      chrome.runtime.sendMessage({ target: "offscreen", type, id, payload }, () => {
        if (chrome.runtime.lastError) {
          // No listener yet (doc still booting): keep waiting; the
          // timeout above bounds the wait.
        }
      });
    } catch (e) {
      pending.delete(id);
      if (timer) clearTimeout(timer);
      reject(e);
    }
  });
}

// Liveness handshake: the doc answers pings once its module runs.
// More robust than a one-shot READY flag across worker restarts.
async function waitForDocAlive(timeoutMs) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await postToDoc("YTF_OFF_STATUS", null, 3000);
      if (res?.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) {
      throw new Error("offscreen document did not start");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function ensureOffscreen() {
  const api = offscreenAPI();
  if (offscreenCreating) {
    await offscreenCreating;
  } else {
    let exists = false;
    try {
      exists = (await hasOffscreenDoc(api)) === true;
    } catch {
      exists = false;
    }
    if (!exists) {
      offscreenCreating = createOffscreenDoc(api).finally(() => {
        offscreenCreating = null;
      });
      await offscreenCreating;
    }
  }
  await waitForDocAlive(OFFSCREEN_READY_TIMEOUT_MS);
}

function sendToOffscreen(type, payload, timeoutMs = 0) {
  return (async () => {
    await ensureOffscreen();
    return postToDoc(type, payload, timeoutMs);
  })();
}

function settleOffResult(msg) {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (p.timer) clearTimeout(p.timer);
  p.resolve(msg);
}

// Reconcile after worker boot: seed from storage, and only if a download
// was in flight, check whether its document is still alive. (Never create a
// document here: that would spawn one on every worker wake.)
(async function reconcileOnBoot() {
  await seedStatus();
  if (!memStatus || memStatus.state !== "loading") return;
  try {
    const api = offscreenAPI();
    const known = await hasOffscreenDoc(api).catch(() => null);
    if (known === false) throw new Error("no doc");
    if (known === null) return; // 109-115: can't tell; leave the snapshot
    const res = await postToDoc("YTF_OFF_STATUS", null, OFFSCREEN_STATUS_TIMEOUT_MS);
    if (res?.ok && res.status) setStatus(res.status);
  } catch {
    // Document died mid-download: back to idle so the panel offers Load.
    setStatus({ ...memStatus, state: "idle", error: "interrupted — click Load to resume" });
  }
})();

async function handleClassify({ key, title, channel }) {
  await loadCache();
  const settings = await getSettings();
  const topics = settings.topics || [];
  if (!topics.length) throw new Error("no topics configured");
  if (key && memCache.has(key)) {
    const c = memCache.get(key);
    const canon = c.topic === "other"
      ? "other"
      : (topics.find((t) => t.name === c.topic)?.name
        ?? topics.find((t) => t.name.toLowerCase() === String(c.topic || "").toLowerCase())?.name);
    if (canon) return { ...c, topic: canon, rawTopic: canon, cached: true };
    memCache.delete(key);
  }

  try {
    const res = await sendToOffscreen(
      "YTF_OFF_CLASSIFY",
      { title, channel, topics },
      CLASSIFY_TIMEOUT_MS
    );
    if (!res?.ok) throw new Error(res?.error || "offscreen classify failed");
    const result = res.result || {};
    let finalTopic = result.topic || "other";
    if ((result.confidence ?? 0) < (settings.minConfidence ?? 0)) {
      finalTopic = "other";
    }
    if (finalTopic !== "other" && !topics.some((t) => t.name === finalTopic)) {
      finalTopic = "other";
    }
    const out = { topic: finalTopic, rawTopic: result.topic, confidence: result.confidence, probabilities: result.probabilities, cached: false };
    if (key) {
      memCache.set(key, out);
      scheduleSave();
    }
    return out;
  } catch (err) {
    return { topic: "other", rawTopic: "other", confidence: 0, probabilities: {}, cached: false, error: String(err?.message || err) };
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.sync.get(["topics", "hiddenTopics", "enabled", "hideMode", "minConfidence", "showBadges"]);
  const updates = {};
  if (!cur.topics) updates.topics = getDefaultTopics();
  if (!cur.hiddenTopics) updates.hiddenTopics = [];
  if (typeof cur.enabled === "undefined") updates.enabled = true;
  if (!cur.hideMode) updates.hideMode = "hide";
  if (typeof cur.minConfidence === "undefined") updates.minConfidence = 0.35;
  if (typeof cur.showBadges === "undefined") updates.showBadges = true;
  if (Object.keys(updates).length) await chrome.storage.sync.set(updates);
  try {
    await chrome.storage.sync.remove(["endpoint"]);
  } catch { /* ignore */ }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Traffic for the offscreen doc: results and progress pushes.
  if (msg?.target !== "offscreen" && (msg?.type === "YTF_OFF_RESULT" || msg?.type === "YTF_OFF_PROGRESS" || msg?.type === "YTF_OFF_READY")) {
    if (msg.type === "YTF_OFF_RESULT") settleOffResult(msg);
    else if (msg.type === "YTF_OFF_PROGRESS" && msg.status) setStatus(msg.status);
    else if (msg.type === "YTF_OFF_READY") {
      if (msg.status) setStatus(msg.status);
    }
    return false;
  }
  if (msg?.target === "offscreen") return false; // not ours; the doc handles it
  (async () => {
    if (msg?.type === "YTF_CLASSIFY") {
      const r = await handleClassify(msg);
      sendResponse({ ok: true, result: r });
    } else if (msg?.type === "YTF_MODEL_STATUS") {
      await seedStatus();
      sendResponse({ ok: true, status: getStatus() });
    } else if (msg?.type === "YTF_MODEL_LOAD") {
      // Fire-and-forget: the doc ACKs receipt, then works for minutes.
      // Progress/ready surface through the status poll.
      try {
        const res = await sendToOffscreen("YTF_OFF_LOAD", null, 15000);
        sendResponse({ ok: !!res?.ok, error: res?.error, status: getStatus() });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e), status: getStatus() });
      }
    } else if (msg?.type === "YTF_MODEL_REDOWNLOAD") {
      try {
        const res = await sendToOffscreen("YTF_OFF_REDOWNLOAD", null, 15000);
        sendResponse({ ok: !!res?.ok, error: res?.error, status: getStatus() });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e), status: getStatus() });
      }
    } else if (msg?.type === "YTF_CLEAR_CACHE") {
      memCache.clear();
      await chrome.storage.local.remove(CACHE_KEY);
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true;
});
