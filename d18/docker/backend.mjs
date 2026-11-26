import { join, resolve } from 'node:path';
import { createSessionServer } from '../server/sessions.mjs';
import { FileCredentialStore } from '../server/file-credential-store.mjs';
import { createInstructionDetectorStartup } from '../server/instruction-detector-startup.ts';
import { schedulerLogger } from '../server/scheduler-log.mjs';

const directory = resolve('data');
const detector = createInstructionDetectorStartup(
  process.env.DAY18_INSTRUCTION_DETECTOR_PROVIDER || undefined,
  process.env.DAY18_INSTRUCTION_DETECTOR_MODEL || undefined,
);
const backend = createSessionServer(join(directory, 'sessions.sqlite'), {
  credentialStore: new FileCredentialStore(join(directory, 'credentials')),
  instructionDetector: detector.config,
  instructionDetectorEnabled: detector.isEnabled,
  schedulerOptions: { log: schedulerLogger(join(directory, 'logs')) },
});
backend.listen(3018, '127.0.0.1', () => console.log('Day 18 API listening on port 3018.'));
process.on('SIGUSR2', () => detector.disable());
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => { void backend.stopExecutions(); backend.close(); });
