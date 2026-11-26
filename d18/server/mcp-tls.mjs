import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "undici";
import { McpProblem } from "./mcp-configuration.mjs";

const defaultDirectory = fileURLToPath(new URL("../data/mcp-tls/", import.meta.url));

export function connectionTlsPool(config, directory = process.env.DAY18_MCP_TLS_DIR || defaultDirectory) {
  const url = new URL(config.endpoint);
  if (url.protocol !== "https:" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(config.connectionId ?? ""))
    return undefined;

  const file = join(directory, config.connectionId, encodeURIComponent(url.hostname) + "_" + (url.port || "443") + ".pem");
  let pem;
  try {
    pem = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new McpProblem("tls_config");
  }
  try {
    if (!/^-----BEGIN CERTIFICATE-----[\r\n]+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/.test(pem.trim()))
      throw new Error();
    const certificate = new X509Certificate(pem);
    // This pool can connect to one origin only. Node still verifies the peer
    // chain, validity period and DNS name or IP against the certificate.
    return new Pool(url.origin, {connect: {ca: certificate.toString(), rejectUnauthorized: true}});
  } catch {
    throw new McpProblem("tls_config");
  }
}
