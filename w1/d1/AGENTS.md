# API Explorer — Week 01 / Day 01

## Scope and current phase

Build a minimal API Explorer for the OpenAI API. Keep the implementation simple and appropriate for Day 01. Documentation and design review are complete. Implementation is authorized using HTML, CSS, vanilla JavaScript, and native fetch(). Keep the first version small and understandable.

Follow the approved Figma design as represented by the local references `design/default_state.png` and `design/Invalid_state.png`. The latter is the supplied invalid-key reference; the requested filename `design/invalid_key_state.png` is not present. Do not rename or modify the references. Consult `design/design_tokens.md`; screenshot estimates are not exact Figma specifications.

## Required behavior

- Support entering an API key and sending a prompt.
- Display the API response, following the pictured Answer and Raw JSON presentation.
- Handle invalid or expired API keys and common HTTP and network errors explicitly.
- Distinguish authentication failures from permission failures, rate limits/quota issues, server errors, timeouts, connectivity failures, and malformed/unexpected responses. Do not label every failure as an invalid key.
- Display concise, sanitized messages. The approved invalid-key message is: “Invalid API key. Check the key and try again.” Never display raw provider errors that could contain credentials or request details.
- Keep keys masked by default; the user-authorized eye toggle may reveal/hide the value without changing verification or Send state. The green check in the reference does not establish a validation mechanism; do not claim authentication succeeded based only on key presence or format.
- Render Answer Markdown with locally vendored marked.js followed by DOMPurify sanitization before DOM insertion. Never insert unsanitized generated HTML. Keep Raw JSON as text; exclude credentials, authorization headers, and sensitive request/debug details. These two libraries are explicitly authorized; no CDN, npm, build tools, or backend.
- Do not introduce unnecessary frameworks or dependencies, or add unrequested features.

## Approved educational architecture

The user accepts direct browser requests for this local educational experiment only. Use static `index.html`, `styles.css`, and `app.js`, opened locally without a backend, proxy, Node.js server, framework, or dependencies. Do not install dependencies or bypass browser security restrictions.

Send requests to `https://api.openai.com/v1/responses` with `gpt-5.4-mini`, using JSON input and `store: false`. Extract text from message content items of type `output_text`; display refusals as text too. Display sanitized response JSON, never request headers or raw HTTP error bodies. Use a 60-second timeout and no automatic retries. `store: false` does not guarantee zero provider retention.

The manually entered key remains masked in current-page memory for subsequent requests; clear the field on page navigation. Never persist it. After 600 ms without key edits, verify using a small authenticated GET to `/v1/models/gpt-5.4-mini`. Show a loader and disable Send until that check succeeds. Cancel pending/stale checks on edits and navigation. The green check means this metadata request succeeded, not that generation or billing is guaranteed. On any verification failure show a generic verification message; only a readable HTTP 401 warrants the invalid-key state. Verification does not populate Answer/Raw JSON. Disabling autocomplete is a browser hint, not a guarantee against password-manager behavior.

Browser JavaScript, extensions, and developer tools can access the key. This approach is not secure for production. CORS, local-file origin policies, or browser/network restrictions may prevent requests. Report HTTP status where available; a fetch TypeError cannot reliably distinguish CORS from DNS/TLS, connectivity, or browser blocking. Report that limitation and let the mentor inspect the sanitized browser error category. Never automatically add a workaround or claim a specific CORS cause without evidence.

Official references consulted for the endpoint, output structure, and model:
- https://developers.openai.com/api/docs/guides/text
- https://developers.openai.com/api/docs/models/gpt-5.4-mini

Model access, account billing, and browser compatibility must be established by the mentor's manual request. Do not claim live integration success until a real request succeeds. Do not ask for, inspect, or use the mentor's real key during automated tests.

## Global security and Git requirements

Follow all global security instructions supplied by the user, including:

- Never read, open, print, or inspect real secret files, `.env`, `.env.local`, credentials, private keys, tokens, password stores, or secret managers. Never request real keys, passwords, or tokens.
- Never hardcode secrets or include them in logs, tests, documentation, commits, or unnecessary external transmissions. The app may transmit a user-entered key only through the explicitly approved authentication path. Never log, persist, or expose API keys unnecessarily; do not store them in browser storage, cookies, saved form state, or files.
- Use placeholder values in `.env.example` if configuration documentation is later authorized. Do not create real credential files.
- Diagnose authentication with HTTP status codes and sanitized errors. Explain likely causes and let the user independently verify real credentials; never inspect the key to debug a failure.
- Never commit secrets. Ensure sensitive files are excluded by the repository-root `.gitignore`; check staged changes for accidental secrets without opening secret files. The user authorizes the restructuring commit and initial SSH push to the public `ai-engineering-challenge` repository after checks pass. Preserve history; do not disable security checks.
- Use least privilege. Ask before destructive operations, dependency installation, or changes to security settings. Avoid accessing files outside the project unless necessary.
- Prefer simple, modular, maintainable, testable code and explicit error handling. Explain important architectural choices and uncertainty. Claim tests passed only if executed.

## Implementation boundaries

Application source files are authorized. Preserve global security requirements and reference images. Do not add unnecessary features, dependencies, a server, or a proxy. Update documentation when behavior changes. Stop after implementation, checks, and a report of files, local run/test instructions, and known limitations; wait for review.

## Mandatory: no CI/CD

This standalone project now lives in `w1/d1/`. Open `w1/d1/index.html` from the repository root. Use only local validation/static checks and Git/GitHub source versioning/sharing. Do not add CI/CD, `.github/workflows`, automated build/test pipelines, hosting, deployment, Docker, npm, build tools, or additional infrastructure.
