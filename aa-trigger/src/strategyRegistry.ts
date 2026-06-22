import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Address, Hex } from "viem";
import type { SellCap } from "./strategyCaps.js";
import { KeychainSessionKeySigner } from "./sessionKeySigner.js";

export const STRATEGY_KEYCHAIN_SERVICE = "cyppie-strategy-session";

/**
 * Vaults-B strategy session registry (KAN-164) — the metadata store the rebalance engine + the active-list read,
 * mirroring the copy registry. PURE store (no Keychain/network) so it's unit-testable; the prepare assembly
 * (key provision + deriveSellCaps + enable inputs) lives at the service layer and records via {@link recordPrepared}.
 *
 * 🔑 Auth ≠ Custody: stores scopes + accounting only — the backend session key lives in the Keychain/HSM (the
 * `keychainAccount` pointer is here, never the key). Σ caps = the on-chain Sell-Cap envelope (KAN-164 (B)).
 */
export type StrategyStatus = "prepared" | "granted" | "revoked";

export interface StrategyRecord {
  permissionId: Hex;
  sessionPublicKey: Address;
  keychainAccount: string;
  account: Address;     // the strategy SCA (= owner EOA, 7702 same-address)
  chainId: number;
  budgetToken: Address;
  caps: SellCap[];      // the per-token Sell-Caps (deriveSellCaps output) — capBaseUnits decimal strings
  router: Address;
  windowStart: number;
  windowEnd: number;
  salt: Hex;
  status: StrategyStatus;
  createdAt?: number;
  grantedAt?: number;
  paused?: boolean;
}

/** The active-list view row (UX strat-active row). Final shape pins with Dev-1; amounts are decimal strings. */
export interface StrategySessionView {
  permissionId: Hex;
  chainId: number;
  account: Address;
  budgetToken: Address;
  caps: SellCap[];
  router: Address;
  windowStart: number;
  windowEnd: number;
  status: "active" | "paused";
  since: number; // grantedAt, or createdAt fallback
}

export class StrategySessionRegistry {
  private records: Map<string, StrategyRecord> = new Map();
  constructor(private readonly path: string) {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as StrategyRecord[];
      for (const r of raw) this.records.set(r.permissionId, r);
    }
  }
  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.records.values()], null, 2));
    renameSync(tmp, this.path); // atomic
  }
  get(permissionId: string): StrategyRecord | undefined {
    return this.records.get(permissionId);
  }
  list(): StrategyRecord[] {
    return [...this.records.values()];
  }
  upsert(r: StrategyRecord): void {
    this.records.set(r.permissionId, r);
    this.persist();
  }

  /** Record a freshly-prepared session (the service layer provisioned the key + assembled the enable inputs). */
  recordPrepared(r: Omit<StrategyRecord, "status" | "createdAt">): StrategyRecord {
    const rec: StrategyRecord = { ...r, status: "prepared", createdAt: Math.floor(Date.now() / 1000) };
    this.upsert(rec);
    return rec;
  }

  /** Mark a prepared session active once the owner broadcast the on-chain enable (approach B, like copy). */
  grant(permissionId: string): StrategyRecord {
    const r = this.records.get(permissionId);
    if (!r) throw new Error(`unknown permissionId ${permissionId}`);
    if (r.status === "revoked") throw new Error("session revoked");
    const updated: StrategyRecord = { ...r, status: "granted", grantedAt: r.grantedAt ?? Math.floor(Date.now() / 1000) };
    this.upsert(updated);
    return updated;
  }

  /** Kill-switch pause/resume (independent of the on-chain revoke). */
  setPaused(permissionId: string, paused: boolean): StrategyRecord {
    const r = this.records.get(permissionId);
    if (!r) throw new Error(`unknown permissionId ${permissionId}`);
    const updated = { ...r, paused };
    this.upsert(updated);
    return updated;
  }

  /** Mark on-chain-revoked (self-heal from reconcile, or after a removeSession). No further rebalances. */
  revoke(permissionId: string): StrategyRecord {
    const r = this.records.get(permissionId);
    if (!r) throw new Error(`unknown permissionId ${permissionId}`);
    const updated: StrategyRecord = { ...r, status: "revoked" };
    this.upsert(updated);
    return updated;
  }

  /** The backend session-key signer for a recorded session (resolves the Keychain key by the stored account). */
  signerFor(permissionId: string): KeychainSessionKeySigner {
    const r = this.records.get(permissionId);
    if (!r) throw new Error(`unknown permissionId ${permissionId}`);
    return new KeychainSessionKeySigner(STRATEGY_KEYCHAIN_SERVICE, r.keychainAccount, r.sessionPublicKey);
  }

  /** Granted (active/paused) strategy sessions for an account → active-list view rows. Excludes prepared/revoked. */
  viewByFollower(account: string): StrategySessionView[] {
    const a = account.toLowerCase();
    return [...this.records.values()]
      .filter((r) => r.status === "granted" && r.account.toLowerCase() === a)
      .map((r) => ({
        permissionId: r.permissionId, chainId: r.chainId, account: r.account, budgetToken: r.budgetToken,
        caps: r.caps, router: r.router, windowStart: r.windowStart, windowEnd: r.windowEnd,
        status: r.paused ? "paused" : "active", since: r.grantedAt ?? r.createdAt ?? 0,
      }));
  }
}

export const defaultStrategyRegistry = (): StrategySessionRegistry =>
  new StrategySessionRegistry(join(process.env.CYPPIE_HOME ?? "/opt/cyppie", "aa-trigger", "strategy-sessions.json"));
