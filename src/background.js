// YT Topic Filter — background service worker (router + result cache).
// Classification runs against the local decision server at localhost:9931.
const SERVER_URL = "http://localhost:9931";
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);
    const res = await fetch(`${SERVER_URL}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: title ? (channel ? `${title}\nChannel: ${channel}` : title) : "(unknown)",
        questions: {
          topic: {
            type: "choice",
            instructions: "What topic is this video about?",
            criteria: Object.fromEntries(topics.map((t) => [t.name, t.description || t.name])),
          },
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`server HTTP ${res.status}`);
    const data = await res.json();
    const result = data?.answers?.topic || {};
    let finalTopic = result.choice || "other";
    if ((result.confidence ?? 0) < (settings.minConfidence ?? 0)) {
      finalTopic = "other";
    }
    if (finalTopic !== "other" && !topics.some((t) => t.name === finalTopic)) {
      finalTopic = "other";
    }
    const out = {
      topic: finalTopic,
      rawTopic: result.choice || "other",
      confidence: result.confidence ?? 0,
      probabilities: result.probabilities || {},
      cached: false,
    };
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
  (async () => {
    if (msg?.type === "YTF_CLASSIFY") {
      const r = await handleClassify(msg);
      sendResponse({ ok: true, result: r });
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
