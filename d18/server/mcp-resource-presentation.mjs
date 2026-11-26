// Resource contents are opaque in MCP. Interpret only explicit fields in a JSON
// representation, never identifiers or prose. Other resources remain watchable.
const states = new Map(
  Object.entries({
    pending: "Pending",
    scheduled: "Pending",
    queued: "Pending",
    running: "Running",
    completed: "Completed",
    cancelled: "Cancelled",
    canceled: "Cancelled",
    failed: "Failed",
  }),
);
export function resourceFields(texts) {
  for (const text of texts) {
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const field = (k) =>
      typeof value[k] === "string" && value[k].trim()
        ? value[k].slice(0, 1024)
        : null;
    const time = field("scheduledAt");
    return {
      status:
        states.get((field("status") ?? field("state"))?.toLowerCase()) ??
        "Unknown",
      title: field("title") ?? field("name"),
      description: field("description"),
      scheduledAt:
        time &&
        /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/i.test(time) &&
        Number.isFinite(Date.parse(time))
          ? time
          : null,
      message: field("message"),
    };
  }
  return {
    status: "Unknown",
    title: null,
    description: null,
    scheduledAt: null,
    message: null,
  };
}

export const subscriptionState = {
  pending: "Subscribing",
  active: "Subscribed",
  polling: "Subscribed",
  reconnecting: "Reconnecting",
  suspended: "Failed",
  unavailable: "Failed",
  unsubscribed: "Unsubscribed",
};
