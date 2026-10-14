// Smoke test: drive the REAL src/offscreen.js message flow + batching math
// with stubbed transformers (fake tokenizer/model, canned logits) and a
// stubbed chrome runtime. Catches wiring bugs (e.g. undefined helpers,
// bad logit indexing, broken reply routing) in milliseconds, no download.
// Run: node --test test/offscreen-smoke.js  (node test runner, not bun)
import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

const REPLIES = [];
let listener = null;
globalThis.chrome = {
  runtime: {
    getURL: (p) => `https://example.invalid/${p}`,
    onMessage: { addListener: (fn) => { listener = fn; } },
    sendMessage: (msg, cb) => {
      REPLIES.push(msg);
      if (typeof cb === "function") { try { cb(); } catch {} }
    },
  },
};

// Fake tokenizer: passes row count + premises through for the fake model.
const fakeTokenizer = (texts, opts) => ({
  __rows: Array.isArray(texts) ? texts.length : 1,
  __premises: Array.isArray(texts) ? texts : [texts],
  __pairs: opts?.text_pair,
});
const ENT_ID = 1;
// Fake model: entailment peaks deterministically per row: video k
// (10 rows) peaks at label (k * 3 + 1) % 10. Sharp logits.
const fakeModel = async (inputs) => {
  fakeModel.callCount++;
  const rows = inputs.__rows;
  const data = new Float32Array(rows * 2);
  for (let r = 0; r < rows; r++) {
    const peak = (Math.floor(r / 10) * 3 + 1) % 10;
    for (let j = 0; j < 10; j++) data[r * 2 + j] = -2 + (j === peak ? 5 : 0);
    data[r * 2 + ENT_ID] = -2 + (r % 10 === peak ? 5 : 0);
  }
  return { logits: { dims: [rows, 2], data } };
};
fakeModel.config = { label2id: { not_entailment: 0, entailment: 1 } };
fakeModel.callCount = 0;

mock.module("@huggingface/transformers", {
  exports: {
    env: { allowLocalModels: true, cacheKey: "test-cache", backends: { onnx: { wasm: {} } } },
    AutoTokenizer: { from_pretrained: async () => fakeTokenizer },
    AutoModelForSequenceClassification: { from_pretrained: async () => fakeModel },
  },
});

await import("../src/offscreen.js");
assert.equal(typeof listener, "function", "offscreen did not register a listener");

function callOffscreen(type, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const id = `smoke-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
    const check = setInterval(() => {
      const i = REPLIES.findIndex((m) => m.type === "YTF_OFF_RESULT" && m.id === id);
      if (i >= 0) {
        clearInterval(check);
        clearTimeout(timer);
        resolve(REPLIES.splice(i, 1)[0]);
      }
    }, 25);
    listener({ target: "offscreen", type, id, payload });
  });
}

const TOPICS = ["Gaming", "Tech", "Cooking", "Travel", "Music", "Education", "News", "Sports", "Comedy", "Film & TV"];
const topics = TOPICS.map((name) => ({ name, description: `${name} stuff` }));

await test("load reports ready", async () => {
  await callOffscreen("YTF_OFF_LOAD", null);
  let status = null;
  for (let i = 0; i < 100; i++) {
    const st = await callOffscreen("YTF_OFF_STATUS", null);
    if (st.status?.state === "ready" || st.status?.state === "error") {
      status = st.status;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(status?.state, "ready", "not ready: " + status?.error);
  fakeModel.callCount = 0; // exclude load + self-test calls from the batch count
});

await test("three videos form one batched call with correct mapping", async () => {
  const before = fakeModel.callCount;
  const [r0, r1, r2] = await Promise.all([
    callOffscreen("YTF_OFF_CLASSIFY", { title: "v0", topics }),
    callOffscreen("YTF_OFF_CLASSIFY", { title: "v1", topics }),
    callOffscreen("YTF_OFF_CLASSIFY", { title: "v2", topics }),
  ]);
  assert.equal(fakeModel.callCount - before, 1, "expected a single batched model call");
  const want = [1, 4, 7].map((i) => TOPICS[i]);
  const got = [r0.result.topic, r1.result.topic, r2.result.topic];
  assert.deepEqual(got, want, `mapping wrong: ${got} != ${want}`);
  for (const r of [r0, r1, r2]) {
    assert.ok(r.ok && !r.result.error, "classify failed: " + (r.result?.error || r.error));
    assert.equal(Object.keys(r.result.probabilities).length, 10, "probabilities incomplete");
  }
});

await test("status path answers", async () => {
  const st = await callOffscreen("YTF_OFF_STATUS", null);
  assert.ok(st.ok && st.status.modelId === "Horizon-Labs/multilingual-zeroshot-small");
});
