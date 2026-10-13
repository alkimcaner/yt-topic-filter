// YT Topic Filter — background service worker
// Proxies classification to the local decision model (llama.cpp /v1/systemone)
// to avoid page CORS issues. Includes queue + cache (no guessing: if the
// model is unreachable the video is marked offline, never keyword-labeled).

const DEFAULT_ENDPOINT = "http://127.0.0.1:9931";
const CACHE_KEY = "ytf_cache_v1";
const MAX_CACHE_ENTRIES = 2000;

// ---- tiny persistent cache ----
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
      // keep most recent N
      const entries = [...memCache.entries()].slice(-MAX_CACHE_ENTRIES);
      for (const [k, v] of entries) obj[k] = v;
      await chrome.storage.local.set({ [CACHE_KEY]: obj });
    } catch { /* ignore */ }
  }, 1000);
}

async function getSettings() {
  const sync = await chrome.storage.sync.get({
    endpoint: DEFAULT_ENDPOINT,
    topics: null,
    minConfidence: 0.35,
  });
  if (!sync.topics) {
    sync.topics = await getDefaultTopics();
  }
  return sync;
}

async function getDefaultTopics() {
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

// ---- request queue (max 3 concurrent, model has 4 slots) ----
const queue = [];
let active = 0;
const MAX_CONCURRENT = 3;

function enqueue(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const { task, resolve, reject } = queue.shift();
    active++;
    task()
      .then(resolve, reject)
      .finally(() => {
        active--;
        pump();
      });
  }
}

async function classifyWithModel(state, topics) {
  const { endpoint } = await getSettings();
  const base = (endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const criteria = {};
  for (const t of topics) {
    criteria[t.name] = t.description || t.name;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(`${base}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state,
        questions: {
          topic: {
            type: "choice",
            instructions: "What topic is this YouTube video about? Pick the single best match.",
            criteria,
          },
        },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`model HTTP ${res.status}`);
    }
    const data = await res.json();
    const ans = data?.answers?.topic;
    if (!ans || !ans.choice) throw new Error("bad model response");
    return {
      topic: ans.choice,
      confidence: ans.confidence ?? 0,
      probabilities: ans.probabilities ?? {},
    };
  } finally {
    clearTimeout(timer);
  }
}

async function handleClassify({ key, title, channel }) {
  await loadCache();
  const settings = await getSettings();
  const topics = settings.topics || [];
  if (!topics.length) throw new Error("no topics configured");
  if (key && memCache.has(key)) {
    const c = memCache.get(key);
    // topic lists change over time (ids renamed, topics deleted):
    // heal the cached answer when possible, else reclassify.
    const canon = c.topic === "other"
      ? "other"
      : (topics.find((t) => t.name === c.topic)?.name
        ?? topics.find((t) => t.name.toLowerCase() === String(c.topic || "").toLowerCase())?.name);
    if (canon) return { ...c, topic: canon, rawTopic: canon, cached: true };
    memCache.delete(key);
  }

  const state = `YouTube video.\nTitle: ${title || "(unknown)"}\nChannel: ${channel || "(unknown)"}`;

  try {
    const result = await enqueue(() => classifyWithModel(state, topics));
    // confidence gate -> "other"
    let finalTopic = result.topic;
    if ((result.confidence ?? 0) < (settings.minConfidence ?? 0)) {
      finalTopic = "other";
    }
    // unknown topic guard (user may have removed it)
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
    // No guessing: report offline, cache nothing (a later Rescan retries).
    return { topic: "other", rawTopic: "other", confidence: 0, probabilities: {}, cached: false, error: String(err?.message || err) };
  }
}

chrome.runtime.onInstalled.addListener(async () => {  const cur = await chrome.storage.sync.get(["endpoint", "topics", "hiddenTopics", "enabled", "hideMode", "minConfidence", "showBadges"]);
  const updates = {};
  if (!cur.endpoint) updates.endpoint = DEFAULT_ENDPOINT;
  if (!cur.topics) updates.topics = await getDefaultTopics();
  if (!cur.hiddenTopics) updates.hiddenTopics = [];
  if (typeof cur.enabled === "undefined") updates.enabled = true;
  if (!cur.hideMode) updates.hideMode = "hide"; // hide | dim | blur
  if (typeof cur.minConfidence === "undefined") updates.minConfidence = 0.35;
  if (typeof cur.showBadges === "undefined") updates.showBadges = true;
  if (Object.keys(updates).length) await chrome.storage.sync.set(updates);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === "YTF_CLASSIFY") {
      const r = await handleClassify(msg);
      sendResponse({ ok: true, result: r });
    } else if (msg?.type === "YTF_TEST") {
      const { endpoint } = await getSettings();
      const base = (endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(`${base}/health`, { signal: ctrl.signal });
        clearTimeout(t);
        const text = await res.text();
        sendResponse({ ok: res.ok, status: res.status, body: text.slice(0, 500), endpoint: base });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e), endpoint: base });
      }
    } else if (msg?.type === "YTF_CLEAR_CACHE") {
      memCache.clear();
      await chrome.storage.local.remove(CACHE_KEY);
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true; // async response
});
