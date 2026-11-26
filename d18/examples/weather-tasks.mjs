// Pass the saved connection's catalog from the normal discovery API.
// Each task owns its configuration and its selected tool permissions.
export function weatherTaskDefinitions(catalog, config) {
  const { collection, reporting, location, timezone, periodHours, provider, model } = config;
  if (
    !location?.trim() ||
    !Number.isFinite(periodHours) ||
    periodHours <= 0 || !collection?.schedule || !reporting?.schedule
  )
    throw new Error("Specify a location, positive reporting period and both schedules.");
  function permission(name) {
    const matches = catalog.tools.filter(
      (tool) => tool.originalName === name && tool.connectionId === catalog.connection.connectionId,
    );
    if (matches.length !== 1) throw new Error("Missing or ambiguous discovered tool: " + name);
    return { connectionId: matches[0].connectionId, toolId: matches[0].toolId };
  }
  const common = { timezone, provider, model, enabled: false };
  return {
    collection: {
      ...common,
      name:"Collect observations",
      schedule: collection.schedule,
      permissions: [permission("get_weather"), permission("save_weather")],
      instructions: [
        `Collect one current weather observation for ${JSON.stringify(location)} using get_weather.`,
        "Only after a successful read in this turn, pass that observation to save_weather using its declared schema.",
        "Preserve the returned location, timestamp, units and measurements. Leave missing values missing.",
        "If required save data is absent, report what is missing. Never invent measurements or reuse older chat observations.",
        "Report the save receipt or the failure. Do not repeat a write with an uncertain outcome.",
      ].join(" "),
    },
    reporting: {
      ...common,
      name:"Weather report",
      schedule: reporting.schedule,
      permissions: [permission("read_weather_history")],
      instructions: [
        `Report the weather for ${JSON.stringify(location)} for the trailing ${periodHours} hours ending at the current server time.`,
        "Use read_weather_history and its discovered range semantics. Report exact start (inclusive), end (exclusive), and time zone.",
        "Use all pages for this period. If retrieval fails or coverage is incomplete, identify the gap; do not claim an empty or complete period.",
        "Count observations for the requested location and period. From finite measurements in compatible units calculate minimum, maximum and mean temperature, mean humidity, and mean and maximum wind speed. Include units and distinct observed conditions.",
        "For each metric, report its sample count. Preserve zeros, omit missing values from that metric's denominator, and label unavailable metrics. If there are zero observations, say so without inventing averages.",
      ].join(" "),
    },
  };
}
