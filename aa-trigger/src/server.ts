import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { decodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { PORT, HOST } from "./config.js";
import { verifyAddressesOnChain, ENTRYPOINT_V07, SMART_SESSIONS_MODULE, CHAINS, type SupportedChainId } from "./addresses.js";
import { buildUserOp, submitUserOp, userOpReceipt, chainCtxFor, type Call, type SignedAuthorization, type SerializedUserOp } from "./userop.js";
import { getRemoveSessionAction } from "@rhinestone/module-sdk";
import { defaultRegistry, GateError, sessionFromRecord, type CopyScope, type CopyRecord } from "./copySession.js";
import { submitMirror, waitMirrorOutcome } from "./mirror.js";
import { verifyAlchemySignature, parseFollowedSpends, scaleMirror, spendKey } from "./copyWebhook.js";
import { buildMirrorCalls, type MirrorPlan } from "./swapAdapter.js";

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

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256 * 1024) throw new Error("request body too large"); // loopback caller; bound it
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readRaw(req)).trim();
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function requireChain(v: unknown): SupportedChainId {
  const id = Number(v);
  if (!(id in CHAINS)) throw new BadRequest(`unsupported chainId ${String(v)} (supported: ${Object.keys(CHAINS).join(",")})`);
  return id as SupportedChainId;
}

/**
 * The `amountOutMin` (slippage floor) for a mirror swap, FAIL-CLOSED. On Base Sepolia (84532, testnet, no MEV) a
 * 0 floor is acceptable for the wiring/E2E proof. On mainnet a real floor needs a quote (QuoterV2 × slippageBps)
 * — NOT yet wired — so we return `null` and the webhook SKIPS the mirror rather than submit with no slippage
 * protection. Wiring the quote is the C6 DEX-safety follow-up that unblocks mainnet mirrors.
 */
function minOutFor(chainId: number, _slippageBps?: number): bigint | null {
  if (chainId === 84532) return 0n;
  return null;
}

/** KAN-161 dynamic mode default pool fee when the session didn't pin one (QuoterV2 resolves the real pool in KAN-151). */
const DYNAMIC_DEFAULT_FEE_TIER = 3000;
const ERC20_APPROVE_SELECTOR = "0x095ea7b3";
const selectorOf = (data?: Hex): string => (data ?? "0x").slice(0, 10).toLowerCase();

/**
 * P2-1 (KAN-156): confirm-then-record. After a bundler-accept, settle the reservation on the ON-CHAIN outcome:
 * commit (charge Q7 + persist idempotency) only on success; release (charge nothing) on revert; on a confirm
 * timeout LEAVE it reserved (conservatively holds the cap) + log for reconcile — never under-count a maybe-landed
 * op (which would risk a within-cap double-mirror). Runs in the background so the webhook responds promptly.
 */
function settleMirror(permissionId: string, chainId: number, userOpHash: Hex, spend: bigint, key: string): void {
  void waitMirrorOutcome(chainId as 1 | 8453 | 84532, userOpHash)
    .then((outcome) => {
      if (outcome === "success") copyRegistry.commitReservation(permissionId, spend, key);
      else if (outcome === "reverted") copyRegistry.releaseReservation(permissionId, spend, key);
      else console.warn(`[mirror] confirm pending after timeout — reservation LEFT booked for reconcile: ${permissionId} ${key} ${userOpHash}`);
    })
    .catch((e) => { copyRegistry.releaseReservation(permissionId, spend, key); console.error("[mirror] settle error:", e instanceof Error ? e.message : e); });
}

/** P1-3 (KAN-156): the set of `target:selector` the session ENABLED (from the adapter-driven action set). */
function enabledActionKeys(record: CopyRecord): Set<string> {
  return new Set(sessionFromRecord(record).actions.map((a) => `${a.actionTarget.toLowerCase()}:${a.actionTargetSelector.toLowerCase()}`));
}

