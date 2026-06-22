import { randomBytes } from "node:crypto";
import { getPermissionId } from "@rhinestone/module-sdk";
import { toHex, type Address, type Hex } from "viem";
import { KeychainSessionKeySigner } from "./sessionKeySigner.js";
import { buildStrategySession } from "./strategySession.js";
import { deriveSellCaps, sellCapsToScopeLegs, TURNOVER_DEFAULT, type SellCap } from "./strategyCaps.js";
import { snapshotSellQuotes } from "./quoteV2.js";
import { STRATEGY_KEYCHAIN_SERVICE, type StrategySessionRegistry } from "./strategyRegistry.js";

/**
 * Vaults-B strategy prepare (KAN-164 (B)) — the service that turns the user's intent into a scoped, recorded
 * strategy session. Mirrors copy `prepare`, but the engine OWNS the cap derivation (single-source — the app does
 * NOT supply caps/legs): provision a backend session key → ONE-TIME QuoterV2 snapshot → {@link deriveSellCaps} →
 * {@link buildStrategySession} (legs from the caps) → record `prepared` → return the {@link StrategyPrepare} the
 * app verifies + builds the enable from. Auth ≠ Custody: the session key is Keychain-held; only its pointer is recorded.
 */
export interface StrategyScopeRequest {
  chainId: 1 | 8453 | 84532;
  follower: Address;        // the strategy SCA (= owner EOA, 7702 same-address)
  budgetToken: Address;
  budget: bigint;           // budgetToken base units
  basket: { token: Address; weightBps: number }[];
  windowStart: number;
  windowEnd: number;
  router: Address;          // UniversalRouter (per-chain; the server resolves it from an allowlist)
  feeTier: number;          // the V3 pool fee the QuoterV2 snapshot quotes through
  turnover?: number;        // cumulative-cap turnover factor (default 2)
}

/** The prepare response Dev-2's StrategyGrantService consumes (PO-pinned shape; caps = FR-6 decimal strings). */
export interface StrategyPrepare {
  permissionId: Hex;
  chainId: number;
  follower: Address;
  sessionPublicKey: Address;
  caps: SellCap[];
  windowStart: number;
  windowEnd: number;
  salt: Hex;
  nonce: number; // the enable runs on the Kernel ROOT validator lane (first op) → 0
}

export async function prepareStrategySession(registry: StrategySessionRegistry, req: StrategyScopeRequest): Promise<StrategyPrepare> {
  const turnover = req.turnover ?? TURNOVER_DEFAULT;
  const salt = toHex(randomBytes(32));
  const keychainAccount = `strategy-${req.follower.toLowerCase()}-${salt.slice(2, 14)}`;
  const { address: sessionPublicKey } = KeychainSessionKeySigner.provision(STRATEGY_KEYCHAIN_SERVICE, keychainAccount);

  // SINGLE SOURCE: backend snapshots the price + derives the per-token Sell-Caps (the rebalance envelope).
  const quotes = await snapshotSellQuotes(req.chainId, req.budgetToken, req.basket.map((b) => b.token), req.feeTier);
  const caps = deriveSellCaps({ budgetToken: req.budgetToken, budget: req.budget, basket: req.basket }, quotes, turnover);

  // The same caps → the on-chain Sell-Cap legs the session enables.
  const session = buildStrategySession(sessionPublicKey, salt, {
    chainId: req.chainId, legs: sellCapsToScopeLegs(caps), router: req.router,
    windowStart: req.windowStart, windowEnd: req.windowEnd, account: req.follower,
  });
  const permissionId = getPermissionId({ session }) as Hex;

  registry.recordPrepared({
    permissionId, sessionPublicKey, keychainAccount, account: req.follower, chainId: req.chainId,
    budgetToken: req.budgetToken, caps, router: req.router, windowStart: req.windowStart, windowEnd: req.windowEnd, salt,
  });

  return { permissionId, chainId: req.chainId, follower: req.follower, sessionPublicKey, caps, windowStart: req.windowStart, windowEnd: req.windowEnd, salt, nonce: 0 };
}
