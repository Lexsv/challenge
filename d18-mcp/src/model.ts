import { z } from "zod";

export const locationSchema = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type Location = z.infer<typeof locationSchema>;

export function canonicalLocation(location: Location): Location {
  return {
    latitude: Number(location.latitude.toFixed(5)),
    longitude: Number(location.longitude.toFixed(5)),
  };
}

export const timestamp = z.iso.datetime({ offset: true });
export const unitSchema = z.strictObject({
  temperature: z.literal("°C"), humidity: z.literal("%"), windSpeed: z.literal("km/h"),
});
export const observationSchema = z.strictObject({
  location: locationSchema,
  observedAt: timestamp,
  temperature: z.number(),
  humidity: z.number().min(0).max(100),
  windSpeed: z.number().nonnegative(),
  conditions: z.int().min(0).max(99).describe("WMO weather interpretation code"),
  units: unitSchema,
  source: z.literal("open-meteo"),
});
export type Observation = z.infer<typeof observationSchema>;
export const recordSchema = z.object({ id: z.int().positive(), observation: observationSchema });
export const historyInput = z.strictObject({
  location: locationSchema,
  from: timestamp.describe("Inclusive observation time"),
  to: timestamp.describe("Exclusive observation time"),
  limit: z.int().min(1).max(200).optional(),
  offset: z.int().nonnegative().optional(),
});
export type HistoryQuery = z.infer<typeof historyInput>;
export function utc(value: string): string {
  return new Date(value).toISOString();
}
