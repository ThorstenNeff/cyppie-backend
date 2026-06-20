import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  getOwnableValidator, getSpendingLimitsPolicy, getTimeFramePolicy, getPermissionId, getOwnableValidatorSignature,
  encodeSmartSessionSignature, SmartSessionMode, SMART_SESSIONS_ADDRESS,
} from "@rhinestone/module-sdk";
import { toHex, encodePacked, type Address, type Hex } from "viem";
import { KeychainSessionKeySigner, type SessionKeySigner } from "./sessionKeySigner.js";
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
 *  - The TimeFrame WINDOW goes in `userOpPolicies` (it implements `IUserOpPolicy`); the swap is a SEPARATE
 *    time-boxed router action. Two actions: [token.approve (cap), router.swap (window)].
 */
export function assembleEnableInputs(sessionPublicKey: Address, salt: Hex, scope: CopyScope): EnableInputs {
  const ov = getOwnableValidator({ threshold: 1, owners: [sessionPublicKey] });
  const spend = getSpendingLimitsPolicy([{ token: scope.token, limit: scope.capTotalBudget }]);
  const time = getTimeFramePolicy({ validAfter: scope.windowStart, validUntil: scope.windowEnd });
  const timePolicy = { policy: time.policy as Address, initData: time.initData as Hex };
  const session = {
    sessionValidator: ov.address as Address,
    sessionValidatorInitData: ov.initData as Hex,
    salt,
    userOpPolicies: [timePolicy], // TimeFrame (IUserOpPolicy): the window
    erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] },
    actions: [
      // cap: SpendingLimits on the spend-token approve (IActionPolicy) — caps what the router can pull
      { actionTargetSelector: APPROVE_SELECTOR, actionTarget: scope.token, actionPolicies: [{ policy: spend.policy as Address, initData: spend.initData as Hex }] },
      // swap: the copy-router call, time-boxed (separate action)
      { actionTargetSelector: scope.selector, actionTarget: scope.router, actionPolicies: [timePolicy] },
    ],
    permitERC4337Paymaster: true as const,
    chainId: BigInt(scope.chainId),
  };
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
  scope: { chainId: number; token: Address; capTotalBudget: string; router: Address; selector: Hex; windowStart: number; windowEnd: number; follower: Address; source: Address };
  salt: Hex;
  status: CopyStatus;
  enableSignature?: Hex; // the owner-signed enable, included (ENABLE-mode) in the first mirror op
  // ── SubmitGate state (C4) ──
  paused?: boolean; // kill-switch: mirrors rejected while true (separate from on-chain revoke)
  spentTotal?: string; // Q7 backend accounting: cumulative mirrored spend (defense-in-depth on the on-chain cap)
  mirroredTx?: string[]; // idempotency: source tx hashes already mirrored (no double-mirror on webhook retry)
}

/** A SubmitGate rejection (kill-switch / exposure cap / idempotency / not-granted) → HTTP 409/400, never a 500. */
export class GateError extends Error {}

const KEYCHAIN_SERVICE = "cyppie-copy-session";

export class CopySessionRegistry {
  private records: Map<string, CopyRecord> = new Map();
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
    });
    return inputs;
  }

  /** Record the owner-signed enable for a prepared session (→ `granted`); used in the first mirror op. */
  grant(permissionId: string, enableSignature: Hex): CopyRecord {
    const r = this.records.get(permissionId);
    if (!r) throw new Error(`unknown permissionId ${permissionId}`);
    if (r.status === "revoked") throw new Error("session revoked");
    const updated: CopyRecord = { ...r, status: "granted", enableSignature };
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
    const spent = BigInt(r.spentTotal ?? "0");
    const cap = BigInt(r.scope.capTotalBudget);
    if (spent + spend > cap) throw new GateError(`exposure cap exceeded (${spent + spend} > ${cap})`);
    return r;
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
