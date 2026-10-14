// Benchmark: 100 YouTube titles through the CURRENT production strategy.
// Mirrors src/offscreen.js classifyWithModel exactly:
//   premise = title only (measured +7pts over Title+Channel),
//   hypotheses `This video is about {name}.`,
//   one batched forward pass, entailment id from config, softmax over labels.
// Run: node test/benchmark-100.js (or `bun run benchmark`)
// Exits non-zero when top-1 accuracy is below 0.60.
import { AutoTokenizer, AutoModelForSequenceClassification } from "@huggingface/transformers";
import { TOPICS, CASES } from "./cases.js";
import { runStrategy } from "./harness.js";

const MODEL_ID = "Horizon-Labs/multilingual-zeroshot-small";
const HYPOTHESIS_TEMPLATE = "This video is about {}.";
const MIN_CONFIDENCE = 0.35;

const tok = await AutoTokenizer.from_pretrained(MODEL_ID);
// q8 to mirror production weights (device doesn't change numerics, and
// node has no GPU).
const model = await AutoModelForSequenceClassification.from_pretrained(MODEL_ID, { dtype: "q8", device: "cpu" });

const r = await runStrategy({
  name: "production",
  tok,
  model,
  topics: TOPICS,
  premise: (t) => `${t}`,
  hypothesis: (n) => HYPOTHESIS_TEMPLATE.replace("{}", n),
  verbose: true,
});

console.log(`\nTop-1 accuracy: ${r.correct}/${r.n} = ${(100 * r.correct / r.n).toFixed(1)}%`);
console.log(`Gated@${MIN_CONFIDENCE} accuracy: ${r.gated[MIN_CONFIDENCE]}/${r.n}`);

if (r.correct / r.n < 0.6) process.exit(2);
