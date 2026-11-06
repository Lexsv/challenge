import { createTheme } from "@mui/material/styles";
export const theme = createTheme({
  palette: {
    primary: { main: "#F5D76E", dark: "#705500", contrastText: "#34332F" },
    secondary: { main: "#FFF3C4", contrastText: "#34332F" },
    background: { default: "#FFFDF5", paper: "#FFFEFA" },
    text: { primary: "#34332F", secondary: "#625B49" },
    divider: "#E1D6AD",
  },
  shape: { borderRadius: 16 },
  typography: {
    fontFamily: "Inter, system-ui, sans-serif",
    h4: { fontWeight: 800 },
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
          "&.MuiButton-textPrimary, &.MuiButton-outlinedPrimary": {
            color: "#705500",
          },
          "&.Mui-focusVisible": {
            outline: "2px solid #705500",
            outlineOffset: 2,
          },
        },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          "&.Mui-selected": { color: "#705500" },
          "&.Mui-focusVisible": {
            outline: "2px solid #705500",
            outlineOffset: -2,
          },
        },
      },
    },
    MuiTabs: { styleOverrides: { indicator: { backgroundColor: "#705500" } } },
    MuiCheckbox: {
      styleOverrides: {
        root: {
          "&.Mui-checked": { color: "#705500" },
          "&.Mui-focusVisible": {
            outline: "2px solid #705500",
            outlineOffset: -2,
          },
        },
      },
    },
    MuiInputLabel: {
      styleOverrides: { root: { "&.Mui-focused": { color: "#705500" } } },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
            borderColor: "#705500",
          },
        },
      },
    },
    MuiPaper: { styleOverrides: { root: { backgroundImage: "none" } } },
    MuiTextField: {
      defaultProps: { fullWidth: true, size: "small", variant: "outlined" },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          border: "1px solid #E8DDBA",
          boxShadow: "0 3px 12px #493C1010",
        },
      },
    },
  },
});
