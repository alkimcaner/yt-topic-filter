// YT Topic Filter — offscreen document (owns the local zero-shot model).
// Runs here and NOT in the service worker because onnxruntime-web's WASM
// backend reads files with synchronous XMLHttpRequest, which does not exist
// in service workers ("no available backend found / XMLHttpRequest is not
// defined"). An offscreen document is a real DOM page, so WASM inits fine,
// and it survives longer than the worker during multi-minute downloads.
import { env, AutoTokenizer, AutoModelForSequenceClassification } from "@huggingface/transformers";

env.allowLocalModels = false;

// onnxruntime-web dynamically import()s its WASM glue at session init.
// Remote imports are blocked by the extension CSP (script-src 'self'), so
// the runtime files are vendored (src/vendor/ort/) and pinned here instead
// of the jsdelivr CDN default.
{
  const ortBase = chrome.runtime.getURL("src/vendor/ort/");
  env.backends.onnx.wasm.wasmPaths = {
    mjs: ortBase + "ort-wasm-simd-threaded.asyncify.mjs",
    wasm: ortBase + "ort-wasm-simd-threaded.asyncify.wasm",
  };
}

const MODEL_ID = "Horizon-Labs/multilingual-zeroshot-small";
const MODEL_DTYPE = "q8";
const MODEL_DEVICE = "wasm";
// Template recommended for topic labels ("This video is about {}.").
const HYPOTHESIS_TEMPLATE = "This video is about {}.";

let tokenizer = null;
let seqModel = null;
let entailmentId = 1;
let loadPromise = null;
const modelStatus = {
  state: "idle", // idle | loading | ready | error
  progress: 0,
  loaded: 0,
  total: 0,
  file: null,
  error: null,
  lastCleared: null, // { removed, at } — proof the redownload actually wiped files
  modelId: MODEL_ID,
  dtype: MODEL_DTYPE,
  device: MODEL_DEVICE,
};

const fileProgress = new Map();

function resetFileProgress() {
  fileProgress.clear();
  modelStatus.progress = 0;
  modelStatus.loaded = 0;
  modelStatus.total = 0;
  modelStatus.file = null;
}

function pushStatus() {
  try {
    chrome.runtime.sendMessage({ type: "YTF_OFF_PROGRESS", status: { ...modelStatus } }, () => {});
  } catch { /* worker may be asleep; it reconciles on wake */ }
}

function onFileProgress(info) {
  try {
    if (!info || typeof info !== "object") return;
    if (info.file) modelStatus.file = info.file;
    if (info.status === "progress" || info.status === "progress_total") {
      if (info.file) {
        fileProgress.set(info.file, {
          loaded: Number(info.loaded) || 0,
          total: Number(info.total) || 0,
        });
      } else if (typeof info.progress === "number") {
        modelStatus.progress = Math.max(0, Math.min(1, info.progress / 100));
      }
      let loaded = 0;
      let total = 0;
      for (const { loaded: l, total: t } of fileProgress.values()) {
        loaded += l;
        total += t;
      }
      if (total > 0) {
        modelStatus.loaded = loaded;
        modelStatus.total = total;
        modelStatus.progress = Math.max(0, Math.min(1, loaded / total));
      }
      pushStatus();
    }
  } catch { /* ignore progress errors */ }
}

function setState(state, error = null) {
  modelStatus.state = state;
  modelStatus.error = error;
  pushStatus();
}

async function ensureModel() {
  if (seqModel && tokenizer) return { tokenizer, model: seqModel };
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    modelStatus.error = null;
    resetFileProgress();
    setState("loading");
    try {
      tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, {
        progress_callback: onFileProgress,
      });
      seqModel = await AutoModelForSequenceClassification.from_pretrained(MODEL_ID, {
        dtype: MODEL_DTYPE,
        device: MODEL_DEVICE,
        progress_callback: onFileProgress,
      });
      // Same id resolution as the zero-shot pipeline (lowercased label map).
      const label2id = Object.fromEntries(
        Object.entries(seqModel.config.label2id || {}).map(([k, v]) => [String(k).toLowerCase(), v])
      );
      entailmentId = label2id["entailment"];
      if (entailmentId === undefined) {
        console.warn("[YTF] no 'entailment' in label2id, using 1");
        entailmentId = 1;
      }
      modelStatus.progress = 1;
      setState("ready");
      return { tokenizer, model: seqModel };
    } catch (e) {
      tokenizer = null;
      seqModel = null;
      const where = modelStatus.file
        ? ` (file ${modelStatus.file}, ${modelStatus.loaded}/${modelStatus.total} bytes overall)`
        : "";
      const msg = `${String(e?.message || e)}${where}`;
      setState("error", msg);
      console.error(`[YTF] model load failed${where}`, e);
      throw new Error(msg);
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

// Delete this model's downloaded files so the next load fetches fresh.
// Matches by model id; if nothing matches but a cache is non-empty
// (key-format drift, e.g. redirected/XET URLs), wipes that cache — this
// extension is the sole writer to its own origin caches, so that can only
// drop our own model files. Reports what it saw so the panel can show proof
// instead of silently doing nothing. Refuses while a load is in flight.
async function clearModelCache() {
  if (loadPromise) {
    throw new Error("download in progress — wait for it to finish, then redownload");
  }
  const report = { scanned: 0, removed: 0, wiped: false };
  const cacheNames = [env.cacheKey, "experimental_transformers-hash-cache"];
  if (typeof caches !== "undefined") {
    for (const name of cacheNames) {
      try {
        const cache = await caches.open(name);
        const keys = await cache.keys();
        report.scanned += keys.length;
        let matched = 0;
        for (const req of keys) {
          const url = req.url || String(req);
          if (url.includes(MODEL_ID)) {
            matched++;
            if (await cache.delete(req)) report.removed++;
          }
        }
        if (matched === 0 && keys.length > 0) {
          for (const req of keys) {
            if (await cache.delete(req)) report.removed++;
          }
          report.wiped = true;
        }
      } catch { /* ignore per-cache errors */ }
    }
  }
  tokenizer = null;
  seqModel = null;
  resetFileProgress();
  setState("idle");
  return report;
}

// Micro-batcher: collect classify requests for a short window, then run
// MANY videos in ONE forward pass (rows = videos × labels). The fixed cost
// of a session.run (graph launch + streaming 141M weights through one CPU
// thread — WASM threads are impossible here, see below) dominates for short
// titles, so bigger batches raise videos/sec several-fold at the price of a
// few-ms wait per video. Groups by identical topic lists (normally all same).
const BATCH_WINDOW_MS = 75;
const MAX_VIDEOS_PER_BATCH = 8;
let batchQueue = []; // { title, topics, resolve, reject }
let flushTimer = null;

function requestClassify(title, topics) {
  return new Promise((resolve, reject) => {
    batchQueue.push({ title, topics: topics || [], resolve, reject });
    if (batchQueue.length >= MAX_VIDEOS_PER_BATCH) {
      flushBatch();
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushBatch();
      }, BATCH_WINDOW_MS);
    }
  });
}

