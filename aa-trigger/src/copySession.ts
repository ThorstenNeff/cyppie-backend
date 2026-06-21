import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  getOwnableValidator, getSpendingLimitsPolicy, getTimeFramePolicy, getPermissionId, getOwnableValidatorSignature,
  encodeSmartSessionSignature, SmartSessionMode, SMART_SESSIONS_ADDRESS,
} from "@rhinestone/module-sdk";
import { toHex, encodePacked, type Address, type Hex } from "viem";
import { KeychainSessionKeySigner, type SessionKeySigner } from "./sessionKeySigner.js";
import { adapterFor, type RequiredAction } from "./swapAdapter.js";
import type { SupportedChainId } from "./addresses.js";

/**
 * Copy-Trading session lifecycle (KAN-149 C2): the backend generates a SCOPED session keypair, assembles the
 * exact Smart-Session ENABLE inputs the app builds + verifies (verifyGrant), and records the session.
 *
 * 🔑 Auth ≠ Custody: the session key is backend-held, scoped to ONE copy-router + a TOTAL spending cap + a
 * time window, revocable — never the device main key. The cap is CUMULATIVE (N3): `cap = total budget`, not
 * per-trade. `permitERC4337Paymaster = true` (Pimlico-sponsored). The ENABLE is built + owner-signed on the
 * device; the backend only supplies inputs + records the result (the app pins module/policy addresses itself).
 */
export interface CopyScope {
  chainId: SupportedChainId;
  token: Address; // the ERC-20 the copy budget is denominated in (spending-limit token)
  capTotalBudget: bigint; // CUMULATIVE total over the session (= perTrade × maxTrades), NOT per-trade
  router: Address; // the allowed DEX router (action target)
  selector: Hex; // the allowed swap selector (action target selector, bytes4)
  windowStart: number; // validAfter (unix s)
  windowEnd: number; // validUntil (unix s)
  follower: Address; // the follower SCA (= owner EOA, 7702 same-address)
  source: Address; // the followed trader address
  // ── Mirror-time swap params (copy-direction + slippage). NOT part of the on-chain action set, so they do
  //    NOT change the permissionId/enable digest — they only shape the router.execute calldata at mirror time. ──
  tokenOut?: Address; // what the follower buys (the copy-direction; the input leg alone doesn't determine it)
  feeTier?: number;   // Uniswap V3 pool fee for the mirror swap (e.g. 500 / 3000 / 10000)
  slippageBps?: number; // max slippage for amountOutMin (against a quote); absent ⇒ no on-chain slippage floor
}

/** The ENABLE inputs the app builds the Smart-Session enable from (it adds its owner account + the nonce). */
export interface EnableInputs {
  sessionPublicKey: Address; // the backend session key — pinned as owners[0] in the OwnableValidator
  sessionValidator: Address; // OwnableValidator (GLOBAL_CONSTANTS)
  sessionValidatorInitData: Hex; // abi.encode(1, [sessionPublicKey])
  salt: Hex; // backend-generated, makes the permissionId unique per session
  userOpPolicies: { policy: Address; initData: Hex }[]; // [TimeFrame window] (IUserOpPolicy)
  actions: { actionTargetSelector: Hex; actionTarget: Address; actionPolicies: { policy: Address; initData: Hex }[] }[]; // [token.approve→[SpendingLimits cap], router.swap→[TimeFrame]]
  erc7739Policies: { allowedERC7739Content: never[]; erc1271Policies: never[] };
  permitERC4337Paymaster: true;
  permissionId: Hex;
  smartSession: Address;
}

/** ERC-20 `approve(address,uint256)` selector — the action the spend cap is enforced on. */
const APPROVE_SELECTOR: Hex = "0x095ea7b3";

