import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  palette: {
    primary: {
      main: "#1553d3",
      dark: "#103d9f",
      light: "#dfebff",
      contrastText: "#fff",
    },
    secondary: {
      main: "#415878",
      light: "#edf2f9",
      dark: "#2e4260",
      contrastText: "#fff",
    },
    info: { main: "#206988", light: "#e4f2f9" },
    success: { main: "#187342", light: "#e1f6e8", contrastText: "#fff" },
    warning: { main: "#87520c", light: "#fff2d9" },
    error: { main: "#ab333d", light: "#fbeaec" },
    text: { primary: "#102448", secondary: "#4f6079" },
    background: { default: "#f5f8fd", paper: "#fff" },
    divider: "#d7e1ef",
    action: { selected: "#e4eeff", hover: "#f2f6ff", focus: "#d8e7ff" },
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily: "Inter, system-ui, sans-serif",
    h4: { fontSize: "1.75rem", fontWeight: 750 },
    h5: { fontSize: "1.35rem", fontWeight: 750 },
    h6: { fontSize: "1.05rem", fontWeight: 700 },
    button: { textTransform: "none", fontWeight: 650 },
  },
  components: {
    MuiButtonBase: {
      styleOverrides: {
        root: ({ theme }) => ({
          "&.Mui-focusVisible": {
            outline: `2px solid ${theme.palette.primary.main}`,
            outlineOffset: -2,
          },
        }),
      },
    },
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiTextField: {
      defaultProps: { size: "small", fullWidth: true, variant: "outlined" },
    },
    MuiTab: {
      styleOverrides: {
        root: ({ theme }) => ({
          textTransform: "none",
          "&.Mui-selected": {
            color: theme.palette.primary.dark,
            backgroundColor: theme.palette.action.selected,
          },
        }),
      },
    },
    MuiToggleButton: {
      styleOverrides: {
        root: ({ theme }) => ({
          textTransform: "none",
          gap: theme.spacing(1),
          fontWeight: 650,
          "&.Mui-selected": {
            color: theme.palette.primary.dark,
            backgroundColor: theme.palette.action.selected,
            borderColor: theme.palette.primary.main,
          },
        }),
      },
    },
    MuiMenuItem: {
      styleOverrides: {
        root: ({ theme }) => ({
          "&.Mui-selected": {
            color: theme.palette.primary.dark,
            backgroundColor: theme.palette.action.selected,
          },
        }),
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: ({ theme }) => ({
          "&.Mui-selected": {
            color: theme.palette.primary.dark,
            backgroundColor: theme.palette.action.selected,
          },
        }),
      },
    },
    MuiTableCell: {
      styleOverrides: {
        head: ({ theme }) => ({
          color: theme.palette.text.primary,
          backgroundColor: theme.palette.background.default,
          fontWeight: 700,
        }),
      },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: ({ theme }) => ({
          height: 8,
          borderRadius: theme.shape.borderRadius,
          backgroundColor: theme.palette.secondary.light,
        }),
        bar: ({ theme }) => ({ borderRadius: theme.shape.borderRadius }),
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: ({ theme }) => ({
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: 12,
        }),
        root: {
          "& .MuiBackdrop-root": { backgroundColor: "rgba(20,39,68,.30)" },
        },
      },
    },
    MuiCard: { defaultProps: { variant: "outlined" } },
    MuiChip: {
      styleOverrides: {
        filled: ({ theme, ownerState }) =>
          !ownerState.color || ownerState.color === "default"
            ? {
                backgroundColor: theme.palette.secondary.light,
                color: theme.palette.text.primary,
              }
            : {},
      },
    },
  },
});

// Non-MUI renderers (such as highlighted code) need resolved color values.
export const palette = theme.palette;
