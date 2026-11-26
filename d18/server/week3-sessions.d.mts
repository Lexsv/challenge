import type { DatabaseSync } from 'node:sqlite';
export function createWeek3Routes(db:DatabaseSync, validateEvent:(...args:unknown[])=>unknown, options?:{topicProcess?:(...args:never[])=>Promise<void>}):unknown;
