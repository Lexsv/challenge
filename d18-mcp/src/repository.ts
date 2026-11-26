import { DatabaseSync } from "node:sqlite";
import { canonicalLocation, observationSchema, utc, type HistoryQuery, type Observation } from "./model.js";

export class WeatherStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY,
        latitude REAL NOT NULL, longitude REAL NOT NULL, observed_at TEXT NOT NULL,
        temperature REAL NOT NULL, humidity REAL NOT NULL, wind_speed REAL NOT NULL,
        conditions INTEGER NOT NULL, temperature_unit TEXT NOT NULL,
        humidity_unit TEXT NOT NULL, wind_speed_unit TEXT NOT NULL, source TEXT NOT NULL,
        UNIQUE(latitude, longitude, observed_at, source)
      ) STRICT;
    `);
  }

  save(observation: Observation) {
    const {latitude, longitude} = canonicalLocation(observation.location);
    const time = utc(observation.observedAt);
    const result = this.db.prepare(`INSERT INTO observations
      (latitude,longitude,observed_at,temperature,humidity,wind_speed,conditions,
       temperature_unit,humidity_unit,wind_speed_unit,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(latitude,longitude,observed_at,source) DO NOTHING`)
      .run(latitude, longitude, time, observation.temperature, observation.humidity, observation.windSpeed,
        observation.conditions, observation.units.temperature, observation.units.humidity,
        observation.units.windSpeed, observation.source);
    if (result.changes) return {id: Number(result.lastInsertRowid), created: true};
    const row = this.db.prepare(`SELECT id FROM observations WHERE latitude=? AND longitude=?
      AND observed_at=? AND source=?`).get(latitude, longitude, time, observation.source)!;
    return {id: Number(row.id), created: false};
  }

  history(query: HistoryQuery) {
    const {latitude, longitude} = canonicalLocation(query.location);
    const from = utc(query.from), to = utc(query.to);
    if (from >= to) throw new RangeError("from must precede to.");
    const limit = query.limit ?? 100, offset = query.offset ?? 0;
    const rows = this.db.prepare(`SELECT * FROM observations WHERE latitude=? AND longitude=?
      AND observed_at>=? AND observed_at<? ORDER BY observed_at, id LIMIT ? OFFSET ?`)
      .all(latitude, longitude, from, to, limit + 1, offset);
    const records = rows.slice(0, limit).map(row => ({
      id: Number(row.id),
      observation: observationSchema.parse({
        location: {latitude: row.latitude, longitude: row.longitude}, observedAt: row.observed_at,
        temperature: row.temperature, humidity: row.humidity, windSpeed: row.wind_speed, conditions: row.conditions,
        units: {temperature: row.temperature_unit, humidity: row.humidity_unit, windSpeed: row.wind_speed_unit},
        source: row.source,
      }),
    }));
    return {records, nextOffset: rows.length > limit ? offset + limit : null};
  }

  close() { this.db.close(); }
}
