// The timer discovers work. Only the scheduled-task repository can claim it.
export function startScheduler(
  tasks,
  executeOccurrence,
  { pollMs = 1000, log } = {},
) {
  if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 2147483647)
    throw new RangeError("Invalid scheduler polling interval.");

  const active = new Map();
  let cursor = "",
    closed = false;
  function tick() {
    if (closed || active.size >= 4) return;
    try {
      tasks.recoverDeletions();
      const page = tasks.dueTasks(cursor, 32);
      for (const { id } of page) {
        cursor = id;
        if (active.has(id)) continue;
        try {
          const occurrence = tasks.prepareDue(id);
          if (!occurrence) continue;
          log?.("trigger", { taskId: id, runId: occurrence });
          const work = executeOccurrence(occurrence)
            .then((result) => {
              if (result)
                log?.(
                  result.state === "RequiresReview"
                    ? "execution_requires_review"
                    : result.state === "Failed"
                      ? "execution_failed"
                      : "execution_finished",
                  {
                    taskId: id,
                    runId: occurrence,
                    state: result.state,
                    previousState: "Running",
                    code: result.error,
                    dueAt: result.due_at,
                    durationMs:
                      result.started_at != null && result.finished_at != null
                        ? result.finished_at - result.started_at
                        : undefined,
                  },
                );
            })
            .catch((error) => {
              // Contention leaves the same unclaimed slot eligible on the next sweep.
              if (error.status !== 409)
                log?.("execution_failed", {
                  taskId: id,
                  runId: occurrence,
                  state: "Failed",
                  code: "execution_error",
                });
            })
            .finally(() => active.delete(id));
          active.set(id, work);
          if (active.size === 4) return;
        } catch {
          console.error("Scheduler task scan failed", id);
        }
      }
      if (page.length < 32) cursor = "";
    } catch {
      console.error("Scheduler database scan unavailable");
    }
  }
  const timer = setInterval(tick, pollMs);
  timer.unref();
  return {
    close() {
      closed = true;
      clearInterval(timer);
      return Promise.allSettled(active.values());
    },
  };
}
