import { elapsed, silent } from "./logging.js";
import { z } from "zod";
import { canonicalLocation, observationSchema, type Location, type Observation } from "./model.js";

export interface WeatherProvider {
  current(location: Location): Promise<Observation>;
}

const responseSchema = z.object({
  current_units: z.object({
    time: z.literal("unixtime"), temperature_2m: z.literal("°C"),
    relative_humidity_2m: z.literal("%"), wind_speed_10m: z.literal("km/h"),
    weather_code: z.literal("wmo code"),
  }),
  current: z.object({
    time: z.int().min(0).max(253402300799), temperature_2m: z.number(),
    relative_humidity_2m: z.number().min(0).max(100), wind_speed_10m: z.number().nonnegative(),
    weather_code: z.int().min(0).max(99),
  }),
});

export class ProviderError extends Error {}
export class OpenMeteo implements WeatherProvider {
  constructor(private readonly timeoutMs: number, private readonly request = fetch, private readonly log = silent) {}

  async current(input: Location): Promise<Observation> {
    const location = canonicalLocation(input);
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.search = new URLSearchParams({
      latitude: String(location.latitude), longitude: String(location.longitude),
      current: "temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code",
      timeformat: "unixtime", timezone: "GMT", temperature_unit: "celsius", wind_speed_unit: "kmh",
    }).toString();
    const start = performance.now();
    let httpStatus: number | undefined;
    this.log.write("weather.request", "started", "Requesting current weather from Open-Meteo.", {...location});
    try {
      const response = await this.request(url, { signal: AbortSignal.timeout(this.timeoutMs), redirect: "error" });
      httpStatus = response.status;
      if (!response.ok) {
        throw new ProviderError(response.status === 429 ? "Weather provider rate limit reached." : "Weather provider unavailable.");
      }
      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) throw new ProviderError("Weather provider returned invalid measurements or units.");
      const { current, current_units } = parsed.data;
      const observation = observationSchema.parse({
        location, observedAt: new Date(current.time * 1000).toISOString(),
        temperature: current.temperature_2m, humidity: current.relative_humidity_2m,
        windSpeed: current.wind_speed_10m, conditions: current.weather_code,
        units: { temperature: current_units.temperature_2m, humidity: current_units.relative_humidity_2m,
          windSpeed: current_units.wind_speed_10m }, source: "open-meteo",
      });
      this.log.write("weather.collected", "success", "Received current weather from Open-Meteo.",
        {...location, httpStatus, durationMs: elapsed(start), observedAt: observation.observedAt});
      return observation;
    } catch (error) {
      const failure = error instanceof ProviderError ? error : new ProviderError("Weather request failed or timed out.");
      // Only locally defined messages are safe to expose. Never serialize the HTTP response or exception.
      const reasons = ["Weather provider rate limit reached.", "Weather provider unavailable.",
        "Weather provider returned invalid measurements or units.", "Weather request failed or timed out."];
      this.log.write("weather.failed", "failure", reasons.includes(failure.message) ? failure.message : "Weather lookup failed.",
        {...location, httpStatus, durationMs: elapsed(start)});
      throw failure;
    }
  }
}
