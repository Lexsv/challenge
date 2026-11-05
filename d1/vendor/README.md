# Local browser libraries

Loaded as classic scripts before `app.js`, including when opening `index.html` with `file://`. No runtime CDN requests, package manager, or build step.

- **marked 18.1.3**: `marked.umd.js`, copied unchanged from `package/lib/marked.umd.js` in the official release archive at https://registry.npmjs.org/marked/-/marked-18.1.3.tgz. Project: https://github.com/markedjs/marked/releases/tag/v18.1.3. License: `marked.LICENSE` (MIT).
- **DOMPurify 3.4.17**: `purify.min.js`, copied unchanged from https://raw.githubusercontent.com/cure53/DOMPurify/3.4.17/dist/purify.min.js. Project: https://github.com/cure53/DOMPurify/releases/tag/3.4.17. License: `DOMPurify.LICENSE` (Apache-2.0 OR MPL-2.0).

Retain upstream copyright/license headers. Upstream source-map comments may reference maps that are not vendored; they are not required to run the app.

`renderAnswer()` parses GFM and passes the result through DOMPurify with a narrow tag/attribute allowlist and a sanitized DOM fragment. Images, styles, forms, embedded content, event handlers, and executable URLs are not allowed. Links permit only HTTP(S), mailto, and fragment URLs. Raw JSON stays plain text. If either library is unavailable/unsupported or rendering fails, Answer remains plain text.

When updating these copies, use pinned official releases, retain licenses, and rerun browser rendering and malicious-Markdown checks. No real credentials are needed for those checks.
