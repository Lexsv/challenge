import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCatalog } from "./mcp-discovery.mjs";
import { connectionTlsPool } from "./mcp-tls.mjs";

test("private trust is scoped to one connection and HTTPS origin and still verifies peer identity", async t => {
  const dir = await mkdtemp(join(tmpdir(), "d18-tls-test-"));
  t.after(() => rm(dir, {recursive: true, force: true}));
  // Disposable local peer. The IP SAN intentionally excludes the DNS name localhost.
  await writeFile(join(dir, "test.cnf"), [
    "[req]", "distinguished_name=dn", "x509_extensions=extensions", "prompt=no",
    "[dn]", "CN=fixture", "[extensions]", "subjectAltName=IP:127.0.0.1",
  ].join("\n"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-config", "test.cnf", "-keyout", "fixture.key", "-out", "public.pem"], {cwd: dir, stdio: "ignore"});
  const cert = await readFile(join(dir, "public.pem"));
  let received = 0;
  const server = createServer({cert, key: await readFile(join(dir, "fixture.key"))}, async (req, res) => {
    received++;
    if (req.headers.authorization !== "Bearer fixture-only") return res.writeHead(401).end();
    if (req.method !== "POST") return res.writeHead(405).end();
    let input = "";
    for await (const chunk of req) input += chunk;
    const msg = JSON.parse(input);
    if (!("id" in msg)) return res.writeHead(202).end();
    const result = msg.method === "initialize"
      ? {protocolVersion: msg.params.protocolVersion, capabilities: {tools: {}}, serverInfo: {name: "fixture", version: "1"}}
      : {tools: [{name: "lookup", inputSchema: {type: "object"}}]};
    res.writeHead(200, {"content-type": "application/json"}).end(JSON.stringify({jsonrpc: "2.0", id: msg.id, result}));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const {port} = server.address();
  const config = {connectionId: randomUUID(), endpoint: "https://127.0.0.1:" + port + "/mcp",
    transport: "streamable-http", auth: {type: "bearer"}};
  const discover = (target, token = "fixture-only") => discoverCatalog(target, [token], {tlsDirectory: dir});
  await assert.rejects(discover(config), {code: "tls"});
  const folder = join(dir, config.connectionId);
  await mkdir(folder);
  const trust = join(folder, "127.0.0.1_" + port + ".pem");
  await writeFile(trust, cert);
  assert.deepEqual((await discover(config)).map(tool => tool.name), ["lookup"]);
  await assert.rejects(discover(config, "incorrect"), {code: "authentication", status: 401});
  const before = received;
  await assert.rejects(discover({...config, connectionId: randomUUID()}), {code: "tls"});
  assert.equal(connectionTlsPool({...config, endpoint: "https://127.0.0.1:1/mcp"}, dir), undefined);
  const mismatch = {...config, endpoint: "https://localhost:" + port + "/mcp"};
  await writeFile(join(folder, "localhost_" + port + ".pem"), cert);
  await assert.rejects(discover(mismatch), {code: "tls"});
  await writeFile(trust, "invalid fixture certificate");
  await assert.rejects(discover(config), {code: "tls_config"});
  assert.equal(received, before, "failed TLS checks must precede authenticated HTTP requests");
});
