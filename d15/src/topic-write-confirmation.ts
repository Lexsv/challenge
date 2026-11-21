import type { WriteReceipt } from './topic-cards.ts';

// A field write is an application acknowledgment. Its status comes from the
// saved receipt, so a second model completion cannot reverse its meaning.
export function writeConfirmation(receipts: readonly WriteReceipt[], request: string, habits = '', required: readonly string[] = []) {
  const russian = /[а-яё]/iu.test(request);
  const names: Record<string,string> = {date:'Дата', participants:'Участники', roster:'Состав', notes:'Заметки'};
  const display = (value: string | string[]) => Array.isArray(value) ? value.join(', ') || '∅' : value;
  const lines = receipts.flatMap(({topic, changes}) => changes.map(({field, status, previous, value}) => {
    const name = russian && Object.hasOwn(names, field) ? names[field] : field;
    const current = display(value);
    const title = russian ? '«' + topic + '»' : topic;
    if (status === 'already_current') {
      return russian ? `${title} — ${name}: ${current}. Это значение уже сохранено.`
        : `${title} — ${name}: ${current}. This value was already saved.`;
    }
    if (previous === undefined) {
      return russian ? `${title} — ${name}: сохранено значение «${current}».`
        : `${title} — ${name}: saved “${current}”.`;
    }
    return russian ? `${title} — ${name}: значение изменено с «${display(previous)}» на «${current}».`
      : `${title} — ${name}: changed from “${display(previous)}” to “${current}”.`;
  }));
  // Preserve explicit single-word sign-offs on generated UI acknowledgments.
  const suffix = habits.match(/(?:в конце [^.!?\n]{0,60}?(?:добавляй|пиши) слово|(?:end|finish) (?:each|every) (?:answer|response) with(?: the word)?)\s+[«"'“]?([\p{L}\p{N}_-]+)[»"'”]?[.!?]?\s*$/iu)?.[1];
  return [lines.join('\n'), ...new Set([...required, ...(suffix ? [suffix] : [])])].join(' ');
}
