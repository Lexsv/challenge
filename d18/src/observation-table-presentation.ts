import type { DisplayColumn } from "./task-report";

// Earlier observation reports stored column keys and units but no display metadata.
export function observationTablePresentation(columns: string[]): DisplayColumn[] | undefined {
  const wind = columns.find(key => /^(wind|windspeed)kmh$/i.test(key));
  const humidity = columns.find(key => key === "relativeHumidityPercent" || key === "humidityPercent");
  const timestamp = columns.includes("timestamp");
  if (!wind || !humidity || !columns.includes("temperatureC") || !columns.includes("source") ||
      (!timestamp && !(columns.includes("date") && columns.includes("localTime"))))
    return undefined;
  return [
    { key: timestamp ? "timestamp" : "date", label: "Date", format: "date" },
    { key: timestamp ? "timestamp" : "localTime", label: "Local Time", format: "time" },
    { key: "temperatureC", label: "Temperature", unit: "°C" },
    { key: humidity, label: "Humidity", unit: "%" },
    { key: wind, label: "Wind", unit: "km/h" },
    { key: "source", label: "Source", valueLabels: { "open-meteo": "Open-Meteo" } },
  ];
}
