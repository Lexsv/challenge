// Run after pnpm build. CHROME_BIN can point to another local Chrome installation.
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { preview } from "vite";
import { verifySessionMcpSelection } from "./session-mcp-browser.mjs";
import { createSessionServer } from "../server/sessions.mjs";
import { createMcpRepository } from "../server/mcp-repository.mjs";

const temp = await mkdtemp(join(tmpdir(), "day16-browser-")),
  dbPath = join(temp, "fixture.sqlite");
const store = {
  status: async () => false,
  forget: async () => {},
  read: async () => {
    throw Error("No fixture credential");
  },
};
const api = createSessionServer(dbPath, { credentialStore: store }),
  db = new DatabaseSync(dbPath);
const repo = createMcpRepository(db),
  id = crypto.randomUUID(),
  name = "Catalog fixture",
  desc = "Fixture description ".repeat(95).trim();
const cfg = {
  name,
  endpoint: "https://fixture.example/mcp",
  description: desc,
  transport: "sse",
  auth: { type: "none" },
};
repo.save(id, cfg, null, undefined, true);
repo.synchronize(
  id,
  1,
  Array.from({ length: 80 }, (_, i) => ({
    name: "tool-" + String(i).padStart(2, "0"),
    description:
      i === 1 ? "Long tool description. ".repeat(350) : "Short description",
    inputSchema: {
      type: "object",
      properties: {
        detail: { type: "string", description: "x".repeat(i === 1 ? 3000 : 3) },
      },
    },
    outputSchema: { type: "object" },
    _meta: { source: "fixture" },
  })),
);
const other = repo.save(
  crypto.randomUUID(),
  { ...cfg, name: "Second fixture", endpoint: cfg.endpoint + "?tenant=two" },
  null,
  undefined,
  true,
);
db.prepare("INSERT INTO custom_functions VALUES(?,?,?,?)").run(
  "function-fixture",
  "Formula fixture",
  desc,
  "test",
);
let chrome, ui, socket;
const calls = new Map();
let seq = 0;
async function waitFor(fn, label) {
  for (let i = 0; i < 150; i++) {
    const result = await fn();
    if (result) return result;
    await delay(100);
  }
  throw Error("Timed out waiting for " + label);
}
async function command(method, params = {}) {
  const id = ++seq;
  const result = new Promise((resolve, reject) =>
    calls.set(id, { resolve, reject }),
  );
  socket.send(JSON.stringify({ id, method, params }));
  return result;
}
async function evaluate(expression) {
  const result = await command("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails)
    throw Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text,
    );
  return result.result.value;
}
try {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  ui = await preview({
    configFile: false,
    logLevel: "silent",
    preview: {
      host: "127.0.0.1",
      port: 0,
      proxy: { "/api": { target: "http://127.0.0.1:" + api.address().port } },
    },
  });
  const url = "http://127.0.0.1:" + ui.httpServer.address().port;
  chrome = spawn(
    process.env.CHROME_BIN ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless",
      "--disable-gpu",
      "--no-first-run",
      "--disable-sync",
      "--disable-background-networking",
      "--password-store=basic",
      "--remote-debugging-port=0",
      "--user-data-dir=" + join(temp, "profile"),
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const port = await waitFor(async () => {
    try {
      return (
        await readFile(join(temp, "profile", "DevToolsActivePort"), "utf8")
      ).split("\n")[0];
    } catch {
      return false;
    }
  }, "disposable Chrome");
  const targets = await (
    await fetch("http://127.0.0.1:" + port + "/json/list")
  ).json();
  socket = new WebSocket(
    targets.find((t) => t.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((resolve) =>
    socket.addEventListener("open", resolve, { once: true }),
  );
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data),
      pending = calls.get(message.id);
    if (!pending) return;
    calls.delete(message.id);
    if (message.error) pending.reject(Error(message.error.message));
    else pending.resolve(message.result);
  });
  const viewport = (width, height) =>
    command("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  await viewport(1280, 800);
  await command("Page.navigate", { url });
  const toolsTab =
    "[...document.querySelectorAll('[role=tab]')].find(t => t.textContent.trim() === 'Tools')";
  await waitFor(() => evaluate("!!" + toolsTab), "Tools tab");
  await evaluate(toolsTab + ".click()");
  await waitFor(
    () =>
      evaluate(`(() => {
    const names = Array.from(document.querySelectorAll('table[aria-label="Custom tools"] tbody th'), cell => cell.textContent);
    return names.includes('Catalog fixture') && names.includes('Formula fixture');
  })()`),
    "saved fixture rows",
  );
  const button = (text) =>
    `[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(text)})`;
  const click = (expr) => evaluate(expr + ".click()");
  const dialog = 'document.querySelector("[role=dialog]")';
  const row = await evaluate(
    `(()=>{const t=document.querySelector('table[aria-label="Custom tools"]');const r=Array.from(t.rows).find(r=>r.cells[0].textContent==='Catalog fixture');const d=r.cells[2].firstChild;return {headers:[...t.rows[0].cells].map(c=>c.textContent),cols:[...r.cells].map(c=>c.textContent),clamped:getComputedStyle(d).webkitLineClamp==='2' && d.scrollHeight>d.clientHeight,formula:[...t.rows].find(r=>r.cells[0].textContent==='Formula fixture').cells[3].textContent}})()`,
  );
  assert.deepEqual(row.headers, [
    "Name",
    "Type",
    "Description",
    "Tools",
    "Actions",
  ]);
  assert.deepEqual(row.cols.slice(0, 4), [name, "MCP Plugin", desc, "80"]);
  assert.ok(row.clamped);
  assert.equal(row.formula, "—");
  await click(button(name));
  await waitFor(
    () =>
      evaluate("!!document.querySelector('[role=dialog] section[tabindex]')"),
    "catalog",
  );
  for (const [w, h] of [
    [1280, 800],
    [390, 740],
  ]) {
    await viewport(w, h);
    await delay(250);
    const geometry = () =>
      evaluate(
        `(()=>{const d=${dialog},left=d.querySelector('nav'),right=d.querySelector('section');return [d,d.querySelector('header'),left,right,d.querySelector('.MuiDialogActions-root')].map(el=>{const {x,y,width,height}=el.getBoundingClientRect();return [x,y,width,height]})})()`,
      );
    const short = await geometry();
    await evaluate(
      `(()=>{const l=${dialog}.querySelector('nav');l.scrollTop=70;l.querySelectorAll('[role=button]')[1].click()})()`,
    );
    await delay(50);
    assert.deepEqual(await geometry(), short);
    const checked = await evaluate(
      `(()=>{const d=${dialog},left=d.querySelector('nav'),right=d.querySelector('section'),pre=right.querySelector('pre');right.scrollTop=80;pre.scrollLeft=130;return {master:left.scrollTop,details:right.scrollTop,json:pre.scrollLeft,header:d.querySelector('header').textContent}})()`,
    );
    assert.equal(checked.master, 70);
    assert.ok(checked.details > 0 && checked.json > 0);
    assert.ok(
      checked.header.includes(desc) &&
        checked.header.includes("80 tools") &&
        checked.header.includes("Last successful discovery"),
    );
    await evaluate(`${dialog}.querySelector('nav [role=button]').click()`);
    await delay(50);
    assert.deepEqual(await geometry(), short);
    assert.deepEqual(
      await evaluate(
        `[${dialog}.querySelector('nav').scrollTop,${dialog}.querySelector('section').scrollTop]`,
      ),
      [70, 0],
    );
    console.log(
      w +
        "×" +
        h +
        " dialog geometry stable " +
        JSON.stringify(short[0]) +
        ", independent scrolling verified",
    );
  }
  await click(button("Close"));
  await delay(300);
  const edit =
    "document.querySelector('button[aria-label=\"Settings for Catalog fixture\"]')";
  await click(edit);
  const enter = async (value) =>
    evaluate(
      `(()=>{const d=${dialog};const label=[...d.querySelectorAll('label')].find(l=>l.textContent.startsWith('Endpoint'));const el=document.getElementById(label.htmlFor);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
  await enter("HTTPS://FIXTURE.EXAMPLE:443/mcp?tenant=two");
  await delay(50);
  assert.ok(
    await evaluate(
      `${button("Save settings")}.disabled && ${dialog}.textContent.includes('already belongs')`,
    ),
  );
  await enter("https://FIXTURE.EXAMPLE:443/mcp");
  await delay(50);
  assert.equal(await evaluate(button("Save settings") + ".disabled"), false);
  await click(button("Cancel"));
  await delay(300);
  await viewport(1280, 800);
  await verifySessionMcpSelection({ api, db, command, evaluate, waitFor });
  const del =
    "document.querySelector('button[aria-label=\"Delete Catalog fixture\"]')";
  await click(del);
  assert.ok(
    await evaluate(dialog + '.textContent.includes("Catalog fixture")'),
  );
  await click(button("Cancel"));
  await delay(300);
  assert.equal(repo.get(id).toolCount, 80);
  await click(del);
  await click(button("Delete"));
  await waitFor(() => evaluate("!" + del), "removed row");
  assert.equal(db.prepare("SELECT count(*) AS n FROM session_mcp_connections").get().n, 0);
  assert.throws(() => repo.get(id), { code: "missing" });
  assert.equal(repo.get(other.connectionId).name, "Second fixture");
  console.log(
    "Table, editor validation, cancel and confirmed local deletion verified",
  );
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) {
    const exit = once(chrome, "exit");
    chrome.kill();
    await exit;
  }
  if (ui) await ui.close();
  if (api.listening) {
    const closed = once(api, "close");
    api.close();
    api.closeAllConnections();
    await closed;
  }
  db.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 3 });
}
