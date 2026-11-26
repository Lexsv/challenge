import type { WorkerTemplate } from "./worker-ui";
export type WorkerDocument = {
  schemaVersion: 1 | 2;
  allowBack?: boolean;
  steps: (
    | { id: string; type: "action"; prompt: string; evaluation?: {kind:'acceptance_criteria';criteria:string} }
    | {
        id: string;
        type: "question";
        prompt: string;
        options: { id: string; text: string }[];
        evaluation?: {kind:'correct_option';optionId:string;criteria:string};
      }
  )[];
};
export type WorkerRecord = {
  id: string;
  name: string;
  description: string;
  rules: string;
  document: WorkerDocument;
  version: number;
  createdAt?: number;
  updatedAt?: number;
};
export type WorkerSession = {
  id: string;
  name: string;
  profileId: string;
  templateId: string | null;
  templateVersion: number;
  templateSnapshot: WorkerRecord;
  updatedAt?: number;
  state: string;
  stepIndex: number;
  attempt: number;
  revision: number;
};
export type WorkerAction = 'start' | 'next' | 'back' | 'retry' | 'continue' | 'complete' | 'submit' | 'correct' | 'validate' | 'quiz_next' | 'quiz_back' | 'try_again';
export type WorkerActionCommand = { requestId: string; expectedRevision: number; action: WorkerAction; payload: Record<string, unknown> };
export type WorkerStartCommand = WorkerActionCommand;
export type WorkerSubmission = {stepId:string;stepIndex:number;visit:number;attempt:number;result:{type:'question';optionId:string}|{type:'action';status:'completed'}|{type:'action';status:'problem';reason:string}};
export type QuizReport = {total:number;correct:number;incorrect:number;percentage:number;questions:{stepId:string;prompt:string;selected:string;correct:string;passed:boolean}[]};
export type WorkerStatus = { validationPending?: boolean; quizReport?: QuizReport; session: WorkerSession; availableActions: WorkerAction[]; resolvedSteps: number; totalSteps: number; completion: 'passed' | 'completed_with_errors' | null; results?: (WorkerSubmission|null)[]; submissions?: WorkerSubmission[]; evaluation?: {success:boolean;reason:string;errorCount:number;findings:{stepId:string;passed:boolean;reason:string;evidence:string}[]} | null };
export async function getWorkerStatus(id: string): Promise<WorkerStatus> {
  const response = await fetch(`/api/worker-sessions/${encodeURIComponent(id)}/status`);
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new WorkerActionError(typeof body.code === 'string' ? body.code : 'storage_failure', 'Worker status could not be loaded.'); }
  return response.json();
}
export type WorkerActionResult = { status: 'applied'; requestId: string; replayed: boolean; historical: boolean; result: { state: string; stepIndex: number; attempt: number; revision: number } };
export class WorkerActionError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
export const getWorkerSession = async (id: string): Promise<WorkerSession> => request(`/api/worker-sessions/${encodeURIComponent(id)}`);
export async function sendWorkerAction(id: string, command: WorkerActionCommand): Promise<WorkerActionResult> {
  const response = await fetch(`/api/worker-sessions/${encodeURIComponent(id)}/actions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
  });
  const body = await response.json();
  if (!response.ok) throw new WorkerActionError(typeof body.code === 'string' ? body.code : 'unknown_outcome', 'Worker action could not be confirmed.');
  if (body.status !== 'applied' || body.requestId !== command.requestId || typeof body.historical !== 'boolean') throw new WorkerActionError('unknown_outcome', 'Worker action could not be confirmed.');
  return body as WorkerActionResult;
}
async function request<T>(path: string, init?: RequestInit):Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok)
    throw Error(
      response.status === 409
        ? "This template changed. Reload and try again."
        : response.status === 404
          ? "The selected item no longer exists."
          : "Could not save or load Worker data.",
    );
  return response.json();
}
export const isQuizDocument = (doc?: WorkerDocument) =>
  doc?.schemaVersion === 2 &&
  doc.steps.length > 0 &&
  doc.steps.every((step) => step.type === "question");
export async function listWorkerRecords(editor = false): Promise<WorkerRecord[]> {
  const records = await request<WorkerRecord[]>("/api/worker-templates");
  const quizzes = records.filter((record) => isQuizDocument(record.document));
  return editor
    ? Promise.all(
        quizzes.map((record) =>
          request<WorkerRecord>(`/api/worker-templates/${encodeURIComponent(record.id)}/editor`),
        ),
      )
    : quizzes;
}
export async function retryQuizSession(
  id: string,
  command: WorkerActionCommand,
): Promise<WorkerSession> {
  const response = await fetch(`/api/worker-sessions/${encodeURIComponent(id)}/attempts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: command.requestId,
      expectedRevision: command.expectedRevision,
    }),
  });
  const body = await response.json();
  if (!response.ok)
    throw new WorkerActionError(
      body.code ?? "unknown_outcome",
      "The new attempt could not be confirmed.",
    );
  return body;
}

