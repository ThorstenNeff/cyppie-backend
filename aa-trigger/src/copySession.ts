import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  getOwnableValidator, getSpendingLimitsPolicy, getTimeFramePolicy, getPermissionId, SMART_SESSIONS_ADDRESS,
} from "@rhinestone/module-sdk";
import { toHex, type Address, type Hex } from "viem";
import { KeychainSessionKeySigner } from "./sessionKeySigner.js";
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
  userOpPolicies: { policy: Address; initData: Hex }[]; // [SpendingLimits cap]
  actions: { actionTargetSelector: Hex; actionTarget: Address; actionPolicies: { policy: Address; initData: Hex }[] }[]; // [router+selector, [TimeFrame]]
  erc7739Policies: { allowedERC7739Content: never[]; erc1271Policies: never[] };
  permitERC4337Paymaster: true;
  permissionId: Hex;
  smartSession: Address;
}

/** Assemble the canonical ENABLE inputs for a session key + scope (pure; the byte-exact target for the app). */
export function assembleEnableInputs(sessionPublicKey: Address, salt: Hex, scope: CopyScope): EnableInputs {
  const ov = getOwnableValidator({ threshold: 1, owners: [sessionPublicKey] });
  const spend = getSpendingLimitsPolicy([{ token: scope.token, limit: scope.capTotalBudget }]);
  const time = getTimeFramePolicy({ validAfter: scope.windowStart, validUntil: scope.windowEnd });
  const session = {
    sessionValidator: ov.address as Address,
    sessionValidatorInitData: ov.initData as Hex,
    salt,
    userOpPolicies: [{ policy: spend.policy as Address, initData: spend.initData as Hex }],
    erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] },
    actions: [{ actionTargetSelector: scope.selector, actionTarget: scope.router, actionPolicies: [{ policy: time.policy as Address, initData: time.initData as Hex }] }],
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
}

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
}

export const defaultRegistry = (): CopySessionRegistry =>
  new CopySessionRegistry(join(process.env.CYPPIE_HOME ?? "/opt/cyppie", "aa-trigger", "copy-sessions.json"));
