# API Explorer — Day 2

A local, dependency-free HTML/CSS/vanilla JavaScript tool for manually comparing output controls across providers. Open `index.html` directly (`file://`). There is no build, backend, proxy, CDN, persistent storage, or automated experiment runner. [Lavender design reference](design/Lavender%20API%20Explorer%20with%20Cyrillic%20history.png).

The Prompt field starts empty with **Enter your prompt here** as a placeholder. Placeholder text is never submitted. Send requires a real non-whitespace prompt, model ID, and key, and is disabled during a user request or verification. Successful Verify is helpful but not required to Send.

## Providers and documented model choices

Official documentation was checked on **November 3, 2026**. Small/medium/large labels are approximate cost/capability positions *within* a provider, not equivalent capabilities across providers. Each menu also has a Custom model ID option; custom compatibility is unverified.

| Provider | Small | Medium | Large | Default |
| --- | --- | --- | --- | --- |
| OpenAI | `gpt-4o-mini` | `gpt-4.1-mini` | `gpt-4.1` | `gpt-4.1-mini` |
| Google Gemini | `gemini-3.5-flash-lite` | `gemini-3.8-flash` | `gemini-4-argon` | `gemini-3.5-flash-lite` |
| Anthropic Claude | `claude-haiku-5-5` | `claude-sonnet-5-5` | `claude-opus-5-5` | `claude-haiku-5-5` |

OpenAI remains the initial provider. Its listed models support Chat Completions and Structured Outputs, but are deprecated with shutdown scheduled for January 14, 2027. They remain documented API options as of the review date; actual project access is untested. GPT-4.1 nano was already shut down and is deliberately not offered. Recheck lifecycle documentation before future use.

Official model sources:

