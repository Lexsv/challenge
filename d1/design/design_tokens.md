# API Explorer — screenshot-based design specification

## Sources and confidence

Reviewed local files: `default_state.png` and `Invalid_state.png` in this directory. `Invalid_state.png` supplies the invalid-key state requested as `invalid_key_state.png`; no image was renamed or modified. These images represent the approved Figma design, but no Figma file, source tokens, font metadata, or export scale was available.

Both raster images are 2880 × 1800 pixels (verified from image metadata). Visible labels, component order, and state differences below are directly observable. Coordinates, colors, fonts, weights, radii, and spacing below are visual estimates, not measured Figma specifications. Raster pixels do not establish CSS pixels or device pixel ratio.

For a practical starting point only, the proposed CSS dimensions assume the screenshots represent a 2× export: 2880 × 1800 raster pixels would correspond to a 1440 × 900 CSS viewport. This scale is unverified. Confirm it before implementation and adjust the values together if needed.

## Color palette

All hex values are approximate visual matches, not sampled or verified source values. Use semantic CSS custom properties for reusable tokens; the suggested names below document intent and do not constitute application code.

| Suggested custom property | Approximate value | Use |
| --- | --- | --- |
| `--color-page` | `#F4F0E8` | Warm cream page background |
| `--color-card` | `#FFFCF7` | Main form card |
| `--color-field` | `#F8F5EF` | Key and question fields |
| `--color-border` | `#E8DDCE` | Card and field outlines |
| `--color-heading` | `#40372E` | Main heading |
| `--color-label` | `#7C6E5D` | Uppercase labels, masked key |
| `--color-secondary` | `#8E7E69` | Subtitle and inactive tab |
| `--color-placeholder` | `#AA9B89` | Input/response placeholder text |
| `--color-action` | `#9D8465` | Send button |
| `--color-on-action` | `#FFFFFF` | Paper-plane icon |
| `--color-tab-track` | `#F0EAE1` | Segmented response control |
| `--color-tab-selected` | `#FFFFFF` | Selected Answer tab |
| `--color-response` | `#FAF7F2` | Response placeholder panel |
| `--color-success-bg` | `#DCF3E4` | Circular check background |
| `--color-success` | `#258650` | Check icon |
| `--color-error-border` | `#DE877B` | Invalid key outline |
| `--color-error-bg` | `#FCECE8` | Error banner |
| `--color-error-text` | `#B83E32` | Error text and exclamation mark |

Contrast has not been measured. Verify text, control, and focus contrast before implementation; any required visual changes should be reviewed.

## Typography

The screenshots show a clean sans-serif family. The exact font cannot be identified reliably; a system sans-serif stack is a proposed dependency-free starting point, not an approved font identification.

| Role | Approx. raster size | Proposed CSS size at assumed 2× | Approx. weight |
| --- | --- | --- | --- |
| “API Explorer” | 72 px | 36 px | 700 |
| Subtitle | 34 px | 17 px | 400 |
| “WEEK 01 / DAY 01” | 26 px | 13 px | 600 |
| Field/section labels | 24 px | 12 px | 600 |
| Input placeholder, tabs, response lead text | 30–32 px | 15–16 px | 400; selected tab 600 |
| Response supporting text | 26 px | 13 px | 400 |
| Invalid-key message | 30 px | 15 px | 400 |

Estimated line height: 1.2 for the heading and 1.4–1.5 for supporting text. Exact line heights, letter spacing, font metrics, and weights are unknown. Labels and course marker are uppercase; title and descriptive text use mixed case. Suggested token names: `--font-family`, `--font-size-title`, `--font-size-body`, `--font-size-label`, `--font-weight-semibold`.

## Layout dimensions and spacing

All geometry in this table is estimated from the screenshots. Position refers to the top-left raster origin.

| Element | Approximate raster geometry | Proposed CSS at assumed 2× |
| --- | --- | --- |
| Header | Centered text block; course marker near y=238, title y=305, subtitle y=419 | Marker top ~119 px; title ~153 px; subtitle ~210 px |
| Main card, both states | x=700, y=556; width 1480; height 1140 | x~350, y~278; width ~740; height ~570 px |
| Card content | x=776 through x=2104; width 1328 | ~38 px horizontal inset; width ~664 px |
| First label | y~632 | ~38 px below card top |
| API key input | x~776, y~684; 1328 × 116 | ~664 × 58 px |
| Default question field | y~918; 1328 × 128 | Top ~459; height ~64 px |
| Default response tabs | y~1194; 1328 × 96 | Top ~597; height ~48 px |
| Default response panel | y~1310; 1328 × 216 | Top ~655; height ~108 px |
| Invalid-state banner | x~776, y~820; 1328 × 92 | ~664 × 46 px; ~10 px below key field |
| Invalid-state question field | y~994 | Top ~497 px |
| Invalid-state response tabs/panel | y~1270 / 1386 | Top ~635 / 693 px |