export function renameWorkerSession(id: string, name: string): Promise<WorkerSession> {
  return request(`/api/worker-sessions/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
  });
}
export async function deleteWorkerSession(id: string): Promise<void> {
  await request(`/api/worker-sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export const listWorkerSessions = async (): Promise<WorkerSession[]> =>
  request("/api/worker-sessions");
export const createWorkerSession = async (
  name: string,
  profileId: string,
  templateId: string,
): Promise<WorkerSession> =>
  request("/api/worker-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, profileId, templateId }),
  });
export const workerFromRecord = (r: WorkerRecord): WorkerTemplate => ({
  id: r.id,
  name: r.name,
  description: r.description,
  rules: r.rules,
  version: r.version,
  document: r.document,
  correctOptionIds: r.document.steps.map(step => step.type === 'question' ? step.evaluation?.optionId ?? '' : ''),
  steps: r.document.steps
    .map((s) =>
      s.type === "question"
        ? `${s.prompt} ${s.options.map((o, i) => `${String.fromCharCode(65 + i)}) ${o.text}`).join(" ")}`
        : s.prompt,
    )
    .join("\n"),
});
export const workerDocument = (steps: string): WorkerDocument => ({
  schemaVersion: 1,
  steps: steps
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line, i) => {
      const parts = line.split(/ (?=[A-Z]\) )/);
      if (parts.length === 1)
        return { id: `step-${i + 1}`, type: "action" as const, prompt: line };
      if (
        parts.length < 3 ||
        parts.length > 5 ||
        parts
          .slice(1)
          .some(
            (part, n) =>
              !part.startsWith(`${String.fromCharCode(65 + n)}) `) ||
              !part.slice(3).trim(),
          )
      )
        throw Error(
          "Questions need two to four choices, labelled A) through D).",
        );
      return {
        id: `step-${i + 1}`,
        type: "question" as const,
        prompt: parts[0],
        options: parts
          .slice(1)
          .map((text, n) => ({ id: `option-${n + 1}`, text: text.slice(3) })),
      };
    }),
});
export function editorDocument(worker: WorkerTemplate): WorkerDocument {
  const original = worker.document;
  if (!original) return workerDocument(worker.steps);
  const previous = workerFromRecord({
    ...worker,
    version: worker.version ?? 1,
    document: original,
  }).steps;
  if (worker.steps === previous) return original;
  const oldLines = previous.split(/\r?\n/);
  const newLines = worker.steps.split(/\r?\n/).filter((line) => line.trim());
  const parsed = workerDocument(worker.steps);
  return {
    ...parsed,
    steps: parsed.steps.map((step, i) => (newLines[i] === oldLines[i] ? original.steps[i] : step)),
  };
}

export async function saveWorker(worker: WorkerTemplate) {
  const editing = worker.version !== undefined;
  let document=editorDocument(worker);
  if(worker.document?.schemaVersion===2){
    const answers=worker.correctOptionIds ?? [];
    document={...document,schemaVersion:2,...(worker.document.allowBack===undefined?{}:{allowBack:worker.document.allowBack}),steps:document.steps.map((step,index)=>{
      if(step.type!=='question')throw Error('Each quiz question needs two to four choices.');
      const option=step.options.find(item=>item.id===answers[index]);
      if(!option)throw Error(`Select the correct answer for question ${index+1}.`);
      const original=step.evaluation;
      const criteria=original?.optionId===option.id ? original.criteria : `The correct answer is ${option.text}.`;
      return {...step,evaluation:{kind:'correct_option' as const,optionId:option.id,criteria}};
    })};
  }
  const body = {
    name: worker.name,
    description: worker.description,
    rules: worker.rules,
    document,
    ...(editing ? { expectedVersion: worker.version } : {}),
  };
  return workerFromRecord(
    await request(
      editing
        ? `/api/worker-templates/${encodeURIComponent(worker.id)}`
        : "/api/worker-templates",
      {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  );
}
export async function deleteWorker(id: string) {
  await request(`/api/worker-templates/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