- OpenAI: [GPT-4o mini](https://developers.openai.com/api/docs/models/gpt-4o-mini), [GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini), [GPT-4.1](https://developers.openai.com/api/docs/models/gpt-4.1), [deprecations](https://developers.openai.com/api/docs/deprecations).
- Gemini: [3.5 Flash-Lite](https://aistudio.google.com/docs/models/gemini-3.5-flash-lite), [3.8 Flash](https://aistudio.google.com/docs/models/gemini-3.8-flash), [4 Argon](https://aistudio.google.com/docs/models/gemini-4-argon). Older 2.5 options have account/lifecycle restrictions and are not the presets.
- Claude: [current model IDs and capabilities](https://platform.claude.com/docs/en/models/overview).

Changing provider updates model choices, endpoint, parameter defaults. Technical compatibility and availability guidance is documented here rather than persistently displayed in the connection section. It clears and re-masks the key and resets verification, preserving the prompt and all history. If parameter rows differ from that provider's initial rows (including enabled states), a confirmation explains replacement before anything is discarded. Cancel preserves the previous provider, rows, and key. Model changes preserve rows and prompt; they reset verification without silently adapting parameters.

## Native adapters and parameters

`providers.js` contains small adapters for wire bodies, headers, verification, text extraction, completion/refusal states, usage, and format/schema extraction. Raw provider responses remain native; they are not rewritten into an OpenAI envelope.

| Provider | Endpoint / authentication | Editable initial rows | Mandatory controls |
| --- | --- | --- | --- |
| OpenAI | `POST https://api.openai.com/v1/chat/completions`; Authorization bearer header | `max_completion_tokens: 300`, `stop: ["END"]`, `response_format` with strict JSON Schema; all disabled | App supplies model, one user message, and `stream: false` |
| Gemini | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`; `x-goog-api-key` header | `maxOutputTokens: 300`, `stopSequences: ["END"]`, `responseMimeType: "application/json"`, `responseJsonSchema`; all disabled | App supplies contents; enabled table fields are placed unchanged inside `generationConfig` |
| Claude | `POST https://api.anthropic.com/v1/messages`; `x-api-key` and `anthropic-version: 2023-06-01` headers | `max_tokens: 300` enabled, `stop_sequences: ["END"]` disabled, `output_config` with `format.type: "json_schema"` disabled | A positive `max_tokens` is required; disabling/deleting its row is invalid, not an unrestricted request |

For Gemini, enable both `responseMimeType` and `responseJsonSchema` to request constrained JSON. This is a native schema feature, not an OpenAI `strict` flag. For Claude, the schema is in `output_config.format.schema`. The default example schema across adapters is an object with required `answer` string and `items` array of strings, with no extra properties. Provider schema subsets and guarantees differ.

Rows remain editable even when disabled. Disabled rows are omitted exactly; enabled values parse as JSON, preserving types (`300`, `true`, `null`, `"text"`, arrays, objects). Quote strings. Add/delete rows with +/×. Value fields fit one to four visible lines, including wrapping and newlines, then scroll; sizing never changes their value. Sizing reacts to input/paste, new rows, fonts, and layout width. Delete buttons remain centered.

Completely empty rows are ignored. Incomplete enabled rows, invalid/unrepresentable JSON, duplicate keys, credential fields, and application-controlled fields are rejected locally. Provider-specific reserved fields prevent overriding message contents, model, streaming, or nested app-controlled containers. The Gemini table is explicitly a `generationConfig` editor, not an arbitrary top-level request editor. Enabled native controls are never silently renamed, dropped, converted to prompt instructions, or simulated by trimming output.

Known mismatches produce row errors: OpenAI o3/o4-mini do not support stop; Gemini schema needs JSON MIME type; sampling controls that newer Gemini models ignore are blocked rather than presented as effective. Cross-provider names such as OpenAI `stop` on Gemini are rejected. Other unknown native controls are submitted unchanged and the actual API error is shown. Model menus do not imply every parameter is supported; custom models need their own documentation review.

Request and structured-output references:

- [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=chat). The assignment's older/generic `max_tokens` name is deprecated here in favor of `max_completion_tokens`. Chat Completions is used for a real API `stop` parameter rather than Responses.
- [Gemini generateContent request, configuration, and finish reasons](https://aistudio.google.com/api-reference/generate-content/generate-content), [structured output guide](https://aistudio.google.com/docs/structured-output), [API-key authentication](https://aistudio.google.com/docs/api-key). This app uses the documented generateContent API rather than adding the separate Interactions API. Stop sequences and output caps use its native names; newer sampling controls may be ignored by the service, so known cases are blocked locally.
- [Claude Messages](https://platform.claude.com/docs/en/api/messages/create), [JSON schema output_config](https://platform.claude.com/docs/en/build-with-claude/structured-outputs). Native `stop_reason` values such as `end_turn`, `stop_sequence`, `max_tokens`, and `refusal` are retained.

## Browser feasibility and verification

**Live Claude requests are unavailable in this version.** Anthropic's [official browser documentation](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript#browser-usage) requires an explicit browser-risk opt-in because page code exposes keys. That opt-in was not authorized here: no dangerous browser-access header or SDK flag is enabled. Claude's adapter, models, and parameter controls are implemented, but its key field, Verify, and Send are disabled. The connection section omits persistent technical explanations; this README records the limitation. Entering a key is not a workaround. Enabling that mode or adding a backend requires a separate explicit decision; neither was silently added.

| Provider | file:// UI check | Direct authenticated API status |
| --- | --- | --- |
| OpenAI | Chrome page/model menu and mocked request exercised | Untested: no authorized key used; actual CORS, model access, billing, and file-origin behavior unknown |
| Gemini | Chrome page/model/endpoint changes and mocked native request exercised | Untested: key restrictions, API enablement, permissions, CORS, and file-origin behavior unknown |
| Claude | Browser UI shows limitation and disables live requests | Unavailable by design pending explicit browser-risk opt-in; live requests disabled; see limitation above |

No real provider calls were made. Browser UI success does not establish API access. Gemini keys may be restricted by project or origin; do not loosen those settings as an automatic workaround. A fetch failure cannot reliably distinguish CORS, DNS/TLS, connectivity, extensions, or browser/file-origin restrictions. Do not bypass browser security or add a third-party proxy.

For a local-origin comparison, an already-installed Python runtime can optionally serve only this directory: `python3 -m http.server 8000 --bind 127.0.0.1`. Open `http://127.0.0.1:8000/`. This does not remove API CORS requirements and must not serve credential files. No server was added or started during this update.

Verify makes a minimal provider-native completion, independently of optional experiment rows: OpenAI uses an 8-token cap; Gemini a 16-token cap; the unavailable Claude adapter defines a 64-token cap. It may consume tokens and billing quota. The success text is simply **Connection verified**. The visible note remains “Verify makes a small request and may consume tokens.” Actionable failures remain inline. A returned textual response establishes only that this small call worked, not that a full generation or every experiment control will work. Verification calls never enter history. Key/provider/model changes reset verification and abort/ignore stale checks. Visibility changes do not reset it. Checking and sending prevent duplicate calls; Send does not require successful verification. Requests are non-streaming with a 60-second timeout and no automatic retry. HTTP, sanitized provider errors, and transport failures are kept distinct.

## Credentials and session-only history

Keys remain masked by default and in page memory only. They are sent only through the selected adapter's authentication header to its fixed provider host, never in URLs, request JSON, history, inspectors, logs, storage, source, or documentation. Provider switching clears them; navigation and initialization clear them. Redirects are rejected. Autocomplete hints cannot control every password manager. This educational local-browser tool does not isolate keys from browser scripts/extensions/devtools.

Content containing the submitted key or secret-like text is rejected before submission/history; echoed keys and named credential fields in responses are redacted before retention/display. Output checks run on exact generated text before that privacy redaction. Original therefore means the exact *saved* text, subject to existing credential redaction. All content uses text-only DOM rendering; HTML-like model output is never executed.

Each user request actually sent creates a newest-first entry, including failures. Local validation failures and Verify do not. Entries save provider ID/name, model, endpoint, submitted parameters/body/schema, timestamp/duration, actual HTTP status, usage, original generated content, native raw response/error, completion reasons, and validation outcomes. All stay in memory; reload clears history. Labels use the first 20 Unicode code points, including Cyrillic, with an ellipsis only when longer.

Selecting history changes only the inspector, never the selected provider, current form, or network. History survives provider switches. Clear removes entries and selection, leaves the form unchanged, and is disabled while sending. The sidebar layout and red error styling are retained.

## Validation and inspector

Validation is based on the immutable submitted request's provider-native schema, saved as a normalized validation descriptor alongside its unchanged wire body. It never reads the current form. For OpenAI `response_format.type: "json_schema"`, Gemini's saved `responseJsonSchema`, or Claude's `output_config.format`, parse the exact generated assistant text and validate it against the saved schema. The app retains its broader behavior of validating an explicitly submitted schema even if OpenAI `strict` is omitted/false.

Parsing and schema outcomes are separate. A parsing failure under a schema shows **Response format error** and **Schema validation: Not performed — invalid JSON**. Mismatch shows the specific schema path/issue and makes history red. Valid parsing plus supported-schema validation shows **Format valid**, which does not establish factual correctness, relevance, or completeness. Without a submitted schema, parse failures on prose/Markdown remain informational and do not independently make history red. No Markdown fences are stripped and no JSON is repaired.

The small local validator implements an explicit JSON Schema 2020-12 subset: boolean schemas; `type` (including arrays), `enum`, `const`; `properties`, `required`, `additionalProperties`; `items`, `minItems`, `maxItems`; `minLength`, `maxLength` (Unicode code points); `minimum`, `maximum`; title/description annotations and the 2020-12 dialect declaration. All schema branches are audited. Unsupported/malformed schemas, `$ref`, `$defs`, composition, patterns, formats, other dialects/keywords, and nesting limits yield **Unsupported**, never a validation success. Schema nesting is capped at 64 and value validation at 128. This subset differs from each provider's own supported subset. No schema is silently rewritten to fit it.

Top-of-inspector summaries remain visible across Response, Request, and Raw JSON. They show actual HTTP status, warnings, errors/refusals, JSON parsing, schema outcomes, and non-routine completion reasons. The routine green **Complete · finish_reason: stop** indicator is removed, with no replacement completion-success banner. A natural stop is not an error. Actual native reasons remain in saved entries and Raw JSON.

Token-limit reasons (`length`, Gemini `MAX_TOKENS`, Claude `max_tokens`) show **Incomplete — token limit reached**, a warning, and red history styling, independently of format checks. Usage equaling a cap is not used to infer truncation. Refusals, API errors, malformed envelopes, filtering/tool-only/unknown completions remain distinct and red. One unsuccessful/incomplete choice marks the whole entry red.

All three tabs share safe two-space JSON formatting/highlighting. Response has Formatted / Original for successfully parsed JSON, defaulting to Formatted except truncated text defaults to Original. Ordinary/malformed/fenced text stays original; non-JSON raw bodies are labeled. Long content wraps on narrow screens. Per-completion toggles do not modify saved data, validation, or completion reasons.

## Manual assignment experiments — real results Not run

Use one provider/model/base task at a time and run each variant at least three times manually; there is no experiment runner. A possible base task is “Explain three benefits of automated testing.” Type it into the initially empty prompt. Preserve the task and model, changing one control at a time before combinations.

1. Baseline: optional controls disabled. Claude's token budget is still mandatory; its live integration is unavailable here.
2. Natural-language format instruction: append “Return only a JSON object with an answer string and an items array of strings. Do not include Markdown.” This is not a hidden app instruction.
3. Token limit: enable the provider's documented cap. Record the actual value; separately try a small cap to observe truncation.
4. Stop comparison: ask for `END` after the intended answer followed by extra text. Run the identical prompt with the native stop row disabled and enabled. The stop sequence is sent to the API, never simulated locally.
5. Schema: enable the native JSON schema control (and JSON MIME type for Gemini). Inspect parsing and schema separately. No optional user controls does not mean no provider/model limits.

| Variant | Runs | Enabled controls | Completion reason | JSON parsing | Schema validation | Observed failure |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline | 1–3, each Not run | None optional | Not run | Not run | Not run | Not run |
| Natural-language format | 1–3, each Not run | Instruction in prompt | Not run | Not run | Not run | Not run |
| Token limit | 1–3, each Not run | Native cap, record value | Not run | Not run | Not run | Not run |
| Stop comparison | 1–3, each Not run | None; END prompt | Not run | Not run | Not run | Not run |
| Real stop | 1–3, each Not run | Native stop | Not run | Not run | Not run | Not run |
| Schema | 1–3, each Not run | Native schema/MIME controls | Not run | Not run | Not run | Not run |

**Conclusion: Not run.** No observed real model outcomes exist. Complete authorized provider runs privately, save observations before reloading, and conclude only from actual responses and reasons. Only actual authorized provider responses count as assignment evidence.

## Local validation

The repository does not include dedicated automated-check files, CI/CD configuration, deployment configuration, or GitHub Pages setup. Local cleanup checks cover JavaScript syntax, application file references, the intended staged diff, and exclusion of credentials/temporary artifacts. Runtime parameter validation, output JSON parsing, schema validation, and provider error handling remain part of the application.

Real provider access, billing, network/key restrictions, output-control compatibility under actual accounts, and additional browsers remain unverified. Claude live integration is explicitly unavailable rather than merely untested. No real provider calls were made during cleanup.

## Design

[View the Lavender API Explorer design](design/Lavender%20API%20Explorer%20with%20Cyrillic%20history.png)

![Lavender API Explorer design](design/Lavender%20API%20Explorer%20with%20Cyrillic%20history.png)
