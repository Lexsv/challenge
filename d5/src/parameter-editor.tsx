import {
  Alert,
  Button,
  Checkbox,
  IconButton,
  InputBase,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import Add from "@mui/icons-material/Add";
import Close from "@mui/icons-material/Close";
import {
  newParameter,
  validateParameters,
  type ApiParameter,
} from "./api-parameters";

export function ParameterEditor({
  parameters,
  onChange,
}: {
  parameters: ApiParameter[];
  onChange: (parameters: ApiParameter[]) => void;
}) {
  return (
    <>
      <TableContainer
        sx={{
          mt: 1,
          overflowX: "auto",
          border: "1px solid",
          borderColor: (theme) => alpha(theme.palette.primary.main, 0.22),
          borderRadius: 1.5,
        }}
      >
        <Table
          size="small"
          sx={{
            minWidth: 480,
            tableLayout: "fixed",
            "& th, & td": {
              borderColor: (theme) => alpha(theme.palette.primary.main, 0.18),
            },
            "& th:not(:last-child), & td:not(:last-child)": {
              borderRight: "1px solid",
              borderRightColor: (theme) =>
                alpha(theme.palette.primary.main, 0.18),
            },
            "& tbody tr:last-child td": { borderBottom: 0 },
            "& tbody td": { padding: 0, verticalAlign: "middle" },
            "& thead th": {
              py: 0.75,
              px: 1,
              fontWeight: 700,
              fontSize: "0.75rem",
              color: "primary.dark",
              backgroundColor: (theme) =>
                alpha(theme.palette.primary.main, 0.1),
            },
          }}
          aria-label="API Parameters"
        >
          <colgroup>
            <col style={{ width: 56 }} />
            <col style={{ width: "34%" }} />
            <col />
            <col style={{ width: 60 }} />
          </colgroup>
          <TableHead>
            <TableRow>
              <TableCell align="center">USE</TableCell>
              <TableCell>KEY</TableCell>
              <TableCell>VALUE</TableCell>
              <TableCell align="center">DELETE</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {parameters.map((row, index) => {
              const update = (change: Partial<ApiParameter>) =>
                onChange(
                  parameters.map((item, i) =>
                    i === index ? { ...item, ...change } : item,
                  ),
                );
              return (
                <TableRow key={row.id}>
                  <TableCell align="center">
                    <Checkbox
                      size="small"
                      checked={row.enabled}
                      onChange={(event) =>
                        update({ enabled: event.target.checked })
                      }
                      inputProps={{
                        "aria-label": `Enable parameter ${index + 1}`,
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <InputBase
                      fullWidth
                      sx={{
                        px: 1.25,
                        py: 0.75,
                        "&.Mui-focused": {
                          outline: "2px solid",
                          outlineColor: "primary.dark",
                          outlineOffset: -2,
                          borderRadius: 0.5,
                        },
                        "& input": { minWidth: 0 },
                      }}
                      value={row.key}
                      onChange={(event) => update({ key: event.target.value })}
                      inputProps={{
                        "aria-label": `Parameter ${index + 1} key`,
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <InputBase
                      fullWidth
                      multiline
                      minRows={1}
                      maxRows={5}
                      sx={{
                        px: 1.25,
                        py: 0.75,
                        "&.Mui-focused": {
                          outline: "2px solid",
                          outlineColor: "primary.dark",
                          outlineOffset: -2,
                          borderRadius: 0.5,
                        },
                        "& textarea": {
                          overflowWrap: "anywhere",
                          wordBreak: "break-word",
                          overflowX: "hidden",
                        },
                      }}
                      value={row.value}
                      onChange={(event) =>
                        update({ value: event.target.value })
                      }
                      inputProps={{
                        "aria-label": `Parameter ${index + 1} value`,
                      }}
                    />
                  </TableCell>
                  <TableCell align="center">
                    <IconButton
                      size="small"
                      aria-label={`Delete parameter ${index + 1}`}
                      onClick={() =>
                        onChange(parameters.filter((_, i) => i !== index))
                      }
                    >
                      <Close fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      {validateParameters(parameters) && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {validateParameters(parameters)}
        </Alert>
      )}
      <Button
        startIcon={<Add />}
        onClick={() => onChange([...parameters, newParameter()])}
      >
        Add parameter
      </Button>
    </>
  );
}
