import { createProviderRegistry } from "../src/provider-registry.ts";
import { managerContextBudget } from "../src/manager-llm-adapter.ts";
import { createServerManagerLlmAdapter } from "./manager-llm-adapter.ts";

// Only the public model catalog is fetched during capability discovery.
export function invariantProvider(db, transport, fetcher = fetch) {
  const registry = createProviderRegistry(
    undefined,
    {},
    {
      catalogFetch: (url, options) =>
        fetcher(url, { ...options, signal: AbortSignal.timeout(5000) }),
    },
  );
  const catalogs = new Map();
  async function discover(provider) {
    const cached = catalogs.get(provider);
    if (cached && cached.until > Date.now()) return cached.promise;
    const entry = { until: Date.now() + 300000 };
    entry.promise = registry
      .get(provider)
      .discover()
      .then(
        () => true,
        () => {
          entry.until = Date.now() + 15000;
          return false;
        },
      );
    catalogs.set(provider, entry);
    return entry.promise;
  }
  async function compatibility(s, provider, model) {
    if (!["opencode-console", "opencode-go"].includes(provider) || !model)
      return null;
    let strategy = s.week3 ? "Summary" : null;
    let maintenanceOnly = false;
    if (!strategy) {
      if (
        db
          .prepare(
            "SELECT 1 FROM sticky_sessions WHERE childId=? UNION ALL SELECT 1 FROM sessions WHERE id=? AND contextStrategy='key-facts' AND fullContext=0",
          )
          .get(s.id, s.id)
      )
        strategy = "Sticky Facts";
      else if (
        db.prepare("SELECT 1 FROM memory_sessions WHERE childId=?").get(s.id)
      ) {
        strategy = "Key-Value Memory";
        const row = db
          .prepare("SELECT entries FROM session_memory WHERE sessionId=?")
          .get(s.id);
        maintenanceOnly = !row || JSON.parse(row.entries).length === 0;
      }
    }
    if (!strategy) return null;
    if (await discover(provider)) {
      const { inputBudget } = managerContextBudget({
        providerId: provider,
        model,
        registry,
      });
      if (Number.isSafeInteger(inputBudget) && inputBudget > 0) return null;
    }
    return {
      maintenanceOnly,
      message:
        strategy +
        " requires a verified model input budget" +
        (maintenanceOnly ? " for memory updates" : "") +
        ". This provider has no usable context limit for the selected model. Choose another model or use Full Context.",
    };
  }
  const adapter = (providerId, model, limit) =>
    createServerManagerLlmAdapter({ providerId, model }, registry, transport, limit);
  return {
    registry, compatibility, adapter,
    async scheduledAdapter(providerId, model, limit) {
      // A browser's discovered catalog is not available to an unattended process.
      if (registry.get(providerId)?.discover) await discover(providerId);
      return adapter(providerId, model, limit);
    },
  };
}
