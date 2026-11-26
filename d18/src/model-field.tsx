import { credentials, type SavedProvider } from "./saved-credentials";
import { useState, useSyncExternalStore } from "react";
import { Stack, TextField, MenuItem } from "@mui/material";
import type { ProviderRegistry } from "./provider-registry";

export function ModelField({
  label,
  value,
  onChange,
  providerId,
  registry,
  inherit = false,
  allowCustom = true,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  providerId?: string;
  registry: ProviderRegistry;
  inherit?: boolean;
  allowCustom?: boolean;
}) {
  const provider = providerId ? registry.get(providerId) : undefined;
  const options = registry.modelOptionsFor(providerId);
  const [customEditing, setCustomEditing] = useState(false);
  const unavailableConsoleModel =
    providerId === "opencode-console" && !!value && !options.includes(value) && !customEditing;
  const custom = customEditing || (!!value && !options.includes(value) && !unavailableConsoleModel);
  return (
    <Stack spacing={1}>
      <TextField
        select
        label={label}
        value={custom ? "__custom" : inherit && !value ? "__default" : value || "__none"}
        onChange={(event) => {
          if (event.target.value === "__custom") {
            setCustomEditing(true);
            return;
          }
          setCustomEditing(false);
          if (event.target.value !== "__none")
            onChange(event.target.value === "__default" ? "" : event.target.value);
        }}
        helperText={
          !provider
            ? "Select a provider first."
            : !options.length
              ? "No discovered models available for this provider."
              : undefined
        }
      >
        {inherit && <MenuItem value="__default">Use default</MenuItem>}
        {!value && !inherit && (
          <MenuItem value="__none" disabled>
            Select a model
          </MenuItem>
        )}
        {unavailableConsoleModel && (
          <MenuItem value={value} disabled>
            {value} (previously selected; unavailable)
          </MenuItem>
        )}
        {options.map((id) => (
          <MenuItem key={id} value={id}>
            {id}
          </MenuItem>
        ))}
        {(allowCustom || custom) && (
          <MenuItem value="__custom" disabled={!allowCustom}>
            Custom model ID
          </MenuItem>
        )}
      </TextField>
      {custom && allowCustom && (
        <TextField
          label="Custom model ID"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          helperText="Model capabilities must be confirmed for this provider."
        />
      )}
    </Stack>
  );
}

export function useProviderOptions(registry: ProviderRegistry) {
  const saved = useSyncExternalStore(
    credentials.subscribe,
    credentials.getSnapshot,
    credentials.getSnapshot,
  );
  return registry.executionOptions((id) => !!saved[id as SavedProvider]?.saved);
}

export function ProviderField({
  registry,
  value,
  onChange,
  allow = () => true,
  helperText,
}: {
  registry: ProviderRegistry;
  value: string;
  onChange: (id: string) => void;
  allow?: (id: string) => boolean;
  helperText?: string;
}) {
  const options = useProviderOptions(registry).filter((p) => allow(p.id));
  return (
    <TextField
      select
      fullWidth
      size="small"
      label="Provider"
      value={value}
      helperText={helperText}
      onChange={(e) => onChange(e.target.value)}
    >
      {!options.some((p) => p.id === value) && (
        <MenuItem value={value} disabled>
          {value ? value + " (unavailable)" : "Select a provider"}
        </MenuItem>
      )}
      {options.map((p) => (
        <MenuItem key={p.id} value={p.id}>
          {p.label}
        </MenuItem>
      ))}
    </TextField>
  );
}

export function CatalogModelField({
  value,
  options,
  onChange,
  disabledModel,
  label = "Model",
  required = false,
}: {
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
  disabledModel?: string;
  label?: string;
  required?: boolean;
}) {
  return (
    <TextField
      select
      fullWidth
      size="small"
      required={required}
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {!value && (
        <MenuItem value="">{options.length ? "Select a model" : "No models available"}</MenuItem>
      )}
      {value && !options.includes(value) && (
        <MenuItem value={value} disabled>
          {value} (previously selected; unavailable)
        </MenuItem>
      )}
      {options.map((id) => (
        <MenuItem key={id} value={id} disabled={id === disabledModel}>
          {id}
        </MenuItem>
      ))}
    </TextField>
  );
}
