import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { PORT, HOST } from "./config.js";
import { verifyAddressesOnChain, ENTRYPOINT_V07, SMART_SESSIONS_MODULE } from "./addresses.js";

/**
 * Cyppie `aa-trigger` (KAN-139) — builds/submits ERC-4337 UserOps via permissionless.js/Pimlico for the
 * Kotlin User-Service. Loopback-only. 🔑 Auth ≠ Custody: the main key never leaves the device — for DCA
 * the app signs the userOpHash; the backend only builds + submits (ADR-0024, Q1 per-feature).
 *
 * Ph1 increment 1: service skeleton + the on-chain address gate + /healthz. The /v1/userop/* handlers
 * (build/submit/status via permissionless) land in increment 2.
 */
function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (method === "GET" && url === "/healthz") {
    return send(res, 200, {
      status: "ok",
      service: "aa-trigger",
      entryPoint: ENTRYPOINT_V07,
      smartSessions: SMART_SESSIONS_MODULE,
    });
  }
  if (method === "POST" && url === "/v1/userop/build") {
    return send(res, 501, { error: "userop/build not yet implemented (Ph1 increment 2)" });
  }
  if (method === "POST" && url === "/v1/userop/submit") {
    return send(res, 501, { error: "userop/submit not yet implemented (Ph1 increment 2)" });
  }
  if (method === "GET" && url.startsWith("/v1/userop/")) {
    return send(res, 501, { error: "userop status not yet implemented (Ph1 increment 2)" });
  }
  if (method === "POST" && url === "/v1/session/trigger") {
    return send(res, 501, { error: "session/trigger not yet implemented (Ph2)" });
  }
  send(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => send(res, 500, { error: String(e instanceof Error ? e.message : e) }));
});

async function main(): Promise<void> {
  // Fail-closed: never serve unless the SDK-pinned AA addresses are verified on-chain (ETH + Base).
  await verifyAddressesOnChain();
  server.listen(PORT, HOST, () => {
    console.log(`aa-trigger listening on ${HOST}:${PORT} — addresses verified on ETH + Base`);
  });
}

main().catch((e) => {
  console.error("aa-trigger failed to start:", e);
  process.exit(1);
});
