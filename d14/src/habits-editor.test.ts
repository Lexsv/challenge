import { describe, expect, it } from 'vitest';
import { editHabits, hasDetailLevelAddConflict, type HabitsOperation } from './habits-editor';

describe('narrow ADD conflict guard',()=>{
  it('detects opposing English and Russian detail instructions',()=>{
    expect(hasDetailLevelAddConflict('* Keep answers short and concise.\n* Отвечай подробно.',[{action:'ADD',newInstruction:'Отвечай подробно.'}])).toBe(true);
    expect(hasDetailLevelAddConflict('* Provide detailed explanations.\n* Отвечай кратко.',[{action:'ADD',newInstruction:'Отвечай кратко.'}])).toBe(true);
  });
  it('permits unrelated additions and preserves UPDATE and REMOVE behavior',()=>{
    expect(hasDetailLevelAddConflict('* Keep answers short.\n* Use examples.',[{action:'ADD',newInstruction:'Use examples.'}])).toBe(false);
    expect(hasDetailLevelAddConflict('* Provide detailed answers.',[{action:'UPDATE',targetLine:'* Keep answers short.',newInstruction:'Provide detailed answers.'}])).toBe(false);
    expect(hasDetailLevelAddConflict('* Keep answers short.',[{action:'REMOVE',targetLine:'* Provide detailed answers.'}])).toBe(false);
  });
  it('checks the resulting rules, including multiple additions',()=>{
    expect(hasDetailLevelAddConflict('* Always respond in Russian.\n* Answer briefly.\n* Give detailed explanations.',[{action:'ADD',newInstruction:'Answer briefly.'},{action:'ADD',newInstruction:'Give detailed explanations.'}])).toBe(true);
    expect(hasDetailLevelAddConflict('* Always respond in Russian.\n* Give detailed explanations.',[{action:'REMOVE',targetLine:'* Answer briefly.'},{action:'ADD',newInstruction:'Give detailed explanations.'}])).toBe(false);
  });
});

describe('editHabits', () => {
  it('adds, updates, and removes independent rules', () => {
    const original='* Always answer briefly.\n* Always use Russian.\nlegacy text';
    const operations:HabitsOperation[]=[
      {action:'UPDATE',targetLine:'* Always answer briefly.',newInstruction:'Always answer in detail.'},
      {action:'REMOVE',targetLine:'* Always use Russian.'},
      {action:'ADD',newInstruction:'Use examples.'},
    ];
    expect(editHabits(original,operations)).toEqual({ok:true,changed:true,habits:'* Always answer in detail.\nlegacy text\n* Use examples.'});
    expect(original).toBe('* Always answer briefly.\n* Always use Russian.\nlegacy text');
  });
  it('handles empty input, unchanged updates, and empty batches', () => {
    expect(editHabits('',[{action:'ADD',newInstruction:'Use examples.'}])).toEqual({ok:true,changed:true,habits:'* Use examples.'});
    expect(editHabits('* One',[])).toEqual({ok:true,changed:false,habits:'* One'});
    expect(editHabits('* One',[{action:'UPDATE',targetLine:'* One',newInstruction:'One'}])).toEqual({ok:true,changed:false,habits:'* One'});
  });
  it('rejects duplicate additions and updates to an existing line', () => {
    expect(editHabits('* One',[{action:'ADD',newInstruction:'One'}])).toMatchObject({ok:false,reason:'duplicate'});
    expect(editHabits('* One\n* Two',[{action:'UPDATE',targetLine:'* One',newInstruction:'Two'}])).toMatchObject({ok:false,reason:'duplicate'});
  });
  it('requires an exact unique target', () => {
    expect(editHabits('* One',[{action:'REMOVE',targetLine:'* one'}])).toMatchObject({ok:false,reason:'missing_target'});
    expect(editHabits('* One\nlegacy\n* One',[{action:'REMOVE',targetLine:'* One'}])).toMatchObject({ok:false,reason:'ambiguous_target'});
    expect(editHabits('* One  ',[{action:'REMOVE',targetLine:'* One  '}])).toEqual({ok:true,changed:true,habits:''});
  });
  it('rejects conflicting operations without applying an earlier edit', () => {
    const original='* One\n* Two';
    expect(editHabits(original,[{action:'UPDATE',targetLine:'* One',newInstruction:'New'},{action:'REMOVE',targetLine:'* One'}])).toEqual({ok:false,reason:'conflict',operationIndex:1});
    expect(editHabits(original,[{action:'ADD',newInstruction:'Three'},{action:'ADD',newInstruction:'Three'}])).toEqual({ok:false,reason:'conflict',operationIndex:1});
    expect(editHabits(original,[{action:'REMOVE',targetLine:'* Two'},{action:'ADD',newInstruction:'Two'}])).toMatchObject({ok:false});
    expect(original).toBe('* One\n* Two');
  });
  it.each([
    ['legacy\r\n* One\r\n* Two\r\n','legacy\r\n* New\r\n* Two\r\n* Added\r\n'],
    ['legacy\n* One\n* Two','legacy\n* New\n* Two\n* Added'],
    ['legacy\r* One\r* Two','legacy\r* New\r* Two\r* Added'],
  ])('preserves line endings and unrelated legacy text', (original,expected) => {
    expect(editHabits(original,[{action:'UPDATE',targetLine:'* One',newInstruction:'New'},{action:'ADD',newInstruction:'Added'}])).toEqual({ok:true,changed:true,habits:expected});
  });
  it('preserves mixed original line endings for untouched lines', () => {
    expect(editHabits('legacy\r\n* One\nmore\r* Two',[{action:'REMOVE',targetLine:'* One'}])).toEqual({ok:true,changed:true,habits:'legacy\r\nmore\r* Two'});
  });
  it.each(['',' ',' One','One ','One\nTwo','One\rTwo','* One','- One','1. One','\tOne'])('rejects malformed instruction %j', value => {
    expect(editHabits('',[{action:'ADD',newInstruction:value}])).toMatchObject({ok:false,reason:'invalid_operation'});
  });
  it('rejects a malformed or missing later operation atomically', () => {
    const original='* One\nlegacy';
    expect(editHabits(original,[{action:'ADD',newInstruction:'Valid'},{action:'UPDATE',targetLine:'* Missing',newInstruction:'Other'}])).toEqual({ok:false,reason:'missing_target',operationIndex:1});
    expect(editHabits(original,[{action:'REMOVE',targetLine:'* One'},{action:'ADD',newInstruction:'bad\nvalue'}])).toEqual({ok:false,reason:'invalid_operation',operationIndex:1});
    expect(original).toBe('* One\nlegacy');
  });
});