function decideForVideo(topics, labelTexts, entails) {
  const scores = softmax(entails);
  const order = scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]);
  const topText = labelTexts[order[0][1]];
  const confidence = order[0][0] ?? 0;
  const topic = topics.find((t) => t.name === topText)?.name ?? "other";
  const probabilities = {};
  order.forEach(([s, i]) => {
    const name = topics.find((t) => t.name === labelTexts[i])?.name;
    if (name) probabilities[name] = s ?? 0;
  });
  return { topic, confidence, probabilities };
}

async function flushBatch() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const items = batchQueue.splice(0, MAX_VIDEOS_PER_BATCH);
  if (!items.length) return;
  if (batchQueue.length && !flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushBatch();
    }, BATCH_WINDOW_MS);
  }
  try {
    const { tokenizer: tok, model } = await ensureModel();
    // Group by topic list so one batch never mixes label sets.
    const groups = new Map(); // sig -> item indices
    items.forEach((it, idx) => {
      const sig = (it.topics || []).map((t) => t.name).join("");
      if (!groups.has(sig)) groups.set(sig, []);
      groups.get(sig).push(idx);
    });
    for (const idxs of groups.values()) {
      const topics = items[idxs[0]].topics;
      if (!topics.length) {
        for (const i of idxs) items[i].reject(new Error("no topics configured"));
        continue;
      }
      // Title only (measured +7pts over Title+Channel): channel names inject
      // misleading concepts. Hypotheses use bare topic NAMEs: comma-list
      // descriptions collapse accuracy; bare names score 0.4–0.75.
      const premises = [];
      const hypotheses = [];
      for (const i of idxs) {
        const pre = `${items[i].title || "(unknown)"}`;
        for (const t of topics) {
          premises.push(pre);
          hypotheses.push(HYPOTHESIS_TEMPLATE.replace("{}", t.name));
        }
      }
      const inputs = tok(premises, { text_pair: hypotheses, padding: true, truncation: true });
      const { logits } = await model(inputs);
      const width = logits.dims[logits.dims.length - 1];
      const data = logits.data;
      const labelTexts = topics.map((t) => t.name);
      idxs.forEach((itemIdx, k) => {
        const entails = [];
        for (let j = 0; j < topics.length; j++) {
          entails.push(Number(data[(k * topics.length + j) * width + entailmentId]));
        }
        items[itemIdx].resolve(decideForVideo(topics, labelTexts, entails));
      });
    }
  } catch (e) {
    for (const it of items) it.reject(e);
  }
}

function reply(id, payload) {
  try {
    chrome.runtime.sendMessage({ type: "YTF_OFF_RESULT", id, ...payload }, () => {});
  } catch { /* ignore */ }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== "offscreen") return;
  (async () => {
    try {
      if (msg.type === "YTF_OFF_CLASSIFY") {
        const { title, topics } = msg.payload || {};
        const result = await requestClassify(title, topics || []);
        reply(msg.id, { ok: true, result });
      } else if (msg.type === "YTF_OFF_LOAD") {
        // ACK first: the download takes minutes and the worker may not
        // survive the wait. Progress/errors flow via status pushes.
        reply(msg.id, { ok: true, started: true });
        ensureModel().catch(() => {});
      } else if (msg.type === "YTF_OFF_REDOWNLOAD") {
        if (loadPromise) {
          reply(msg.id, { ok: false, error: "download in progress — wait for it to finish, then redownload" });
          return;
        }
        reply(msg.id, { ok: true, started: true });
        (async () => {
          try {
            const report = await clearModelCache();
            modelStatus.lastCleared = { ...report, at: Date.now() };
            pushStatus();
            await ensureModel();
          } catch { /* surfaced via status pushes */ }
        })();
      } else if (msg.type === "YTF_OFF_STATUS") {
        reply(msg.id, { ok: true, status: { ...modelStatus } });
      }
    } catch (e) {
      reply(msg.id, { ok: false, error: String(e?.message || e), status: { ...modelStatus } });
    }
  })();
});

// Announce readiness (the worker waits for this after creating the document)
// and publish current status in case the worker restarted mid-download.
try {
  chrome.runtime.sendMessage({ type: "YTF_OFF_READY", status: { ...modelStatus } }, () => {});
} catch { /* ignore */ }
pushStatus();