The title block is slightly left of the main card's horizontal center in the supplied raster; preserve the visual reference when checking alignment rather than assuming exact common centering. The card itself is horizontally centered. No prominent shadow is visible.

Suggested approximate CSS spacing scale: `--space-1: 4px`, `--space-2: 8px`, `--space-3: 10px`, `--space-4: 16px`, `--space-5: 20px`, `--space-6: 32px`, `--space-7: 38px`, `--space-8: 44px`. This is a proposed reusable scale, not a recovered Figma scale. Use semantic aliases where useful, such as `--card-padding-inline` and `--field-padding-inline`.

The screenshots only establish a wide-screen layout. A fluid card capped near the proposed 740 px width with side gutters is a recommendation; mobile breakpoints, wrapping, scrolling, and content-driven card height remain unspecified. Avoid fixing response height in a way that clips actual answers.

## Radii, fields, and buttons

| Element | Approximate raster appearance | Proposed CSS at assumed 2× |
| --- | --- | --- |
| Card | ~44 px corner radius; ~2 px outline | `--radius-card: 22px`; ~1 px border |
| Fields | ~24 px radius; ~2 px neutral outline | `--radius-field: 12px`; ~1 px border |
| Invalid field | ~3 px coral outline | ~1.5 px border; preserve outer size |
| Send button | ~88 × 88 px; ~20 px radius | ~44 × 44 px; `--radius-button: 10px` |
| Tabs/response panel | ~20–24 px radius | `--radius-panel: 10px` to 12 px |
| Error banner | ~20 px radius | ~10 px |
| Key status badge | ~56 px diameter, circular | ~28 px diameter; full radius |

The key field spans the content width, displays masking dots, and has a green check badge at the right in the default reference. Estimated horizontal text inset is 36–40 raster px (~18–20 CSS px). The question field uses the same fill and outline, with “Type your question here...” at left and a brown paper-plane send button inset at the right (~10 CSS px). Whether the question control is single-line or multiline cannot be determined from the image.

The send icon is white and outlined, approximately 40 raster px (~20 CSS px). No hover, pressed, disabled, loading, or focus styles are supplied. Accessible labels, keyboard interaction, and a visible focus indicator are implementation requirements to resolve without adding product features.

The response control contains equal-width “Answer” and “Raw JSON” tabs on a warm neutral track. Answer is selected, shown as an inset white rounded segment with darker semibold text. Estimated track padding is 10 raster px (~5 CSS px). The response panel sits ~20 raster px (~10 CSS px) below the track and uses ~40 raster px (~20 CSS px) padding. The Raw JSON selected/content state is not pictured.

## Default state — directly observed

- Header: “WEEK 01 / DAY 01”, “API Explorer”, and “Ask a question. Explore the response.”
- Main card order: “API KEY (OPENAI)”, masked key field with green check, “YOUR QUESTION”, prompt field with send button, “RESPONSE”, tabs, response panel.
- Answer is selected. Panel copy: “Your answer will appear here.” and “The raw API response is available in the Raw JSON tab.”
- No error banner is visible. This is the supplied default presentation with a masked key, not evidence of an empty initial state or a verified successful authentication.

## Invalid-key state — directly observed

- Key field remains masked, gains a coral outline, and no longer shows the green check.
- A pale red banner appears immediately below it, with an exclamation mark and “Invalid API key. Check the key and try again.”
- Question and response sections move down by approximately 76 raster px (~38 CSS px at the assumed scale); card/header geometry appears unchanged.
- Prompt placeholder, send button appearance, selected Answer tab, and empty response copy remain visible. The image does not establish whether the button is enabled or how retry/reset behaves.

For future implementation, associate the error with the key field and announce it accessibly; use the icon/text as well as color. Do not expose a rejected key or unsanitized provider error in this banner. An expired/revoked credential should receive safe authentication guidance, but these screenshots do not define separate expired-key copy. Other HTTP/network errors, successful results, loading, and reset behavior require minimal specifications before implementation.

## Review boundary

Only image dimensions and observable content/state relationships are verified. All proposed colors, CSS sizes, font choices, spacing, radii, and responsive behavior require review. Recommend CSS custom properties for shared semantic colors, spacing, typography, and radii when implementation is authorized. Architecture and credential handling decisions are recorded in the root `AGENTS.md`; the user has since authorized the limited local browser-only experiment documented there. The implementation uses slightly darker placeholder text for readability, a centered heading, responsive gutters, and a content-driven card. The success check appears only after a successful request; the initial key field is empty.
