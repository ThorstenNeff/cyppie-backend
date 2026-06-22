// KAN-164 Vaults-B strategy LIFECYCLE e2e (PRD-07), Base Sepolia — the population endpoints through PRODUCTION
// code at the SERVICE layer (Keycloak HTTP edge bypassed, like the DCA e2e; live JWT path = PRD-08).
//   AA_ALLOW_TESTNET=1 COPY_TEST_HOOKS=1 RUN_SEND=1 node --env-file=../.env c12-strategy-lifecycle-e2e.mjs
//
// Proves: prepareStrategySession (engine owns cap derivation: provision key → QuoterV2 snapshot [test-injected so
// no testnet pool needed] → deriveSellCaps → buildStrategySession → record `prepared` → StrategyPrepare) → owner
// builds+broadcasts the on-chain ENABLE → grant → the active-list reconcile shows it live → on-chain REVOKE
// (removeSession) → the reconcile self-heals it out. The rebalance EXECUTION under the session is proven by c11.
import { createPublicClient, http, encodeFunctionData, parseAbi, encodePacked, encodeAbiParameters } from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint07Address } from "viem/account-abstraction";
import { to7702KernelSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { createSmartAccountClient } from "permissionless";
import { getSmartSessionsValidator, getEnableSessionsAction, getRemoveSessionAction, isSessionEnabled, getAccount, SMART_SESSIONS_ADDRESS } from "@rhinestone/module-sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StrategySessionRegistry, STRATEGY_KEYCHAIN_SERVICE } from "./dist/strategyRegistry.js";
import { prepareStrategySession } from "./dist/strategyService.js";
import { buildStrategySession } from "./dist/strategySession.js";
import { sellCapsToScopeLegs } from "./dist/strategyCaps.js";
import { __setTestQuote } from "./dist/quoteV2.js";
import { isSessionEnabledOnChain } from "./dist/mirror.js";
import { buildUserOp, submitUserOp, chainCtxFor } from "./dist/userop.js";
import { KeychainSessionKeySigner } from "./dist/sessionKeySigner.js";

const apiKey = process.env.PIMLICO_API_KEY;
if (!apiKey) throw new Error("PIMLICO_API_KEY not set");
const bundlerUrl = `https://api.pimlico.io/v2/base-sepolia/rpc?apikey=${apiKey}`;
const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com") });
let fails = 0; const ok = (c, m) => { if (c) console.log("  ✓", m); else { console.log("  ✗", m); fails++; } };

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC (budget token)
const WETH = "0x4200000000000000000000000000000000000006"; // basket token
const NO_CODE_ROUTER = "0x000000000000000000000000000000000000c0de";

const owner = privateKeyToAccount(process.env.TEST_PRIVATE_KEY ?? generatePrivateKey());
const registry = new StrategySessionRegistry(join(mkdtempSync(join(tmpdir(), "cyppie-c12-")), "strategy-sessions.json"));

// Test-inject the QuoterV2 price (no live testnet pool needed; the real quoter path is proven by simulateContract).
__setTestQuote(84532, WETH, 10n ** 18n, 2000n * 10n ** 6n); // 1 WETH ≈ 2000 USDC (6dec)

// 1) PREPARE (engine-owned caps).
console.log("[prepare] provision key → QuoterV2 snapshot → deriveSellCaps → buildStrategySession → record…");
const prepare = await prepareStrategySession(registry, {
  chainId: 84532, follower: owner.address, budgetToken: USDC, budget: 1000n * 10n ** 6n, // 1000 USDC
  basket: [{ token: WETH, weightBps: 5000 }], windowStart: 0, windowEnd: 1893456000, router: NO_CODE_ROUTER, feeTier: 500,
});
ok(!!prepare.permissionId && prepare.sessionPublicKey && prepare.caps.length === 2, `prepared ${prepare.permissionId} (caps: ${prepare.caps.length})`);
ok(prepare.caps.every((c) => c.capBaseUnits && c.valueSnapshotBaseUnits), "caps carry capBaseUnits + valueSnapshotBaseUnits (FR-9)");
console.log("  caps:", JSON.stringify(prepare.caps));

if (process.env.RUN_SEND !== "1") { console.log("\n[setup-only] set RUN_SEND=1 for the on-chain enable→grant→list→revoke."); cleanup(); process.exit(fails); }

// 2) ENABLE on-chain (owner-signed): rebuild the session from the StrategyPrepare, install + enableSessions.
const session = buildStrategySession(prepare.sessionPublicKey, prepare.salt, {
  chainId: 84532, legs: sellCapsToScopeLegs(prepare.caps), router: NO_CODE_ROUTER, windowStart: 0, windowEnd: 1893456000, account: owner.address,
});
const account = await to7702KernelSmartAccount({ client, owner, entryPoint: { address: entryPoint07Address, version: "0.7" }, version: "0.3.3" });
const md = getAccount({ address: account.address, type: "kernel" });
const installData = encodePacked(["address", "bytes"], ["0x0000000000000000000000000000000000000001",
  encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes" }], [getSmartSessionsValidator({}).initData ?? "0x", "0x", "0xe9ae5c53"])]);
const installCallData = encodeFunctionData({ abi: parseAbi(["function installModule(uint256 t, address m, bytes d)"]), args: [1n, SMART_SESSIONS_ADDRESS, installData] });
const enableAction = getEnableSessionsAction({ sessions: [{ ...session, permitERC4337Paymaster: true }] });
const pimlico = createPimlicoClient({ transport: http(bundlerUrl) });
const sac = createSmartAccountClient({ account, chain: baseSepolia, bundlerTransport: http(bundlerUrl), paymaster: pimlico,
  paymasterContext: { sponsorshipPolicyId: process.env.PIMLICO_SPONSORSHIP_POLICY_ID ?? "sp_next_micromax" },
  userOperation: { estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast } });
const authorization = await owner.signAuthorization({ contractAddress: account.authorization.address, chainId: baseSepolia.id, nonce: await client.getTransactionCount({ address: owner.address }) });
console.log("\n[enable] install + enableSessions(strategy)…");
const eR = await sac.waitForUserOperationReceipt({ hash: await sac.sendUserOperation({ calls: [{ to: account.address, value: 0n, data: installCallData }, { to: enableAction.to, value: 0n, data: enableAction.callData }], authorization }) });
ok(eR.success, `enable receipt ${eR.receipt.transactionHash}`);
let enabled = false; for (let i = 0; i < 12 && !enabled; i++) { enabled = await isSessionEnabled({ client, account: md, permissionId: prepare.permissionId }); if (!enabled) await new Promise((r) => setTimeout(r, 3000)); }
ok(enabled, "isSessionEnabled");

// 3) GRANT → 4) active-list reconcile shows it live.
registry.grant(prepare.permissionId);
const liveViews = registry.viewByFollower(account.address);
const liveChecked = await Promise.all(liveViews.map(async (v) => ({ v, enabled: await isSessionEnabledOnChain(84532, account.address, v.permissionId).catch(() => true) })));
const live = liveChecked.filter((x) => x.enabled).map((x) => x.v);
ok(live.length === 1 && live[0].permissionId === prepare.permissionId && live[0].status === "active", "active-list reconcile → 1 live granted session");

// 5) REVOKE on-chain (owner-signed removeSession) → 6) reconcile self-heals it out.
console.log("\n[revoke] build removeSession → owner-sign → submit…");
const remove = getRemoveSessionAction({ permissionId: prepare.permissionId });
const built = await buildUserOp(chainCtxFor(84532), account.address, [{ to: remove.to, value: 0n, data: remove.callData }]);
const sig = await owner.sign({ hash: built.digestToSign }); // root-validator EIP-191 digest
const rev = await submitUserOp(chainCtxFor(84532), built.userOp, sig);
const bundler2 = createPimlicoClient({ transport: http(bundlerUrl) });
const rR = await bundler2.waitForUserOperationReceipt({ hash: rev.userOpHash });
ok(rR.success, `revoke receipt ${rR.receipt.transactionHash}`);
let stillEnabled = true; for (let i = 0; i < 12 && stillEnabled; i++) { stillEnabled = await isSessionEnabled({ client, account: md, permissionId: prepare.permissionId }); if (stillEnabled) await new Promise((r) => setTimeout(r, 3000)); }
ok(!stillEnabled, "session disabled on-chain after removeSession");
// reconcile self-heal: the list now drops it (and marks revoked).
const afterViews = registry.viewByFollower(account.address);
const afterChecked = await Promise.all(afterViews.map(async (v) => ({ v, enabled: await isSessionEnabledOnChain(84532, account.address, v.permissionId).catch(() => true) })));
for (const { v, enabled } of afterChecked) if (!enabled) registry.revoke(v.permissionId);
ok(registry.viewByFollower(account.address).length === 0, "active-list self-heals → 0 after revoke");

console.log("\n================ KAN-164 strategy lifecycle e2e ================");
console.log("permissionId :", prepare.permissionId);
console.log("enable tx    :", eR.receipt.transactionHash);
console.log("revoke tx    :", rR.receipt.transactionHash);
console.log("===============================================================");
cleanup();
console.log(fails === 0 ? "\nKAN-164 STRATEGY LIFECYCLE E2E ALL PASS ✓" : `\n${fails} FAILED ✗`);
process.exit(fails === 0 ? 0 : 1);

function cleanup() {
  try { KeychainSessionKeySigner.delete(STRATEGY_KEYCHAIN_SERVICE, registry.get(prepare.permissionId)?.keychainAccount ?? ""); } catch { /* idempotent */ }
}
