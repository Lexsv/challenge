import type { AppResult } from './app-result.ts';
import type { MemoryGroup } from './session-memory';

/** A claim is only as trustworthy as the authority checked by its producer. */
export type Evidence<T> =
  | { state: 'verified'; value: T; source: 'session_archive' | 'memory_store' }
  | { state: 'missing' }
  | { state: 'unknown' };

export type PreparationBoundaryError = {
  code: 'unavailable' | 'conflict' | 'invalid' | 'unknown';
  category: 'database' | 'server' | 'memory_processing' | 'provider' | 'unknown';
  operation: 'load' | 'save' | 'retrieve' | 'process' | 'prepare';
  phase: 'snapshot' | 'archive' | 'topic_processing' | 'compression' | 'unknown';
  transaction: 'not_applicable' | 'not_committed' | 'committed' | 'unknown';
};

/** Contracts only: no current runtime component produces or verifies these claims. */
export type MemoryPreparationEvidence = {
  session: Evidence<{ expectedId: string; actualId: string }>;
  snapshot: Evidence<{ sessionId: string; revision: number }>;
  archiveCoverage: Evidence<{ sessionId: string; firstSequence: number; lastSequence: number }>;
  pendingGroups: Evidence<readonly MemoryGroup[]>;
  orderingAndContinuity: Evidence<{ sessionId: string; firstSequence: number; lastSequence: number }>;
  toolObservations: Evidence<{ requiredCallIds: readonly string[]; availableCallIds: readonly string[] }>;
  durableRetention: Evidence<{ sessionId: string; throughSequence: number }>;
  failure: PreparationBoundaryError | null;
};

/** Execution failures use the error branch; evidence describes successful reporting, not readiness.
 * Existing retrieval and processing domain outcomes remain separate, including unknown commit.
 */
export type MemoryPreparationEvidenceResult = AppResult<MemoryPreparationEvidence, PreparationBoundaryError>;
