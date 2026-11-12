import { createTheme } from "@mui/material/styles";
import { vintagePalette as p } from "./vintage-palette";

const focusRing = { outline: `2px solid ${p.blueInk}`, outlineOffset: 2 };
export const theme = createTheme({
  palette: {
    primary: {
      main: p.blue,
      light: p.bluePale,
      dark: p.blueInk,
      contrastText: p.blueInk,
    },
    secondary: {
      main: p.pink,
      light: "#FAEBEF",
      dark: p.pinkInk,
      contrastText: p.text,
    },
    info: {
      main: p.blueInk,
      light: p.bluePale,
      dark: p.blueInk,
      contrastText: p.paper,
    },
    success: { main: p.success, light: "#E5F0E8", contrastText: p.paper },
    error: { main: p.error, light: "#F9E6E9", contrastText: p.paper },
    warning: { main: p.warning, light: "#FFF0DF", contrastText: p.paper },
    background: { default: p.surface, paper: p.paper },
    text: { primary: p.text, secondary: p.muted, disabled: p.disabled },
    divider: p.divider,
    action: {
      active: p.blueInk,
      hover: "#EEF7F8",
      selected: p.blueSelected,
      focus: p.bluePale,
      disabled: p.disabled,
      disabledBackground: p.disabledSurface,
    },
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
          "&.MuiButton-containedPrimary:hover": {
            backgroundColor: p.blueHover,
          },
          "&.MuiButton-containedSecondary:hover": {
            backgroundColor: p.pinkHover,
          },
          "&.MuiButton-textPrimary:not(.Mui-disabled), &.MuiButton-outlinedPrimary:not(.Mui-disabled)":
            { color: p.blueInk },
          "&.MuiButton-textSecondary:not(.Mui-disabled), &.MuiButton-outlinedSecondary:not(.Mui-disabled)":
            { color: p.pinkInk },
          "&.MuiButton-outlinedPrimary:not(.Mui-disabled)": {
            borderColor: p.blueInk,
          },
          "&.MuiButton-outlinedSecondary:not(.Mui-disabled)": {
            borderColor: p.pinkInk,
          },
          "&.Mui-focusVisible": focusRing,
          "&.Mui-disabled": { color: p.disabled },
          "&.MuiButton-contained.Mui-disabled": {
            backgroundColor: p.disabledSurface,
          },
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          "&.MuiIconButton-colorPrimary:not(.Mui-disabled)": {
            color: p.blueInk,
          },
          "&.MuiIconButton-colorSecondary:not(.Mui-disabled)": {
            color: p.pinkInk,
          },
          "&:hover": { backgroundColor: p.bluePale },
          "&.Mui-focusVisible": focusRing,
        },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: {
          "&:hover": { backgroundColor: "#EEF7F8" },
          "&.Mui-selected": { color: p.blueInk, backgroundColor: p.bluePale },
          "&.Mui-focusVisible": { ...focusRing, outlineOffset: -2 },
        },
      },
    },
    MuiTabs: { styleOverrides: { indicator: { backgroundColor: p.blueInk } } },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          "&.Mui-selected": { backgroundColor: p.blueSelected, color: p.text },
          "&.Mui-selected:hover": { backgroundColor: p.blueHover },
          "&.Mui-focusVisible": {
            ...focusRing,
            outlineOffset: -2,
            backgroundColor: p.bluePale,
          },
        },
      },
    },
    MuiMenuItem: {
      styleOverrides: {
        root: {
          "&.Mui-selected": { backgroundColor: p.blueSelected },
          "&.Mui-selected:hover": { backgroundColor: p.blueHover },
          "&.Mui-focusVisible": { ...focusRing, outlineOffset: -2 },
        },
      },
    },
    MuiToggleButton: {
      styleOverrides: {
        root: {
          "&.Mui-selected": {
            backgroundColor: p.blueSelected,
            color: p.blueInk,
          },
          "&.Mui-selected:hover": { backgroundColor: p.blueHover },
          "&.Mui-focusVisible": focusRing,
        },
      },
    },
    MuiCheckbox: {
      styleOverrides: {
        root: {
          "&.Mui-checked, &.MuiCheckbox-indeterminate": { color: p.blueInk },
          "&.Mui-focusVisible": focusRing,
          "&.Mui-disabled": { color: p.disabled },
        },
      },
    },
    MuiRadio: {
      styleOverrides: {
        root: {
          "&.Mui-checked": { color: p.blueInk },
          "&.Mui-focusVisible": focusRing,
          "&.Mui-disabled": { color: p.disabled },
        },
      },
    },
    MuiSwitch: {
      styleOverrides: {
        switchBase: {
          "&.Mui-checked": { color: p.blueInk },
          "&.Mui-checked + .MuiSwitch-track": { backgroundColor: p.blueInk },
          "&.Mui-focusVisible": focusRing,
        },
      },
    },
    MuiSlider: { styleOverrides: { root: { color: p.blueInk } } },
    MuiCircularProgress: {
      styleOverrides: { colorPrimary: { color: p.blueInk } },
    },
    MuiLinearProgress: {
      styleOverrides: {
        colorPrimary: { backgroundColor: p.bluePale },
        barColorPrimary: { backgroundColor: p.blueInk },
      },
    },
    MuiInputLabel: {
      styleOverrides: {
        root: { "&.Mui-focused:not(.Mui-error)": { color: p.blueInk } },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          "&:hover:not(.Mui-disabled):not(.Mui-error) .MuiOutlinedInput-notchedOutline":
            { borderColor: p.blueInk },
          "&.Mui-focused:not(.Mui-error) .MuiOutlinedInput-notchedOutline": {
            borderColor: p.blueInk,
          },
          "&.Mui-disabled": { backgroundColor: p.disabledSurface },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        colorDefault: { backgroundColor: p.bluePale, color: p.text },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: { backgroundColor: p.blueInk, color: p.paper },
        arrow: { color: p.blueInk },
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
          border: `1px solid ${p.divider}`,
          boxShadow: "0 3px 12px #285E6810",
        },
      },
    },
  },
});