/** P1-3: derive the Q7 spend from the calls — the `approve(spender,amount)` on the scope's spend token (the cap action). */
function deriveSpendFromCalls(calls: Call[], token: Address): bigint {
  for (const c of calls) {
    if (c.to.toLowerCase() === token.toLowerCase() && selectorOf(c.data) === ERC20_APPROVE_SELECTOR) {
      const { args } = decodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), data: c.data });
      return args[1] as bigint;
    }
  }
  throw new BadRequest("cannot derive spend: no approve(spender,amount) on the scope token in calls");
}

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
      // Copy-direction + allocation (mirror-time params; do NOT affect the permissionId/enable digest). The
      // webhook needs tokenOut+feeTier to mirror at all; allocationBps defaults to full-match (10_000).
      tokenOut: b.tokenOut as Address | undefined, feeTier: b.feeTier !== undefined ? Number(b.feeTier) : undefined,
      slippageBps: b.slippageBps !== undefined ? Number(b.slippageBps) : undefined,
      allocationBps: b.allocationBps !== undefined ? Number(b.allocationBps) : undefined,
    };
    return send(res, 200, copyRegistry.prepare(scope));
  }
  // Mark a prepared session active once the owner has broadcast the on-chain enable (approach B): the App
  // built + owner-signed + submitted the install+enableSessions op via /v1/userop/build + /v1/userop/submit.
  // No enable signature is stored (the owner's authority is that userOp's signature itself).
  if (method === "POST" && url === "/v1/copy/session/grant") {
    const b = await readJson(req);
    if (!b.permissionId) throw new BadRequest("missing permissionId");
    const r = copyRegistry.grant(b.permissionId as string);
    return send(res, 200, { permissionId: r.permissionId, status: r.status });
  }

  // Kill-switch (C4): pause/resume a session's mirrors (off-chain, instant). The PERMANENT revoke is on-chain
  // (removeSession) — see /v1/copy/session/revoke/build + /submit below.
  if (method === "POST" && (url === "/v1/copy/session/pause" || url === "/v1/copy/session/resume")) {
    const b = await readJson(req);
    if (!b.permissionId) throw new BadRequest("missing permissionId");
    const r = copyRegistry.setPaused(b.permissionId as string, url.endsWith("pause"));
    return send(res, 200, { permissionId: r.permissionId, status: r.status, paused: !!r.paused });
  }

  // KAN-157 Active-list: the granted (active/paused) copy sessions for a follower (UX Copy0-Active rows).
  //   GET /v1/copy/sessions?follower=0x…
  if (method === "GET" && url.startsWith("/v1/copy/sessions")) {
    const u = new URL(url, "http://localhost");
    const follower = u.searchParams.get("follower");
    if (!follower) throw new BadRequest("missing follower");
    return send(res, 200, { follower, sessions: copyRegistry.viewByFollower(follower) });
  }

  // KAN-157 on-chain REVOKE (non-custodial, owner-signed on-device per ADR-0009) — phase 1: build the sponsored
  // SmartSessions.removeSession(permissionId) userOp + return the digest the owner signs. Reuses buildUserOp.
  if (method === "POST" && url === "/v1/copy/session/revoke/build") {
    const b = await readJson(req);
    if (!b.permissionId) throw new BadRequest("missing permissionId");
    const rec = copyRegistry.get(b.permissionId as string);
    if (!rec) throw new GateError(`unknown permissionId ${String(b.permissionId)}`);
    const chainId = requireChain(rec.scope.chainId);
    const remove = getRemoveSessionAction({ permissionId: rec.permissionId });
    const calls: Call[] = [{ to: remove.to as Address, value: 0n, data: remove.callData as Hex }];
    const built = await buildUserOp(chainCtxFor(chainId), rec.scope.follower as Address, calls);
    return send(res, 200, { permissionId: rec.permissionId, ...built });
  }

  // KAN-157 on-chain REVOKE — phase 2: submit the owner-signed removeSession op; on success mark the session
  // revoked (no further mirror — the on-chain session is gone, the off-chain gate also rejects). Reuses submitUserOp.
  if (method === "POST" && url === "/v1/copy/session/revoke/submit") {
    const b = await readJson(req);
    if (!b.permissionId || !b.userOp || !b.signature) throw new BadRequest("missing permissionId, userOp or signature");
    const rec = copyRegistry.get(b.permissionId as string);
    if (!rec) throw new GateError(`unknown permissionId ${String(b.permissionId)}`);
    const chainId = requireChain(rec.scope.chainId);
    const result = await submitUserOp(chainCtxFor(chainId), b.userOp as SerializedUserOp, b.signature as Hex, b.authorization as SignedAuthorization | undefined);
    const r = copyRegistry.revoke(rec.permissionId); // off-chain mark too — defense-in-depth on top of the on-chain removeSession
    return send(res, 200, { permissionId: r.permissionId, status: r.status, userOpHash: result.userOpHash });
  }

  // Copy-Trading mirror trigger (C4, loopback-only): the calls are VALIDATED against the session's enabled
  // (target,selector) and the Q7 spend is DERIVED from them (P1-3) — the session key never signs arbitrary calls,
  // and spend can't be under-declared. Then the atomic reserve→submit→commit path (P1-1).
  if (method === "POST" && url === "/v1/session/trigger") {
    const b = await readJson(req);
    if (!b.permissionId || !b.calls || !b.sourceTxHash) throw new BadRequest("missing permissionId, calls or sourceTxHash");
    const permissionId = b.permissionId as string;
    const sourceTxHash = b.sourceTxHash as string;
    const callsIn = b.calls as Array<{ to: Address; value?: string; data?: Hex }>;
    if (callsIn.length === 0) throw new BadRequest("missing calls");
    const calls: Call[] = callsIn.map((c) => ({ to: c.to, value: BigInt(c.value ?? "0x0"), data: c.data ?? "0x" }));
    const record = copyRegistry.get(permissionId);
    if (!record) throw new GateError(`unknown permissionId ${permissionId}`);
    // P1-3: every call must target an ENABLED (target,selector) — no signing arbitrary calls with the session key.
    const allowed = enabledActionKeys(record);
    for (const c of calls) {
      const key = `${c.to.toLowerCase()}:${selectorOf(c.data)}`;
      if (!allowed.has(key)) throw new BadRequest(`call ${key} not in the session's enabled action set`);
    }
    // P1-3: derive the Q7 spend from the calls (not caller-declared); if a spend is passed it MUST equal the derived.
    const spend = deriveSpendFromCalls(calls, record.scope.token);
    if (b.spend !== undefined && BigInt(b.spend as string) !== spend) throw new BadRequest("declared spend != derived approve amount");
    // P1-1: atomic reserve → submit (distinct nonce lane); P2-1: settle (commit/release) on on-chain inclusion.
    copyRegistry.reserve(permissionId, spend, sourceTxHash);
    const nonceKey = copyRegistry.nextNonceKey(record.scope.follower);
    try {
      const { userOpHash } = await submitMirror(record, copyRegistry.signerFor(permissionId), calls, nonceKey);
      settleMirror(permissionId, record.scope.chainId, userOpHash, spend, sourceTxHash);
      return send(res, 200, { userOpHash, permissionId, spend: spend.toString() });
    } catch (e) {
      copyRegistry.releaseReservation(permissionId, spend, sourceTxHash);
      throw e;
    }
  }

  // Copy-Trading detection + gated submit (C5 + C6): Alchemy Address-Activity push → HMAC-verify (fail-closed) →
  // parse followed source→router spends → fan out to following sessions → scale → SubmitGate → build the
  // per-router swap calls (swapAdapter) → submitMirror (USE-mode, the on-chain policies are the hard bound) →
  // record (Q7 + idempotency). Each mirror is fail-closed and independent (one bad mirror never sinks the batch).
  if (method === "POST" && url === "/v1/copy/webhook") {
    const raw = await readRaw(req);
    const sig = req.headers["x-alchemy-signature"] as string | undefined;
    if (!verifyAlchemySignature(raw, sig, process.env.ALCHEMY_WEBHOOK_SIGNING_KEY)) {
      return send(res, 401, { error: "invalid webhook signature" }); // fail-closed
    }
    const payload = raw ? JSON.parse(raw) : {};
    const followed = (addr: string) => copyRegistry.list().some((r) => r.status === "granted" && r.scope.source.toLowerCase() === addr.toLowerCase());
    const spends = parseFollowedSpends(payload, followed);
    const mirrors: Array<Record<string, unknown>> = [];
    for (const s of spends) {
      for (const r of copyRegistry.findBySource(s.source, s.chainId)) {
        const base: Record<string, unknown> = { permissionId: r.permissionId, tokenIn: s.tokenIn, sourceTxHash: s.sourceTxHash, router: s.router };
        try {
          // P1-2 (KAN-156): the event injects tokenIn/router; the session ENABLED its actions on scope.token /
          // scope.router. A spend on any OTHER token/router would target an un-enabled (target,selector) → a
          // guaranteed on-chain revert on a SPONSORED op (paymaster gas-drain). Skip BEFORE building/submitting —
          // and it makes the scaled `amount` same-token (so the Q7 cap accounting is meaningful, P1-2 corollary).
          if (s.tokenIn.toLowerCase() !== r.scope.token.toLowerCase() || s.router.toLowerCase() !== r.scope.router.toLowerCase()) {
            mirrors.push({ ...base, status: "skipped", reason: "spend token/router not in session scope" }); continue;
          }
          const remainingCap = BigInt(r.scope.capTotalBudget) - BigInt(r.spentTotal ?? "0");
          const amount = scaleMirror(s.amountIn, r.scope.allocationBps ?? 10_000, remainingCap); // % allocation (default full-match), clamped to the cap
          base.amount = amount.toString();
          if (amount <= 0n) { mirrors.push({ ...base, status: "skipped", reason: "cap exhausted or zero" }); continue; }
          // KAN-161 copy-direction: FIXED mode = scope.tokenOut set (the follower pre-committed to a trusted token).
          // DYNAMIC mode = scope.tokenOut null → mirror whatever the trader bought (the parsed output leg). Fail-closed
          // if dynamic but the output leg wasn't unambiguously derivable (no blind guess of what to buy).
          const dynamic = !r.scope.tokenOut;
          const tokenOut = r.scope.tokenOut ?? s.tokenOutDetected;
          if (!tokenOut) { mirrors.push({ ...base, status: "skipped", reason: "dynamic: no output leg detected (can't derive tokenOut)" }); continue; }
          const feeTier = r.scope.feeTier ?? DYNAMIC_DEFAULT_FEE_TIER; // dynamic: default pool fee (QuoterV2 resolves the real pool in KAN-151)
          base.mode = dynamic ? "dynamic" : "fixed"; base.tokenOut = tokenOut;
          // Guardrail (ADR-0024 harm-reduction): never submit without a reliable slippage floor — matters MORE in
          // dynamic mode (the bought token is the trader's choice, not pre-vetted). minOutFor fail-closes mainnet
          // until the QuoterV2 floor (KAN-151); testnet (no MEV) allows a 0 floor for the proof.
          const amountOutMin = minOutFor(s.chainId, r.scope.slippageBps);
          if (amountOutMin === null) { mirrors.push({ ...base, status: "skipped", reason: "no slippage floor (needs quote on mainnet — KAN-151)" }); continue; }
          const key = spendKey(s); // P2-2: idempotency keyed (txHash, logIndex) — each leg of a multi-swap tx mirrors
          copyRegistry.reserve(r.permissionId, amount, key); // P1-1: ATOMIC gate+reserve (throws GateError → caught below)
          const plan: MirrorPlan = {
            chainId: s.chainId, router: s.router, tokenIn: s.tokenIn, tokenOut,
            amountIn: amount, amountOutMin, feeTier, deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
          };
          const calls = buildMirrorCalls(plan);
          const nonceKey = copyRegistry.nextNonceKey(r.scope.follower); // P1-1: distinct nonce lane per concurrent op
          try {
            const { userOpHash } = await submitMirror(r, copyRegistry.signerFor(r.permissionId), calls, nonceKey);
            settleMirror(r.permissionId, s.chainId, userOpHash, amount, key); // P2-1: commit on on-chain inclusion, not bundler-accept
            mirrors.push({ ...base, status: "submitted", userOpHash });
          } catch (submitErr) {
            copyRegistry.releaseReservation(r.permissionId, amount, key); // failed submit → charge nothing
            throw submitErr;
          }
        } catch (e) {
          mirrors.push({ ...base, status: e instanceof GateError ? "gated" : "error", reason: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    return send(res, 200, { detected: spends.length, mirrors });
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

// Only boot the listener when run as the entry point — importing this module (e.g. the C6 E2E driving `handle`
// in-process) must NOT start the server or the on-chain address gate.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("aa-trigger failed to start:", e);
    process.exit(1);
  });
}
