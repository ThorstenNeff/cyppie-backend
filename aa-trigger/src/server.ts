import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Address, Hex } from "viem";
import { PORT, HOST } from "./config.js";
import { verifyAddressesOnChain, ENTRYPOINT_V07, SMART_SESSIONS_MODULE, CHAINS, type SupportedChainId } from "./addresses.js";
import { buildUserOp, submitUserOp, userOpReceipt, chainCtxFor, type Call, type SignedAuthorization, type SerializedUserOp } from "./userop.js";
import { defaultRegistry, GateError, type CopyScope } from "./copySession.js";
import { submitMirror } from "./mirror.js";

const copyRegistry = defaultRegistry();

/**
 * Cyppie `aa-trigger` (KAN-139) — builds/submits ERC-4337 UserOps via permissionless.js/Pimlico for the
 * Kotlin User-Service. Loopback-only. 🔑 Auth ≠ Custody: the main key never leaves the device — for DCA
 * the app signs the userOpHash; the backend only builds + submits (ADR-0024, Q1 per-feature).
 *
 * Ph1 increment 1: service skeleton + the on-chain address gate + /healthz. The /v1/userop/* handlers
 * (build/submit/status via permissionless) land in increment 2.
 */
/** A client/input error → HTTP 400 (vs. a 500 for unexpected faults). */
class BadRequest extends Error {}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256 * 1024) throw new Error("request body too large"); // loopback caller; bound it
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function requireChain(v: unknown): SupportedChainId {
  const id = Number(v);
  if (!(id in CHAINS)) throw new BadRequest(`unsupported chainId ${String(v)} (supported: ${Object.keys(CHAINS).join(",")})`);
  return id as SupportedChainId;
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

  // Build a sponsored, unsigned UserOp; return the digest the app must sign on-device (+ first-op auth).
  if (method === "POST" && url === "/v1/userop/build") {
    const body = await readJson(req);
    const chainId = requireChain(body.chainId);
    const owner = body.owner as Address;
    if (!owner) throw new BadRequest("missing owner");
    const callsIn = (body.calls as Array<{ to: Address; value?: string; data?: Hex }>) ?? [];
    if (callsIn.length === 0) throw new BadRequest("missing calls");
    const calls: Call[] = callsIn.map((c) => ({ to: c.to, value: BigInt(c.value ?? "0x0"), data: c.data ?? "0x" }));
    const built = await buildUserOp(chainCtxFor(chainId), owner, calls);
    return send(res, 200, built);
  }

  // Submit the app-signed op verbatim (+ signed 7702 authorization on the first op).
  if (method === "POST" && url === "/v1/userop/submit") {
    const body = await readJson(req);
    const chainId = requireChain(body.chainId);
    const op = body.userOp as SerializedUserOp;
    const signature = body.signature as Hex;
    if (!op || !signature) throw new BadRequest("missing userOp or signature");
    const auth = body.authorization as SignedAuthorization | undefined;
    const result = await submitUserOp(chainCtxFor(chainId), op, signature, auth);
    return send(res, 200, result);
  }

  // Receipt/status: GET /v1/userop/{hash}?chainId=
  if (method === "GET" && url.startsWith("/v1/userop/")) {
    const u = new URL(url, "http://localhost");
    const hash = u.pathname.slice("/v1/userop/".length) as Hex;
    if (!hash) throw new BadRequest("missing userOpHash");
    const chainId = requireChain(u.searchParams.get("chainId"));
    const status = await userOpReceipt(chainCtxFor(chainId), hash);
    return send(res, 200, status);
  }

  // Copy-Trading (KAN-149 C2): provision a scoped session keypair + return the ENABLE inputs for the app.
  if (method === "POST" && url === "/v1/copy/session/prepare") {
    const b = await readJson(req);
    const chainId = requireChain(b.chainId);
    for (const f of ["token", "capTotalBudget", "router", "selector", "windowStart", "windowEnd", "follower", "source"]) {
      if (b[f] === undefined) throw new BadRequest(`missing ${f}`);
    }
    const scope: CopyScope = {
      chainId, token: b.token as Address, capTotalBudget: BigInt(b.capTotalBudget as string),
      router: b.router as Address, selector: b.selector as Hex,
      windowStart: Number(b.windowStart), windowEnd: Number(b.windowEnd),
      follower: b.follower as Address, source: b.source as Address,
    };
    return send(res, 200, copyRegistry.prepare(scope));
  }
  // Record the owner-signed enable for a prepared session (included ENABLE-mode in the first mirror op).
  if (method === "POST" && url === "/v1/copy/session/grant") {
    const b = await readJson(req);
    if (!b.permissionId || !b.enableSignature) throw new BadRequest("missing permissionId or enableSignature");
    const r = copyRegistry.grant(b.permissionId as string, b.enableSignature as Hex);
    return send(res, 200, { permissionId: r.permissionId, status: r.status });
  }

  // Kill-switch (C4): pause/resume a session's mirrors + mark on-chain-revoked.
  if (method === "POST" && (url === "/v1/copy/session/pause" || url === "/v1/copy/session/resume" || url === "/v1/copy/session/revoke")) {
    const b = await readJson(req);
    if (!b.permissionId) throw new BadRequest("missing permissionId");
    const id = b.permissionId as string;
    const r = url.endsWith("revoke") ? copyRegistry.revoke(id) : copyRegistry.setPaused(id, url.endsWith("pause"));
    return send(res, 200, { permissionId: r.permissionId, status: r.status, paused: !!r.paused });
  }

  // Copy-Trading mirror trigger (C4): SubmitGate (kill-switch + Q7 + idempotency) → build USE-mode mirror,
  // sign with the backend session key, submit. `calls` is the scaled mirror (built by the C5 webhook path);
  // `spend` is the input-token amount for the Q7 accounting; `sourceTxHash` is the idempotency key.
  if (method === "POST" && url === "/v1/session/trigger") {
    const b = await readJson(req);
    if (!b.permissionId || !b.calls || b.spend === undefined || !b.sourceTxHash) {
      throw new BadRequest("missing permissionId, calls, spend or sourceTxHash");
    }
    const permissionId = b.permissionId as string;
    const spend = BigInt(b.spend as string);
    const sourceTxHash = b.sourceTxHash as string;
    const callsIn = b.calls as Array<{ to: Address; value?: string; data?: Hex }>;
    if (callsIn.length === 0) throw new BadRequest("missing calls");
    const calls: Call[] = callsIn.map((c) => ({ to: c.to, value: BigInt(c.value ?? "0x0"), data: c.data ?? "0x" }));
    // Gate FIRST (fail-closed, no spend until it passes), then sign+submit, then record (Q7 + idempotency).
    const record = copyRegistry.assertMirrorable(permissionId, spend, sourceTxHash);
    const { userOpHash } = await submitMirror(record, copyRegistry.signerFor(permissionId), calls);
    copyRegistry.recordMirror(permissionId, spend, sourceTxHash);
    return send(res, 200, { userOpHash, permissionId });
  }
  send(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    const code = e instanceof GateError ? 409 : e instanceof BadRequest ? 400 : 500;
    send(res, code, { error: String(e instanceof Error ? e.message : e) });
  });
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
