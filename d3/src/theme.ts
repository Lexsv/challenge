import { createTheme } from "@mui/material/styles";
export const theme = createTheme({
  palette: {
    primary: { main: "#606d29", dark: "#424c1c" },
    background: { default: "#f7f4eb", paper: "#fffdf8" },
    text: { primary: "#242810", secondary: "#626451" },
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
      styleOverrides: { root: { borderRadius: 10 } },
    },
    MuiPaper: { styleOverrides: { root: { backgroundImage: "none" } } },
    MuiTextField: {
      defaultProps: { fullWidth: true, size: "small", variant: "outlined" },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          border: "1px solid #dedfce",
          boxShadow: "0 3px 12px #292a1010",
        },
      },
    },
  },
});