/**
 * Assemble the canonical ENABLE inputs for a session key + scope (pure; the byte-exact target for the app).
 *
 * Policy placement (C3 on-chain finding, proven on Base Sepolia — enable + USE-mode receipts):
 *  - SpendingLimitsPolicy implements only `IActionPolicy` AND its `checkAction` parses an ERC-20
 *    transfer/approve on the action TARGET (the token). So it is rejected in `userOpPolicies`
 *    (UnsupportedPolicy 0x6a01dd01) AND reverts at USE on a non-token action like a router multicall
 *    (PolicyViolation 0x3b577361). The cap therefore sits as the ACTION policy on the spend-TOKEN's
 *    `approve` — capping what the router can pull (the account's own spend authorization).
 *  - The TimeFrame WINDOW goes in `userOpPolicies` (it implements `IUserOpPolicy`); the swap legs are SEPARATE
 *    time-boxed actions.
 *
 * C6: the enabled action set is driven by the ROUTER'S swap adapter ({@link adapterFor}.requiredActions) — the
 * SAME source of truth as the mirror calls — so the session enables exactly the (target, selector)s the backend
 * will later submit (a UniversalRouter mirror = 3 actions: token.approve cap → Permit2.approve → router.execute).
 * A router with no registered adapter (test/dummy routers, e.g. the C3/C4 proofs) falls back to the legacy
 * 2-action shape [token.approve (cap), router.<scope.selector> (window)].
 */
/**
 * The module-sdk `Session` object for a session key + scope — the SINGLE definition of the on-chain session.
 * Used for the permissionId, the app's ENABLE digest, AND (C6) the ENABLE-mode-on-first-use enable data, so all
 * three are byte-identical. Action set is adapter-driven (see {@link assembleEnableInputs}).
 */
export function buildSession(sessionPublicKey: Address, salt: Hex, scope: CopyScope) {
  const ov = getOwnableValidator({ threshold: 1, owners: [sessionPublicKey] });
  const spend = getSpendingLimitsPolicy([{ token: scope.token, limit: scope.capTotalBudget }]);
  const time = getTimeFramePolicy({ validAfter: scope.windowStart, validUntil: scope.windowEnd });
  const timePolicy = { policy: time.policy as Address, initData: time.initData as Hex };
  const capPolicy = { policy: spend.policy as Address, initData: spend.initData as Hex };
  const adapter = adapterFor(scope.router);
  const required: RequiredAction[] = adapter
    ? adapter.requiredActions({ token: scope.token, router: scope.router })
    : [
        { actionTarget: scope.token, actionTargetSelector: APPROVE_SELECTOR, policy: "cap" },
        { actionTarget: scope.router, actionTargetSelector: scope.selector, policy: "window" },
      ];
  const actions = required.map((a) => ({
    actionTargetSelector: a.actionTargetSelector,
    actionTarget: a.actionTarget,
    actionPolicies: [a.policy === "cap" ? capPolicy : timePolicy],
  }));
  return {
    sessionValidator: ov.address as Address,
    sessionValidatorInitData: ov.initData as Hex,
    salt,
    userOpPolicies: [timePolicy], // TimeFrame (IUserOpPolicy): the window
    erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] },
    actions,
    permitERC4337Paymaster: true as const,
    chainId: BigInt(scope.chainId),
  };
}

/** Reconstruct the module-sdk `Session` from a stored record (the scope + session key). */
export function sessionFromRecord(r: CopyRecord) {
  const scope: CopyScope = {
    chainId: r.scope.chainId as SupportedChainId, token: r.scope.token, capTotalBudget: BigInt(r.scope.capTotalBudget),
    router: r.scope.router, selector: r.scope.selector, windowStart: r.scope.windowStart, windowEnd: r.scope.windowEnd,
    follower: r.scope.follower, source: r.scope.source,
  };
  return buildSession(r.sessionPublicKey, r.salt, scope);
}

export function assembleEnableInputs(sessionPublicKey: Address, salt: Hex, scope: CopyScope): EnableInputs {
  const session = buildSession(sessionPublicKey, salt, scope);
  const permissionId = getPermissionId({ session }) as Hex;
  return {
    sessionPublicKey, sessionValidator: session.sessionValidator, sessionValidatorInitData: session.sessionValidatorInitData,
    salt, userOpPolicies: session.userOpPolicies, actions: session.actions, erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] },
    permitERC4337Paymaster: true, permissionId, smartSession: SMART_SESSIONS_ADDRESS as Address,
  };
}

