// C4 end-to-end (PRD-06 / KAN-149) — the /v1/session/trigger money-path, Base Sepolia.
//   AA_ALLOW_TESTNET=1 RUN_SEND=1 node --env-file=../.env c4-trigger.mjs
//
// Exercises the PRODUCTION code: CopySessionRegistry (prepare/grant/SubmitGate) + submitMirror (USE-mode build
// + session-key sign + submit). Flow: prepare → enable the scoped session on-chain (owner consent) → grant →
// SubmitGate → submitMirror → real receipt → record; then the gate rejections (idempotency / kill-switch / Q7).
import { createPublicClient, http, encodeFunctionData, parseAbi, encodePacked, encodeAbiParameters, toHex, hexToBytes } from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint07Address } from "viem/account-abstraction";
import { to7702KernelSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { createSmartAccountClient } from "permissionless";
import {
  getSmartSessionsValidator, getEnableSessionsAction, isSessionEnabled, getAccount, SMART_SESSIONS_ADDRESS,
} from "@rhinestone/module-sdk";
import { rmSync } from "node:fs";
import { CopySessionRegistry, GateError } from "./dist/copySession.js";
import { submitMirror } from "./dist/mirror.js";

const apiKey = process.env.PIMLICO_API_KEY;
if (!apiKey) throw new Error("PIMLICO_API_KEY not set");
const bundlerUrl = `https://api.pimlico.io/v2/base-sepolia/rpc?apikey=${apiKey}`;
const client = createPublicClient({ chain: baseSepolia, transport: http("https://base-sepolia-rpc.publicnode.com") });
let fails = 0; const ok = (c, m) => { if (c) console.log("  ✓", m); else { console.log("  ✗", m); fails++; } };

const WETH = "0x4200000000000000000000000000000000000006";
const SWAP_SELECTOR = "0x5ae401dc";
const DUMMY_ROUTER = "0x000000000000000000000000000000000000c0de";
const owner = privateKeyToAccount(generatePrivateKey()); // the follower (7702 same-address)
console.log("follower owner EOA:", owner.address);

// 1) prepare: registry provisions the backend session key + assembles the (two-action, C3-corrected) enable.
const path = "./copy-sessions.c4.json";
rmSync(path, { force: true });
const reg = new CopySessionRegistry(path);
const scope = {
  chainId: 84532, token: WETH, capTotalBudget: 10n ** 18n, // 1e18 cap (WETH)
  router: DUMMY_ROUTER, selector: SWAP_SELECTOR, windowStart: 0, windowEnd: 1893456000,
  follower: owner.address, source: "0x1111111111111111111111111111111111111111",
};
const inputs = reg.prepare(scope);
const permissionId = inputs.permissionId;
console.log("prepared permissionId:", permissionId, "| backend session key:", inputs.sessionPublicKey);

if (process.env.RUN_SEND !== "1") { console.log("\n[gate-only] set RUN_SEND=1 for the on-chain mirror."); process.exit(0); }

// 2) enable the session on-chain (owner consent): install Smart Sessions (+selectorData execute, hook=addr(1)) +
//    enableSessions(the registry session). Signed by the follower owner — the one-time grant.
const account = await to7702KernelSmartAccount({ client, owner, entryPoint: { address: entryPoint07Address, version: "0.7" }, version: "0.3.3" });
const mdAccount = getAccount({ address: account.address, type: "kernel" });
const installData = encodePacked(["address", "bytes"], ["0x0000000000000000000000000000000000000001",
  encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes" }], [getSmartSessionsValidator({}).initData ?? "0x", "0x", "0xe9ae5c53"])]);
const installCallData = encodeFunctionData({ abi: parseAbi(["function installModule(uint256 t, address m, bytes d)"]), args: [1n, SMART_SESSIONS_ADDRESS, installData] });
const session = {
  sessionValidator: inputs.sessionValidator, sessionValidatorInitData: inputs.sessionValidatorInitData, salt: inputs.salt,
  userOpPolicies: inputs.userOpPolicies, erc7739Policies: inputs.erc7739Policies, actions: inputs.actions, permitERC4337Paymaster: true,
};
const enableAction = getEnableSessionsAction({ sessions: [session] });
const pimlico = createPimlicoClient({ transport: http(bundlerUrl) });
const sac = createSmartAccountClient({ account, chain: baseSepolia, bundlerTransport: http(bundlerUrl), paymaster: pimlico,
  paymasterContext: { sponsorshipPolicyId: process.env.PIMLICO_SPONSORSHIP_POLICY_ID ?? "sp_next_micromax" },
  userOperation: { estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast } });
const authNonce = await client.getTransactionCount({ address: owner.address });
const authorization = await owner.signAuthorization({ contractAddress: account.authorization.address, chainId: baseSepolia.id, nonce: authNonce });
console.log("\n[enable] install + enableSessions (owner-signed)…");
const eH = await sac.sendUserOperation({ calls: [{ to: account.address, value: 0n, data: installCallData }, { to: enableAction.to, value: 0n, data: enableAction.callData }], authorization });
const eR = await sac.waitForUserOperationReceipt({ hash: eH });
ok(eR.success, `enable receipt ${eR.receipt.transactionHash}`);
let enabled = false; for (let i = 0; i < 10 && !enabled; i++) { enabled = await isSessionEnabled({ client, account: mdAccount, permissionId }); if (!enabled) await new Promise((r) => setTimeout(r, 3000)); }
ok(enabled, "isSessionEnabled");

// 3) grant → 4) SubmitGate → 5) submitMirror (the C4 production path).
reg.grant(permissionId, "0x01");
const mirrorCall = { to: WETH, value: "0x0", data: encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), args: ["0x000000000000000000000000000000000000dEaD", 0n] }) };
const spend = 10n ** 17n; // 0.1 WETH spend for this mirror (Q7 accounting)
const src1 = "0xaaa1";
const rec = reg.assertMirrorable(permissionId, spend, src1); // gate passes
const { userOpHash } = await submitMirror(rec, reg.signerFor(permissionId), [{ to: mirrorCall.to, value: 0n, data: mirrorCall.data }]);
console.log("[mirror] userOpHash:", userOpHash);
const { createBundlerClient } = await import("viem/account-abstraction");
const bundler = createBundlerClient({ chain: baseSepolia, transport: http(bundlerUrl) });
const mR = await bundler.waitForUserOperationReceipt({ hash: userOpHash });
ok(mR.success, `MIRROR RECEIPT ${mR.receipt.transactionHash} (blk ${mR.receipt.blockNumber})`);
reg.recordMirror(permissionId, spend, src1);
ok(BigInt(reg.get(permissionId).spentTotal) === spend, "Q7 spentTotal recorded");

// 6) gate rejections.
console.log("\n[gate] rejections:");
try { reg.assertMirrorable(permissionId, spend, src1); ok(false, "idempotency"); } catch (e) { ok(e instanceof GateError, `idempotency: ${e.message}`); }
reg.setPaused(permissionId, true);
try { reg.assertMirrorable(permissionId, spend, "0xbbb2"); ok(false, "kill-switch"); } catch (e) { ok(e instanceof GateError, `kill-switch: ${e.message}`); }
reg.setPaused(permissionId, false);
try { reg.assertMirrorable(permissionId, 10n ** 18n, "0xccc3"); ok(false, "Q7 cap"); } catch (e) { ok(e instanceof GateError, `Q7 cap: ${e.message}`); }

rmSync(path, { force: true });
import("node:child_process").then(({ execFileSync }) => {
  try { execFileSync("security", ["delete-generic-password", "-s", "cyppie-copy-session", "-a", reg.get?.(permissionId)?.keychainAccount ?? "x"]); } catch {}
  console.log(fails === 0 ? "\nC4 ALL PASS ✓" : `\n${fails} FAILED ✗`); process.exit(fails === 0 ? 0 : 1);
});
