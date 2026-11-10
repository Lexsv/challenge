import { describe, expect, it, vi } from "vitest";
import { createVerificationSingleFlight } from "./verification-single-flight";
import { consoleVerificationPlan, verifyConsoleModel } from "./opencode-console-verification";
import { DEFAULT_ENDPOINTS } from "./provider-endpoints";

describe("verification action", () => {
  it("starts one mocked request immediately and rejects a second action while pending", async () => {
    let finish!: (value: unknown) => void;
    const fetcher = vi.fn(() => new Promise((resolve) => { finish = resolve; })) as unknown as typeof fetch;
    const run = createVerificationSingleFlight();
    const plan = consoleVerificationPlan("kimi-k3", DEFAULT_ENDPOINTS["opencode-console"])!;
    let status = "";
    expect(fetcher).not.toHaveBeenCalled();
    const first = run(async () => { status = await verifyConsoleModel("dummy-key", plan, fetcher); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const duplicate = await run(async () => { await verifyConsoleModel("dummy-key", plan, fetcher); });
    expect(duplicate).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    finish({ ok: true, status: 200, json: async () => ({ model: "kimi-k3", choices: [{ message: { content: "OK" } }] }) });
    expect(await first).toBe(true);
    expect(status).toContain("Model verified: kimi-k3");
    expect(fetcher).toHaveBeenCalledWith(plan.endpoint, expect.objectContaining({ method: "POST" }));
  });
  it("releases the guard after a failed action", async () => {
    const run = createVerificationSingleFlight();
    await expect(run(async () => { throw new Error("mock failure"); })).rejects.toThrow("mock failure");
    await expect(run(async () => {})).resolves.toBe(true);
  });
});
