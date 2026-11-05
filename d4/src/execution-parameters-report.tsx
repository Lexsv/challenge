import {
  Box,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import type { ExecutionParameters } from "./execution-parameters";
import { resultHeadingStyle } from "./result-metadata";
export function ExecutionParametersReport({
  parameters,
}: {
  parameters?: ExecutionParameters;
}) {
  return (
    <Box component="section" sx={{ minWidth: 0 }}>
      <Typography
        component="h3"
        variant="subtitle1"
        sx={{ ...resultHeadingStyle, mb: 1 }}
      >
        API Parameters
      </Typography>
      {parameters === undefined ? (
        <Typography>Parameters not recorded</Typography>
      ) : Object.keys(parameters).length === 0 ? (
        <Typography>No API parameters sent.</Typography>
      ) : (
        <TableContainer sx={{ overflowX: "auto" }}>
          <Table
            size="small"
            aria-label="Executed API parameters"
            sx={{ tableLayout: "fixed", minWidth: 240 }}
          >
            <TableHead
              sx={{
                bgcolor: (theme) => alpha(theme.palette.primary.main, 0.1),
                "& th": { fontWeight: 700, color: "primary.dark" },
              }}
            >
              <TableRow>
                <TableCell sx={{ width: "38%" }}>Parameter</TableCell>
                <TableCell>Value</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {Object.entries(parameters).map(([key, value]) => (
                <TableRow key={key}>
                  <TableCell
                    sx={{ verticalAlign: "top", overflowWrap: "anywhere" }}
                  >
                    {key}
                  </TableCell>
                  <TableCell>
                    <Box
                      component="pre"
                      sx={{
                        m: 0,
                        font: "inherit",
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                        maxHeight: "12em",
                        overflow: "auto",
                      }}
                    >
                      {typeof value === "string"
                        ? value
                        : JSON.stringify(value, null, 2)}
                    </Box>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
}
