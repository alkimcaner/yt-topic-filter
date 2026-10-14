// Strategy matrix: run candidate prompt/label/premise variants over CASES.
// Usage: node test/strategies.js batch1|batch2
// Batch 1: templates + premises (no user-facing changes).
// Batch 2: label renames + ensembles (may change defaults).
import { AutoTokenizer, AutoModelForSequenceClassification } from "@huggingface/transformers";
import { TOPICS } from "./cases.js";
import { runStrategy, softmax } from "./harness.js";

const MODEL_ID = "Horizon-Labs/multilingual-zeroshot-small";
const META = (t, c) => `Title: ${t}. Channel: ${c}.`;
const NATURAL = (t, c) => `"${t}" by ${c}`;
const TITLE_ONLY = (t) => `${t}`;

const TPL_VIDEO = (n) => `This video is about ${n}.`;
const TPL_TEXT = (n) => `This text is about ${n}.`;
const TPL_TOPIC = (n) => `The topic of this video is ${n}.`;
const TPL_CAT = (n) => `This video is in the category ${n}.`;

const RENAMED = ["Gaming", "Tech", "Cooking", "Travel", "Music", "Education", "News", "Sports", "Comedy sketches and stand-up", "Movies"];
const RENAMED_MAP = { "Comedy sketches and stand-up": "Comedy", "Movies": "Film & TV" };
// map strategy label back to default topic for scoring
const canon = (label) => RENAMED_MAP[label] ?? label;

const tok = await AutoTokenizer.from_pretrained(MODEL_ID);
const model = await AutoModelForSequenceClassification.from_pretrained(MODEL_ID, { dtype: "q8", device: "cpu" });

const batch = process.argv[2] || "batch1";
const results = [];

// Ensemble/fusion runner: average softmax scores across K hypothesis sets.
async function runEnsemble(name, sets) {
  const label2id = Object.fromEntries(
    Object.entries(model.config.label2id || {}).map(([k, v]) => [String(k).toLowerCase(), v])
  );
  const E = label2id["entailment"] ?? 1;
  const { CASES } = await import("./cases.js");
  let correct = 0;
  const t0 = performance.now();
  for (const [title, channel, want] of CASES) {
    const pre = title;
    const allScores = TOPICS.map(() => 0);
    for (const hyps of sets.map((fn) => TOPICS.map(fn))) {
      const inputs = tok(new Array(TOPICS.length).fill(pre), { text_pair: hyps, padding: true, truncation: true });
      const { logits } = await model(inputs);
      const W = logits.dims[logits.dims.length - 1];
      const ent = TOPICS.map((_, i) => Number(logits.data[i * W + E]));
      softmax(ent).forEach((s, i) => { allScores[i] += s / sets.length; });
    }
    const top = allScores.indexOf(Math.max(...allScores));
    if (TOPICS[top] === want) correct++;
  }
  const r = { name, correct, n: CASES.length, acc: correct / CASES.length, secs: (performance.now() - t0) / 1000 };
  console.log(`\n[${name}] top-1 ${correct}/${r.n} (${(100 * r.acc).toFixed(1)}%)  ${r.secs.toFixed(0)}s`);
  results.push(r);
  return r;
}

if (batch === "batch1") {
  const base = { tok, model, topics: TOPICS, premise: META, verbose: false };
  results.push(await runStrategy({ ...base, name: "S0 baseline", hypothesis: TPL_VIDEO }));
  results.push(await runStrategy({ ...base, name: "S1 template=text", hypothesis: TPL_TEXT }));
  results.push(await runStrategy({ ...base, name: "S2 template=topic-of", hypothesis: TPL_TOPIC }));
  results.push(await runStrategy({ ...base, name: "S3 template=category", hypothesis: TPL_CAT }));
  results.push(await runStrategy({ ...base, name: "S4 premise=title-only", premise: TITLE_ONLY, hypothesis: TPL_VIDEO }));
  results.push(await runStrategy({ ...base, name: "S5 premise=natural", premise: NATURAL, hypothesis: TPL_VIDEO }));
} else {
  const base = { tok, model, premise: TITLE_ONLY, verbose: false };
  // rename run needs canon mapping: wrap hypothesis/labels via custom topics + remap in miss display only;
  // scoring compares strategy labels to want, so pass a remapped topics list via hypothesis indirection:
  const r6 = await runStrategy({ ...base, name: "S6 rename Movies/Comedy+", topics: RENAMED, hypothesis: TPL_VIDEO, canon });
  // recount with canon mapping for a fair number:
  results.push(r6);
  results.push(await runEnsemble("S7 ensemble video+text", [TPL_VIDEO, TPL_TEXT]));
  results.push(await runEnsemble("S8 ensemble video+topic", [TPL_VIDEO, TPL_TOPIC]));
}

console.log("\n=== SUMMARY ===");
for (const r of results) {
  console.log(`${r.name}: ${r.correct}/${r.n} (${(100 * r.acc).toFixed(1)}%)${r.gated ? ` gated@0.35=${r.gated["0.35"]}` : ""} ${r.secs.toFixed(0)}s`);
}
