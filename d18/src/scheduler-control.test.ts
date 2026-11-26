import { afterEach, describe, expect, it, vi } from "vitest";
import { changeScheduling } from "./scheduler-api";

const task = {id: "fixture", revision: 2, updated_at: 10};
const resumed = {...task, updated_at: 11, schedulingState: "Running", status: "Running", metrics: {active: 1}};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Scheduler control confirmation", () => {
  it("sends one conditional Continue and confirms an active execution can keep running", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({...resumed, executionActive: true}));
    vi.stubGlobal("fetch", fetch);
    const result = await changeScheduling(task, "resume");
    expect(result.executionActive).toBe(true);
    expect(fetch.mock.calls).toHaveLength(1);
    expect(fetch.mock.calls[0]).toMatchObject(["/api/scheduler/tasks/fixture/resume", {
      method: "POST", headers: {"If-Match": '"2-10"'},
    }]);
  });

  it.each([
    [resumed, true],
    [{...resumed, revision: 3}, false],
    [{...resumed, updated_at: 10}, false],
    [{...resumed, status: "Requires review"}, false],
    [{...resumed, schedulingState: "Paused"}, false],
  ] as const)("reconciles a lost response against persisted state %j", async (row, success) => {
    const aborted = AbortSignal.abort(new DOMException("Timeout", "TimeoutError"));
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(aborted);
    const fetch = vi.fn().mockRejectedValueOnce(aborted.reason).mockResolvedValueOnce(Response.json([row]));
    vi.stubGlobal("fetch", fetch);
    const confirmation = changeScheduling(task, "resume");
    if (success) await expect(confirmation).resolves.toMatchObject({schedulingState: "Running", executionActive: true});
    else await expect(confirmation).rejects.toThrow();
    expect(fetch.mock.calls.map(([path, init]) => [path, init.method])).toEqual([
      ["/api/scheduler/tasks/fixture/resume", "POST"], ["/api/scheduler/tasks", "GET"],
    ]);
  });

  it("preserves a genuine review rejection", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({error: "Review the uncertain execution before enabling scheduling."}, {status: 409}));
    vi.stubGlobal("fetch", fetch);
    await expect(changeScheduling(task, "resume")).rejects.toThrow("Review the uncertain execution");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
