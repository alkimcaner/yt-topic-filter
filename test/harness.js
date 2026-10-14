// Shared harness: run one strategy over CASES, return full stats.
// A strategy = { name, tok, model, topics, premise(title, channel),
// hypothesis(topicName), verbose }. Scoring mirrors production exactly.
import { CASES, TOPICS as WANT_TOPICS } from "./cases.js";

export const MIN_CONFIDENCE = 0.35;
const SWEEP = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6];

export const softmax = (a) => {
  const m = Math.max(...a);
  const exps = a.map((x) => Math.exp(x - m));
  const sum = exps.reduce((x, y) => x + y, 0) || 1;
  return exps.map((e) => e / sum);
};

export async function runStrategy({ name, tok, model, topics, premise, hypothesis, verbose, canon = (x) => x }) {
  const label2id = Object.fromEntries(
    Object.entries(model.config.label2id || {}).map(([k, v]) => [String(k).toLowerCase(), v])
  );
  const entailmentId = label2id["entailment"] ?? 1;
  const n = CASES.length;
  let correct = 0;
  let confHit = 0;
  let confMiss = 0;
  const perTopic = Object.fromEntries(WANT_TOPICS.map((t) => [t, { ok: 0, n: 0 }]));
  const perCase = []; // {want, top, conf} for threshold sweeps
  const misses = [];
  const t0 = performance.now();

  for (const [title, channel, want] of CASES) {
    const pre = premise(title, channel);
    const hyps = topics.map(hypothesis);
    const inputs = tok(new Array(topics.length).fill(pre), { text_pair: hyps, padding: true, truncation: true });
    const { logits } = await model(inputs);
    const width = logits.dims[logits.dims.length - 1];
    const ent = topics.map((_, i) => Number(logits.data[i * width + entailmentId]));
    const scores = softmax(ent);
    const order = scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]);
    const top = canon(topics[order[0][1]]);
    const conf = order[0][0];
    perTopic[want].n++;
    perCase.push({ want, top, conf });
    if (top === want) {
      correct++;
      confHit += conf;
      perTopic[want].ok++;
    } else {
      confMiss += conf;
      misses.push([want, title, top, conf, topics[order[1][1]], order[1][0]]);
    }
  }

  const gated = {};
  for (const k of SWEEP) {
    gated[k] = perCase.filter((c) => (c.conf < k ? "other" : c.top) === c.want).length;
  }
  const r = {
    name, n, correct,
    acc: correct / n,
    gated,
    otherAt: Object.fromEntries(SWEEP.map((k) => [k, perCase.filter((c) => c.conf < k).length])),
    confHit: confHit / Math.max(1, correct),
    confMiss: confMiss / Math.max(1, n - correct),
    perTopic, misses,
    secs: (performance.now() - t0) / 1000,
  };

  console.log(`\n[${name}] top-1 ${correct}/${n} (${(100 * r.acc).toFixed(1)}%)  ` +
    `hits@${r.confHit.toFixed(3)} miss@${r.confMiss.toFixed(3)}  ${r.secs.toFixed(0)}s`);
  console.log(`  gated: ` + SWEEP.map((k) => `${k}:${gated[k]}/${n}(o${r.otherAt[k]})`).join(" "));
  console.log(`  per-topic: ` + WANT_TOPICS.map((t) => `${t.split(" ")[0]}:${perTopic[t].ok}/${perTopic[t].n}`).join(" "));
  if (verbose) {
    for (const [want, title, top, conf, second, s2] of misses) {
      console.log(`  MISS [${want}] "${title}" => ${top} ${conf.toFixed(3)} (2nd ${second} ${s2.toFixed(3)})`);
    }
  }
  return r;
}