/**
 * Build the USE-mode `userOp.signature` for a copy-trade mirror op (the C4 trigger calls this per mirror).
 *
 * 🔒 USE-mode DIGEST-LOCK (C3, proven on-chain on Base Sepolia — mirror receipts 0x877f60… [sudo policies] +
 * 0xb410b4… [prod policies], both success, EntryPoint v0.7): the OwnableValidator session-validator recovers
 * the signer over the **RAW userOpHash** — NOT the EIP-191 `hashMessage(userOpHash)` form that the Kernel ROOT
 * validator uses for DCA ([[userop.ts]] digestToSign). So the backend session signer signs the raw 32-byte
 * userOpHash; the 65-byte r‖s‖v (EIP-2 low-S, C1) is wrapped as a threshold-1 OwnableValidator signature and
 * packed USE-mode (`0x00 ‖ permissionId ‖ ownableSig`). Verified gas-free against the deployed OwnableValidator
 * `validateSignatureWithData` (raw-recover, no internal EIP-191) and end-to-end with the receipts above.
 */
export async function buildUseModeUserOpSignature(signer: SessionKeySigner, userOpHash: Hex, permissionId: Hex): Promise<Hex> {
  const sessionSig = await signer.sign(userOpHash); // raw userOpHash — the C3 lock; 65-byte r‖s‖v, EIP-2 low-S
  const ownableSig = getOwnableValidatorSignature({ signatures: [sessionSig] }) as Hex;
  return encodeSmartSessionSignature({ mode: SmartSessionMode.USE, permissionId, signature: ownableSig }) as Hex;
}

/**
 * The Kernel v3 validator-nonce KEY (uint192) that routes a userOp to the Smart Sessions validator:
 *   [1B mode=0x00 DEFAULT][1B vtype=0x01 VALIDATOR][20B SmartSessions][2B nonceKey].
 *
 * C3 gotchas: (1) the vtype byte MUST be 0x01 (VALIDATOR) — module-sdk's `encodeValidatorNonce` emits 0x00
 * (routes to the root ECDSA validator → InvalidSignature 0x8baa579f). (2) permissionless's
 * `to7702KernelSmartAccount.getNonce({key})` ignores the key — read the EntryPoint's `getNonce(sender, key)`
 * directly with this value. (3) the SmartSessions validator must be installed with `selectorData` granting the
 * Kernel `execute` selector, else Kernel rejects it (InvalidValidator 0x682a6e7c).
 */
export function smartSessionUseModeNonceKey(nonceKey = 0): bigint {
  return BigInt(encodePacked(
    ["bytes1", "bytes1", "address", "bytes2"],
    ["0x00", "0x01", SMART_SESSIONS_ADDRESS as Address, toHex(nonceKey, { size: 2 })],
  ));
}

// ── Registry: session metadata co-located with the keys (the trigger needs both to sign) ──────────────
export type CopyStatus = "prepared" | "granted" | "revoked";
export interface CopyRecord {
  permissionId: Hex;
  sessionPublicKey: Address;
  keychainAccount: string; // the Keychain item account holding the private key
  scope: { chainId: number; token: Address; capTotalBudget: string; router: Address; selector: Hex; windowStart: number; windowEnd: number; follower: Address; source: Address; tokenOut?: Address; feeTier?: number; slippageBps?: number };
  salt: Hex;
  status: CopyStatus;
  createdAt?: number; // unix s when the session was provisioned (prepare) — "following since" fallback
  grantedAt?: number; // unix s when the session was granted (enable landed) — the "following since" (KAN-157 list)
  // ── SubmitGate state (C4) ──
  paused?: boolean; // kill-switch: mirrors rejected while true (separate from on-chain revoke)
  spentTotal?: string; // Q7 backend accounting: cumulative mirrored spend (defense-in-depth on the on-chain cap)
  mirroredTx?: string[]; // idempotency: source tx hashes already mirrored (no double-mirror on webhook retry)
}

