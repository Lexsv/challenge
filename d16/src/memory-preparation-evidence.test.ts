import { describe, expect, it } from 'vitest';
import type { AppResult } from './app-result.ts';
import type { MemoryPreparationEvidence, MemoryPreparationEvidenceResult, PreparationBoundaryError } from './memory-preparation-evidence.ts';
import type { ContextRetrievalOutcome, MemoryOutcome } from './operation-outcomes.ts';
import type { SessionMemory } from './session-memory';

// These are explicitly synthetic claims, not verification against a real archive.
const unknownEvidence = (): MemoryPreparationEvidence => ({
  session:{state:'unknown'}, snapshot:{state:'missing'}, archiveCoverage:{state:'unknown'},
  pendingGroups:{state:'missing'}, orderingAndContinuity:{state:'unknown'},
  toolObservations:{state:'unknown'}, durableRetention:{state:'unknown'}, failure:null,
});
const transportError: PreparationBoundaryError = {
  code:'unavailable',category:'unknown',operation:'load',phase:'snapshot',transaction:'unknown',
};

describe('isolated result and preparation evidence contracts',()=>{
  it('narrows typed success and failure without a shared error class',()=>{
    const describeResult=(result:AppResult<number,PreparationBoundaryError>) => result.ok ? result.data.toFixed(1) : `${result.error.operation}:${result.error.phase}`;
    expect(describeResult({ok:true,data:2})).toBe('2.0');
    expect(describeResult({ok:false,error:transportError})).toBe('load:snapshot');
  });
  it('preserves successful not-found and incomplete retrieval outcomes',()=>{
    const notFound:AppResult<ContextRetrievalOutcome,PreparationBoundaryError>={ok:true,data:{status:'not_found',scope:'current_session',coverage:'unknown',search:'semantic'}};
    const incomplete:AppResult<ContextRetrievalOutcome,PreparationBoundaryError>={ok:true,data:{status:'incomplete',scope:'current_session'}};
    expect(notFound.ok && notFound.data.status).toBe('not_found');
    expect(incomplete.ok && incomplete.data.status).toBe('incomplete');
  });
  it('preserves unknown commit as a domain outcome, not a retryable error',()=>{
    const outcome:AppResult<MemoryOutcome,PreparationBoundaryError>={ok:true,data:{status:'unknown',category:'unknown_commit',retention:'unknown',mutation:'unknown'}};
    expect(outcome.ok && outcome.data.status).toBe('unknown');
  });
  it('distinguishes missing snapshot from failed loading and leaves other evidence unknown',()=>{
    const result:MemoryPreparationEvidenceResult={ok:true,data:unknownEvidence()};
    const failure:MemoryPreparationEvidenceResult={ok:false,error:transportError};
    expect(result.ok && result.data.snapshot.state).toBe('missing');
    expect(result.ok && result.data.pendingGroups.state).toBe('missing');
    expect(result.ok && result.data.archiveCoverage.state).toBe('unknown');
    expect(result.ok && result.data.orderingAndContinuity.state).toBe('unknown');
    expect(result.ok && result.data.toolObservations.state).toBe('unknown');
    expect(!failure.ok && failure.error.category).toBe('unknown');
  });
  it('represents mismatch and verified retention only as explicit claims',()=>{
    const evidence=unknownEvidence();
    evidence.session={state:'verified',value:{expectedId:'one',actualId:'two'},source:'session_archive'};
    evidence.durableRetention={state:'verified',value:{sessionId:'two',throughSequence:12},source:'session_archive'};
    expect(evidence.session.value.expectedId).not.toBe(evidence.session.value.actualId);
    expect(evidence.durableRetention.state).toBe('verified');
    expect(unknownEvidence().durableRetention.state).toBe('unknown');
    expect(evidence.archiveCoverage.state).toBe('unknown');
  });
  it('keeps existing SessionMemory.prepare return type intact',()=>{
    type PrepareReturn = Awaited<ReturnType<SessionMemory['prepare']>>;
    const messages:PrepareReturn=[{role:'user',content:'hello'}];
    expect(messages[0].content).toBe('hello');
  });
});
