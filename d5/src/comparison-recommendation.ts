import type { Run, Attempt } from "./models";
import { last } from "./models";
import { comparisonGroupKey } from "./comparison-group";
import { requestCost, formatCost } from "./request-cost";
import { seconds } from "./result-format";
import type { ComparisonRow } from "./comparison-report";
import type { ComparisonDetails } from "./comparison-report-pdf";

export const insufficientRecommendation = "Недостаточно сопоставимых оценённых результатов, чтобы определить лучшую, худшую или наиболее выгодную конфигурацию. Размеры моделей и типы задач не зафиксированы, поэтому нельзя определить, когда достаточно меньшей модели или необходима более мощная.";

/** Compare latest completed participant attempts on identical questions and references. */
export function comparisonRecommendation(runs: readonly Run[], rows: readonly ComparisonRow[], details: ComparisonDetails): string {
  type Sample = { correct: boolean | undefined; attempt: Attempt; cost?: ReturnType<typeof requestCost>; started: number };
  const groups = new Map<string, Map<string, Sample>>();
  const rowByKey = new Map(rows.map((row) => [row.key, row]));
  for (const run of runs) {
    if (!run.snapshot.question.trim() || !run.snapshot.reference.trim()) continue;
    const judgments = run.evaluationStatus === "completed" ? last(run.evaluations)?.judgments : undefined;
    for (const result of run.results) {
      const attempt = last(result.attempts);
      const verdict = judgments?.find((j) => j.resultId === result.id)?.verdict;
      if (!attempt || !["succeeded", "failed", "timed-out", "incomplete"].includes(attempt.status)) continue;
      const expert = run.snapshot.experts.find((entry) => entry.id === result.expert.id);
      if (!expert) continue;
      const key = comparisonGroupKey(run, result, attempt, expert);
      if (!rowByKey.has(key)) continue;
      const question = JSON.stringify([run.snapshot.question, run.snapshot.reference]);
      const samples = groups.get(key) ?? new Map<string, Sample>();
      const previous = samples.get(question);
      const correct = attempt.status !== "succeeded" ? false : verdict === "correct" ? true : verdict === "incorrect" ? false : undefined;
      if (!previous || run.started >= previous.started) samples.set(question, { correct, attempt, cost: requestCost(attempt, expert.provider), started: run.started });
      groups.set(key, samples);
    }
  }
  let bestPair: { a: string; b: string; questions: string[]; difference: number } | undefined;
  const keys = [...groups.keys()];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const questions = [...groups.get(keys[i])!.keys()].filter((question) => groups.get(keys[i])!.get(question)?.correct !== undefined && groups.get(keys[j])!.get(question)?.correct !== undefined);
    const hasEvaluation = questions.some((q) => groups.get(keys[i])!.get(q)!.attempt.status === "succeeded" || groups.get(keys[j])!.get(q)!.attempt.status === "succeeded");
    const difference = Math.abs(questions.filter((q) => groups.get(keys[i])!.get(q)!.correct).length - questions.filter((q) => groups.get(keys[j])!.get(q)!.correct).length);
    if (hasEvaluation && questions.length >= 2 && (!bestPair || questions.length > bestPair.questions.length || (questions.length === bestPair.questions.length && difference > bestPair.difference))) bestPair = { a: keys[i], b: keys[j], questions, difference };
  }
  if (!bestPair) return insufficientRecommendation;
  const sampleSet = (key: string) => bestPair!.questions.map((question) => groups.get(key)!.get(question)!);
  const a = sampleSet(bestPair.a), b = sampleSet(bestPair.b);
  const score = (samples: Sample[]) => samples.filter((sample) => sample.correct).length;
  const label = (key: string) => {
    const row = rowByKey.get(key)!;
    const detail = details.get(key);
    const parameters = detail?.parameters.filter((value) => value !== "None recorded").join(", ") || "без параметров";
    const name = detail?.experts.join(", ") || "Эксперт";
    const safeName = name.replace(/(?:oc_sk_|sk-|ghp_|opencode-)[a-zA-Z0-9_-]{8,}|bearer\s+\S+/gi, "[скрыто]");
    const safeModel = row.model.replace(/(?:oc_sk_|sk-|ghp_)[a-zA-Z0-9_-]{8,}|bearer\s+\S+/gi, "[скрыто]");
    const clean = `${safeName} (${safeModel}; ${parameters})`;
    return clean.length > 200 ? `${clean.slice(0, 199)}…` : clean;
  };
  const aLabel = label(bestPair.a), bLabel = label(bestPair.b);
  const n = bestPair.questions.length;
  const performance = score(a) === score(b)
    ? `На ${n} общих вопросах конфигурации ${aLabel} и ${bLabel} показали одинаковый результат: ${score(a)} / ${n} подтверждённых правильных ответов.`
    : `На ${n} общих вопросах лучший результат показала конфигурация ${score(a) > score(b) ? aLabel : bLabel} (${Math.max(score(a), score(b))} / ${n} правильных ответов), худший — ${score(a) > score(b) ? bLabel : aLabel} (${Math.min(score(a), score(b))} / ${n}).`;
  const avg = (samples: Sample[]) => { const successful = samples.filter(({ attempt }) => attempt.status === "succeeded"); return successful.length > 0 && successful.every(({ attempt }) => Number.isFinite(attempt.ms) && attempt.ms >= 0) ? seconds(successful.reduce((sum, { attempt }) => sum + attempt.ms, 0) / successful.length).replace(/ s$/, " с") : "нет данных"; };
  const tokens = (samples: Sample[]) => samples.every(({ attempt }) => Number.isFinite(attempt.usage?.input) && Number.isFinite(attempt.usage?.output)) ? samples.reduce((sum, { attempt }) => sum + attempt.usage!.input! + attempt.usage!.output!, 0).toLocaleString("ru-RU") : "нет данных";
  const efficiency = (samples: Sample[]) => samples.every((sample) => sample.cost) && score(samples) > 0 ? samples.reduce((sum, sample) => sum + sample.cost!.usd, 0) / score(samples) : undefined;
  const aCost = efficiency(a), bCost = efficiency(b);
  const estimated = [...a, ...b].some((sample) => sample.cost?.estimated || sample.cost?.source === "catalog");
  const costText = aCost === undefined || bCost === undefined ? "Недостаточно данных о стоимости и правильных ответах для оценки выгодности." : Math.abs(aCost - bCost) < 1e-12 ? `Стоимость правильного ответа одинакова: ${formatCost(aCost)}${estimated ? " с учётом оценочных цен" : ""}.` : `На этих вопросах выгоднее ${aCost < bCost ? aLabel : bLabel}: ${formatCost(Math.min(aCost, bCost))} против ${formatCost(Math.max(aCost, bCost))} за правильный ответ${estimated ? " с учётом оценочных цен" : ""}${score(a) === score(b) ? ", при одинаковом числе правильных ответов" : (aCost < bCost ? score(a) < score(b) : score(b) < score(a)) ? "; другая конфигурация дала больше правильных ответов" : ""}.`;
  const first = score(a) >= score(b) ? a : b, second = first === a ? b : a;
  return `${performance} Среднее время успешных ответов — ${avg(first)} и ${avg(second)}, всего использовано ${tokens(first)} и ${tokens(second)} токенов соответственно. ${costText} Размеры моделей и типы задач не зафиксированы, поэтому нельзя определить, когда достаточно меньшей модели или необходима более мощная.`;
}