/** A SubmitGate rejection (kill-switch / exposure cap / idempotency / not-granted) → HTTP 409/400, never a 500. */
export class GateError extends Error {}

/**
 * The per-session view for the KAN-157 Active-list (the UX `Copy0-Active` row fields, SPEC_COPY_session.md):
 * followed `source` trader, the cumulative budget `cap`, `used`/`remaining`, `status` (active/paused), and `since`.
 * All amounts are decimal strings (denominated in the spend `token`). Final response shape pins with Dev-1.
 */
export interface CopySessionView {
  permissionId: Hex;
  chainId: number;
  source: Address;       // the followed trader (advisory in the UX — not a guarantee)
  token: Address;        // the spend-budget token (cap/used/remaining denomination)
  cap: string;           // capTotalBudget (cumulative N3)
  used: string;          // spentTotal
  remaining: string;     // cap − used (never negative)
  status: "active" | "paused"; // granted+unpaused vs granted+paused (kill-switch)
  since: number;         // unix s — "following since" (grantedAt, or createdAt fallback)
  router: Address;
}

const KEYCHAIN_SERVICE = "cyppie-copy-session";

export class CopySessionRegistry {
  private records: Map<string, CopyRecord> = new Map();
  // P1-1 (KAN-156): in-flight reservations per permissionId — submitted-but-not-yet-recorded mirrors. Counted
  // toward the cap + idempotency set SYNCHRONOUSLY (atomic in Node's single-threaded loop, so concurrent Alchemy
  // retries can't both pass the gate across the submit `await`). Cleared on commit (success) or release (failure).
  private inflight: Map<string, { txs: Set<string>; spend: bigint }> = new Map();
  // P1-1: per-follower nonce-lane counter. Each concurrent mirror gets a DISTINCT EntryPoint nonce key (uint192
  // lane) so two ops for the same follower never collide on a single lane (on-chain getNonce lags pending ops, so
  // serialization alone wouldn't prevent the collision). In-memory; lanes restart on reboot (each lane's on-chain
  // sequence just continues independently).
  private nonceCounters: Map<string, number> = new Map();
  constructor(private readonly path: string) {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as CopyRecord[];
      for (const r of raw) this.records.set(r.permissionId, r);
    }
  }
  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.records.values()], null, 2));
    renameSync(tmp, this.path); // atomic
  }
  get(permissionId: string): CopyRecord | undefined {
    return this.records.get(permissionId);
  }
  list(): CopyRecord[] {
    return [...this.records.values()];
  }
  /**
   * KAN-157 Active-list: the granted (active or paused) sessions for a follower, as UX view rows. Excludes
   * `prepared` (not yet enabled) and `revoked` (ended). `used`/`remaining` from the off-chain Q7 accounting.
   */
  viewByFollower(follower: string): CopySessionView[] {
    const f = follower.toLowerCase();
    return [...this.records.values()]
      .filter((r) => r.status === "granted" && r.scope.follower.toLowerCase() === f)
      .map((r) => {
        const cap = BigInt(r.scope.capTotalBudget);
        const used = BigInt(r.spentTotal ?? "0");
        const remaining = used >= cap ? 0n : cap - used;
        return {
          permissionId: r.permissionId, chainId: r.scope.chainId, source: r.scope.source, token: r.scope.token,
          cap: cap.toString(), used: used.toString(), remaining: remaining.toString(),
          status: r.paused ? "paused" : "active", since: r.grantedAt ?? r.createdAt ?? 0, router: r.scope.router,
        } as CopySessionView;
      });
  }

  /** Granted (active) sessions following a given source trader on a chain (C5 webhook fan-out). */
  findBySource(source: string, chainId: number): CopyRecord[] {
    const s = source.toLowerCase();
    return [...this.records.values()].filter(
      (r) => r.status === "granted" && !r.paused && r.scope.source.toLowerCase() === s && r.scope.chainId === chainId,
    );
  }
  upsert(r: CopyRecord): void {
    this.records.set(r.permissionId, r);
    this.persist();
  }

  /** Provision a fresh session keypair (Keychain), assemble the enable inputs, record `prepared`. */
  prepare(scope: CopyScope): EnableInputs {
    const salt = toHex(randomBytes(32));
    const keychainAccount = `copy-${scope.follower.toLowerCase()}-${salt.slice(2, 14)}`;
    const { address } = KeychainSessionKeySigner.provision(KEYCHAIN_SERVICE, keychainAccount);
    const inputs = assembleEnableInputs(address, salt, scope);
    this.upsert({
      permissionId: inputs.permissionId, sessionPublicKey: address, keychainAccount,
      scope: { ...scope, capTotalBudget: scope.capTotalBudget.toString() }, salt, status: "prepared",
      createdAt: Math.floor(Date.now() / 1000),
    });
    return inputs;
  }

  /**
   * Mark a prepared session active (→ `granted`) once the owner has broadcast the on-chain enable.
   *
   * Enable-submission = approach (B) (KAN-156 P1-4, PO-approved): the App builds the owner-present, one-time
   * `installModule(SmartSessions) + enableSessions(session)` op via the EXISTING `/v1/userop/build`, the owner
   * signs the userOpHash on-device (Kernel-root EIP-191), and submits via `/v1/userop/submit`. The owner's
   * authority IS that userOp signature — there is no separately-stored enable signature to keep or verify
   * (former `enableSignature` was dead data; P2-5 is moot under (B)). The backend only records the active state.
   */
  grant(permissionId: string): CopyRecord {
    const r = this.records.get(permissionId);
    if (!r) throw new Error(`unknown permissionId ${permissionId}`);
    if (r.status === "revoked") throw new Error("session revoked");
    const updated: CopyRecord = { ...r, status: "granted", grantedAt: r.grantedAt ?? Math.floor(Date.now() / 1000) };
    this.upsert(updated);
    return updated;
  }

  /** The signer for a recorded session (resolves the Keychain key by the stored account). */
  signerFor(permissionId: string): KeychainSessionKeySigner {
    const r = this.records.get(permissionId);
    if (!r) throw new Error(`unknown permissionId ${permissionId}`);
    return new KeychainSessionKeySigner(KEYCHAIN_SERVICE, r.keychainAccount, r.sessionPublicKey);
  }

  /** Kill-switch: pause/resume mirrors for a session (independent of the on-chain revoke). */
  setPaused(permissionId: string, paused: boolean): CopyRecord {
    const r = this.records.get(permissionId);
    if (!r) throw new GateError(`unknown permissionId ${permissionId}`);
    const updated = { ...r, paused };
    this.upsert(updated);
    return updated;
  }

  /** Mark a session on-chain-revoked (no further mirrors). */
  revoke(permissionId: string): CopyRecord {
    const r = this.records.get(permissionId);
    if (!r) throw new GateError(`unknown permissionId ${permissionId}`);
    const updated: CopyRecord = { ...r, status: "revoked" };
    this.upsert(updated);
    return updated;
  }

  /**
   * SubmitGate (C4) — the double-gate before a mirror is signed/submitted. Throws GateError (→ 4xx) on:
   * not-granted/revoked/paused (kill-switch), a duplicate source tx (idempotency), or an exposure breach
   * (Q7: spentTotal + spend > the on-chain cap — fail fast before paying to submit a doomed op). The on-chain
   * SpendingLimits cap is the hard bound; this backend accounting is the fail-fast + cross-op aggregate (N3/Q7).
   */
  assertMirrorable(permissionId: string, spend: bigint, sourceTxHash: string): CopyRecord {
    const r = this.records.get(permissionId);
    if (!r) throw new GateError(`unknown permissionId ${permissionId}`);
    if (r.status !== "granted") throw new GateError(`session not granted (status=${r.status})`);
    if (r.paused) throw new GateError("session paused (kill-switch)");
    if ((r.mirroredTx ?? []).includes(sourceTxHash)) throw new GateError(`source ${sourceTxHash} already mirrored (idempotent)`);
    const inf = this.inflight.get(permissionId);
    if (inf?.txs.has(sourceTxHash)) throw new GateError(`source ${sourceTxHash} already in-flight (idempotent)`);
    const spent = BigInt(r.spentTotal ?? "0") + (inf?.spend ?? 0n);
    const cap = BigInt(r.scope.capTotalBudget);
    if (spent + spend > cap) throw new GateError(`exposure cap exceeded (${spent + spend} > ${cap})`);
    return r;
  }

  /**
   * P1-1 (KAN-156): the ATOMIC gate+reserve. Runs `assertMirrorable` (which now also counts in-flight exposure +
   * rejects an in-flight duplicate) and SYNCHRONOUSLY books the spend as in-flight — no `await` between check and
   * book, so two concurrent webhook deliveries for the same (permissionId, sourceTxHash) or the same follower
   * can't both pass before either records. Pair with `commitReservation` (success) or `releaseReservation`
   * (failure). The on-chain SpendingLimits cap remains the hard bound; this keeps the off-chain Q7 + idempotency
   * correct under concurrency.
   */
  reserve(permissionId: string, spend: bigint, sourceTxHash: string): CopyRecord {
    const r = this.assertMirrorable(permissionId, spend, sourceTxHash);
    const inf = this.inflight.get(permissionId) ?? { txs: new Set<string>(), spend: 0n };
    inf.txs.add(sourceTxHash);
    inf.spend += spend;
    this.inflight.set(permissionId, inf);
    return r;
  }

  private releaseInflight(permissionId: string, spend: bigint, sourceTxHash: string): void {
    const inf = this.inflight.get(permissionId);
    if (!inf) return;
    if (inf.txs.delete(sourceTxHash)) inf.spend -= spend;
    if (inf.txs.size === 0) this.inflight.delete(permissionId);
  }

  /** Commit a reservation after a SUCCESSFUL submit: persist Q7 + idempotency, drop the in-flight booking. */
  commitReservation(permissionId: string, spend: bigint, sourceTxHash: string): CopyRecord {
    this.releaseInflight(permissionId, spend, sourceTxHash);
    return this.recordMirror(permissionId, spend, sourceTxHash);
  }

  /** Release a reservation after a FAILED submit: drop the in-flight booking, charge nothing (no double-count). */
  releaseReservation(permissionId: string, spend: bigint, sourceTxHash: string): void {
    this.releaseInflight(permissionId, spend, sourceTxHash);
  }

  /** P1-1: next distinct EntryPoint nonce-lane (uint16) for a follower — concurrent ops never share a lane. */
  nextNonceKey(follower: string): number {
    const k = follower.toLowerCase();
    const n = this.nonceCounters.get(k) ?? 0;
    this.nonceCounters.set(k, (n + 1) & 0xffff);
    return n & 0xffff;
  }

  /** Record a submitted mirror (Q7 accounting + idempotency). Call AFTER a successful submit. */
  recordMirror(permissionId: string, spend: bigint, sourceTxHash: string): CopyRecord {
    const r = this.records.get(permissionId);
    if (!r) throw new GateError(`unknown permissionId ${permissionId}`);
    const updated: CopyRecord = {
      ...r,
      spentTotal: (BigInt(r.spentTotal ?? "0") + spend).toString(),
      mirroredTx: [...(r.mirroredTx ?? []), sourceTxHash],
    };
    this.upsert(updated);
    return updated;
  }
}

export const defaultRegistry = (): CopySessionRegistry =>
  new CopySessionRegistry(join(process.env.CYPPIE_HOME ?? "/opt/cyppie", "aa-trigger", "copy-sessions.json"));
