import {
  Box,
  Checkbox,
  Chip,
  FormControl,
  FormHelperText,
  InputLabel,
  MenuItem,
  OutlinedInput,
  Select,
  Typography,
} from "@mui/material";
import type { Permission, ToolChoice } from "./scheduler-api";

const allOption = "__all__";

// Keep saved grants on unchanged servers, including legacy partial selections.
// Only an explicitly added server takes a snapshot of its eligible catalog.
export function selectServerGrants(
  current: Permission[],
  selected: string[],
  catalog: ToolChoice[],
): Permission[] {
  const previous = new Set(current.map((p) => p.connectionId));
  const wanted = new Set(selected);
  return [
    ...current.filter((p) => wanted.has(p.connectionId)),
    ...catalog
      .filter(
        (c) =>
          wanted.has(c.connectionId) &&
          !previous.has(c.connectionId) &&
          c.eligible,
      )
      .map(({ connectionId, toolId }) => ({ connectionId, toolId })),
  ];
}

export function SchedulerServerSelector({
  catalog,
  permissions,
  onChange,
  disabled,
}: {
  catalog: ToolChoice[];
  permissions: Permission[];
  onChange: (permissions: Permission[]) => void;
  disabled: boolean;
}) {
  const names = new Map(catalog.map((c) => [c.connectionId, c.server]));
  const selected = [...new Set(permissions.map((p) => p.connectionId))];
  const eligible = new Set(
    catalog.filter((c) => c.eligible).map((c) => c.connectionId),
  );
  const allSelected =
    eligible.size > 0 && [...eligible].every((id) => selected.includes(id));
  const held = new Set(permissions.map((p) => p.toolId));
  const partial = catalog.some(
    (c) =>
      selected.includes(c.connectionId) && c.eligible && !held.has(c.toolId),
  );
  const change = (ids: string[]) =>
    onChange(selectServerGrants(permissions, ids, catalog));

  return (
    <FormControl
      fullWidth
      disabled={disabled}
      size="small"
      sx={{ minWidth: 0 }}
    >
      <InputLabel id="scheduler-mcp-servers-label" shrink>
        MCP Servers
      </InputLabel>
      <Select<string[]>
        multiple
        displayEmpty
        labelId="scheduler-mcp-servers-label"
        input={<OutlinedInput label="MCP Servers" notched />}
        value={allSelected ? [...selected, allOption] : selected}
        onChange={({ target }) => {
          const ids =
            typeof target.value === "string"
              ? target.value.split(",")
              : target.value;
          if (ids.includes(allOption) !== allSelected) {
            change(allSelected ? [] : [...new Set([...selected, ...eligible])]);
          } else {
            change(ids.filter((id) => id !== allOption));
          }
        }}
        renderValue={() =>
          selected.length ? (
            <Box
              sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, minWidth: 0 }}
            >
              {selected.map((id) => (
                <Chip
                  key={id}
                  size="small"
                  label={names.get(id) ?? "Unavailable server"}
                  sx={{ maxWidth: "100%" }}
                  disabled={disabled}
                  onMouseDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  onDelete={() =>
                    change(selected.filter((other) => other !== id))
                  }
                />
              ))}
            </Box>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Select servers
            </Typography>
          )
        }
        MenuProps={{ slotProps: { paper: { sx: { maxHeight: 320 } } } }}
      >
        <MenuItem
          value={allOption}
          disabled={!eligible.size}
          divider
        >
          <Checkbox
            size="small"
            tabIndex={-1}
            checked={allSelected}
            indeterminate={
              !allSelected && selected.some((id) => eligible.has(id))
            }
          />
          Select All
        </MenuItem>
        {[...names].map(([id, name]) => (
          <MenuItem
            key={id}
            value={id}
            disabled={!eligible.has(id) && !selected.includes(id)}
          >
            <Checkbox
              size="small"
              tabIndex={-1}
              checked={selected.includes(id)}
            />
            <Typography
              variant="body2"
              sx={{ overflowWrap: "anywhere", whiteSpace: "normal" }}
            >
              {name}
              {!eligible.has(id) && " · No eligible tools"}
            </Typography>
          </MenuItem>
        ))}
      </Select>
      {partial && (
        <FormHelperText>
          Existing grants are preserved. Remove and reselect a server to include
          its latest eligible tools.
        </FormHelperText>
      )}
    </FormControl>
  );
}
