import { createTheme } from "@mui/material/styles";
export const theme = createTheme({
  palette: {
    info: { main: "#1B5EA8", light: "#E3EFFD" },
    primary: { main: "#6C5CE7", dark: "#4D36AE", contrastText: "#FFFFFF" },
    secondary: { main: "#EEE5FA", contrastText: "#1F2937" },
    background: { default: "#FAF8F4", paper: "#FFFDFA" },
    text: { primary: "#1F2937", secondary: "#606777" },
    divider: "#E5E1DA",
  },
  shape: { borderRadius: 16 },
  typography: {
    fontFamily: "Inter, system-ui, sans-serif",
    h4: { fontSize: "2rem", fontWeight: 780 },
    h5: { fontWeight: 750 },
    h6: { fontWeight: 750 },
    button: { textTransform: "none", fontWeight: 650 },
  },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          borderRadius: 10,
          "&.MuiButton-containedPrimary:hover": { backgroundColor: "#5B4EE0" },
          "&.MuiButton-textPrimary, &.MuiButton-outlinedPrimary": {
            color: "#4D36AE",
          },
          "&.Mui-focusVisible": {
            outline: "2px solid #4D36AE",
            outlineOffset: 2,
          },
        },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          "&.Mui-selected": { color: "#4D36AE" },
          "&.Mui-focusVisible": {
            outline: "2px solid #4D36AE",
            outlineOffset: -2,
          },
        },
      },
    },
    MuiTabs: { styleOverrides: { indicator: { backgroundColor: "#4D36AE" } } },
    MuiCheckbox: {
      styleOverrides: {
        root: {
          "&.Mui-checked": { color: "#4D36AE" },
          "&.Mui-focusVisible": {
            outline: "2px solid #4D36AE",
            outlineOffset: -2,
          },
        },
      },
    },
    MuiInputLabel: {
      styleOverrides: { root: { "&.Mui-focused": { color: "#4D36AE" } } },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
            borderColor: "#4D36AE",
          },
        },
      },
    },
    MuiDialog: { styleOverrides: { paper: { borderRadius: 20 } } },
    MuiPaper: { styleOverrides: { root: { backgroundImage: "none" } } },
    MuiTextField: {
      defaultProps: { fullWidth: true, size: "small", variant: "outlined" },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          border: "1px solid #E5E1DA",
          boxShadow: "0 3px 12px #35295712",
        },
      },
    },
  },
});
