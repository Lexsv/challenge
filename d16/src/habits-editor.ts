/** Exact Markdown lines are the only targets; all other text remains untouched. */
export type HabitsOperation =
  | { action: 'ADD'; newInstruction: string }
  | { action: 'UPDATE'; targetLine: string; newInstruction: string }
  | { action: 'REMOVE'; targetLine: string };

export type HabitsEditResult =
  | { ok: true; habits: string; changed: boolean }
  | { ok: false; reason: 'invalid_operation' | 'missing_target' | 'ambiguous_target' | 'duplicate' | 'conflict'; operationIndex: number };

type Line = { text: string; ending: string };

/** Narrow guard for explicit short-versus-detailed wording, not a general semantic classifier. */
export function hasDetailLevelAddConflict(habits: string, operations: readonly HabitsOperation[]): boolean {
  const short = /\b(?:short|shorter|brief|briefly|concise|concisely)\b|кратк|коротк/iu;
  const detailed = /\b(?:detail|detailed|details|thorough|thoroughly|comprehensive|elaborate|in-depth)\b|подробн|разв[её]рнут/iu;
  const rules = habits.split(/\r\n|\r|\n/).filter(line => line.startsWith('* ')).map(line => line.slice(2));
  return operations.some(op => op.action === 'ADD' && rules.some(rule => rule !== op.newInstruction &&
    ((short.test(rule) && detailed.test(op.newInstruction)) || (detailed.test(rule) && short.test(op.newInstruction)))));
}

function validInstruction(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
    && !/[\r\n\u0000-\u001f\u007f]/.test(value)
    && !/^(?:[*+-](?:\s|$)|\d+[.)]\s)/.test(value);
}

function validTarget(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('* ') && value.slice(2).trim().length > 0
    && !/[\r\n\u0000-\u001f\u007f]/.test(value);
}

/** Validate the entire batch against the original text before returning a new value. */
export function editHabits(habits: string, operations: readonly HabitsOperation[]): HabitsEditResult {
  const lines: Line[] = [];
  const parts = habits.split(/(\r\n|\r|\n)/);
  for (let i = 0; i < parts.length; i += 2) lines.push({ text: parts[i], ending: parts[i + 1] ?? '' });
  const existing = new Map<string, number[]>();
  lines.forEach((line, index) => {
    if (line.text.startsWith('* ')) existing.set(line.text, [...(existing.get(line.text) ?? []), index]);
  });
  const touched = new Set<string>();
  const proposed = new Set<string>();
  const changes = new Map<number, string | null>();
  const additions: string[] = [];

  for (const [operationIndex, operation] of operations.entries()) {
    const reject = (reason: Extract<HabitsEditResult, {ok:false}>['reason']): HabitsEditResult => ({ok:false,reason,operationIndex});
    if (!operation || !['ADD','UPDATE','REMOVE'].includes(operation.action)) return reject('invalid_operation');
    if ((operation.action === 'ADD' || operation.action === 'UPDATE') && !validInstruction(operation.newInstruction)) return reject('invalid_operation');
    let targetIndex: number | undefined;
    if (operation.action !== 'ADD') {
      if (!validTarget(operation.targetLine)) return reject('invalid_operation');
      if (touched.has(operation.targetLine)) return reject('conflict');
      const matches = existing.get(operation.targetLine) ?? [];
      if (!matches.length) return reject('missing_target');
      if (matches.length !== 1) return reject('ambiguous_target');
      touched.add(operation.targetLine);
      targetIndex = matches[0];
    }
    if (operation.action === 'REMOVE') { changes.set(targetIndex!, null); continue; }
    const line = `* ${operation.newInstruction}`;
    if (proposed.has(line)) return reject('conflict');
    if (existing.has(line) && (operation.action === 'ADD' || line !== operation.targetLine)) return reject('duplicate');
    proposed.add(line);
    if (operation.action === 'ADD') additions.push(line);
    else changes.set(targetIndex!, line);
  }

  // Do not let a new value depend on another operation's original target.
  for (const line of proposed) {
    if (touched.has(line)) {
      const index=existing.get(line)?.[0];
      if (index !== undefined && changes.get(index) !== line) return {ok:false,reason:'conflict',operationIndex:operations.findIndex(op=>op.action!=='REMOVE' && `* ${op.newInstruction}`===line)};
    }
  }
  let result = lines.map((line,index) => changes.has(index)
    ? changes.get(index) === null ? '' : changes.get(index)! + line.ending
    : line.text + line.ending).join('');
  const ending = habits.match(/\r\n|\r|\n/)?.[0] ?? '\n';
  const hadFinalEnding = /(?:\r\n|\r|\n)$/.test(result);
  for (const line of additions) {
    if (result && !/(?:\r\n|\r|\n)$/.test(result)) result += ending;
    result += line + (hadFinalEnding ? ending : '');
  }
  return {ok:true,habits:result,changed:result!==habits};
}
