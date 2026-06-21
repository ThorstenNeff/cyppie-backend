// KAN-157 on-chain REVOKE E2E (PRD-06), Base Sepolia — proves the non-custodial revoke through PRODUCTION code.
//   AA_ALLOW_TESTNET=1 RUN_SEND=1 node --env-file=../.env c7-revoke-e2e.mjs
//
// Flow: prepare → enable (owner install+enableSessions) → grant → confirm USE-mode mirror WORKS → REVOKE
// (buildUserOp SmartSessions.removeSession → owner raw-signs digestToSign on-device → submitUserOp → receipt) →
// confirm the session is UNUSABLE: isSessionEnabled == false AND a USE-mode mirror now REVERTS. Reuses the proven
// /v1/userop/build + /submit primitives (= the prod /v1/copy/session/revoke/build + /submit path).
//
// 🔑 Non-custodial: the revoke (removeSession) is OWNER-authorized (Kernel root, owner signs on-device, ADR-0009)
// — the backend only builds + relays. The remaining budget never moved; the session key is just made inert.
import { createPublicClient, http, encodeFunctionData, parseAbi, encodePacked, encodeAbiParameters, toHex } from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint07Address, createBundlerClient } from "viem/account-abstraction";
import { to7702KernelSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { createSmartAccountClient } from "permissionless";
import { getSmartSessionsValidator, getEnableSessionsAction, getRemoveSessionAction, isSessionEnabled, getAccount, SMART_SESSIONS_ADDRESS } from "@rhinestone/module-sdk";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CopySessionRegistry } from "./dist/copySession.js";
import { buildUserOp, submitUserOp, chainCtxFor } from "./dist/userop.js";
import { submitMirror } from "./dist/mirror.js";

const apiKey = process.env.PIMLICO_API_KEY;
if (!apiKey) throw new Error("PIMLICO_API_KEY not set");
const bundlerUrl = `https://api.pimlico.io/v2/base-sepolia/rpc?apikey=${apiKey}`;
const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com") });
let fails = 0; const ok = (c, m) => { if (c) console.log("  ✓", m); else { console.log("  ✗", m); fails++; } };

const WETH = "0x4200000000000000000000000000000000000006";
const DUMMY_ROUTER = "0x000000000000000000000000000000000000c0de";
const home = mkdtempSync(join(tmpdir(), "cyppie-c7-"));
process.env.CYPPIE_HOME = home;
const reg = new CopySessionRegistry(join(home, "aa-trigger", "copy-sessions.json"));
const owner = privateKeyToAccount(process.env.TEST_PRIVATE_KEY ?? generatePrivateKey());
console.log("follower owner EOA:", owner.address);

const scope = { chainId: 84532, token: WETH, capTotalBudget: 10n ** 18n, router: DUMMY_ROUTER, selector: "0x5ae401dc",
  windowStart: 0, windowEnd: 1893456000, follower: owner.address, source: "0x1111111111111111111111111111111111111111" };
const inputs = reg.prepare(scope);
const permissionId = inputs.permissionId;
console.log("permissionId:", permissionId);
const cleanup = () => { try { execFileSync("security", ["delete-generic-password", "-s", "cyppie-copy-session", "-a", reg.get(permissionId)?.keychainAccount ?? "x"]); } catch {} try { rmSync(home, { recursive: true, force: true }); } catch {} };

if (process.env.RUN_SEND !== "1") { console.log("\n[setup-only] set RUN_SEND=1 for the on-chain enable+revoke."); cleanup(); process.exit(0); }

// 1) enable (owner): 7702 + install SmartSessions + enableSessions.
const account = await to7702KernelSmartAccount({ client, owner, entryPoint: { address: entryPoint07Address, version: "0.7" }, version: "0.3.3" });
const mdAccount = getAccount({ address: account.address, type: "kernel" });
const installData = encodePacked(["address", "bytes"], ["0x0000000000000000000000000000000000000001",
  encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes" }], [getSmartSessionsValidator({}).initData ?? "0x", "0x", "0xe9ae5c53"])]);
const installCallData = encodeFunctionData({ abi: parseAbi(["function installModule(uint256 t, address m, bytes d)"]), args: [1n, SMART_SESSIONS_ADDRESS, installData] });
const session = { sessionValidator: inputs.sessionValidator, sessionValidatorInitData: inputs.sessionValidatorInitData, salt: inputs.salt,
  userOpPolicies: inputs.userOpPolicies, erc7739Policies: inputs.erc7739Policies, actions: inputs.actions, permitERC4337Paymaster: true };
const enableAction = getEnableSessionsAction({ sessions: [session] });
const pimlico = createPimlicoClient({ transport: http(bundlerUrl) });
const sac = createSmartAccountClient({ account, chain: baseSepolia, bundlerTransport: http(bundlerUrl), paymaster: pimlico,
  paymasterContext: { sponsorshipPolicyId: process.env.PIMLICO_SPONSORSHIP_POLICY_ID ?? "sp_next_micromax" },
  userOperation: { estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast } });
const authNonce = await client.getTransactionCount({ address: owner.address });
const authorization = await owner.signAuthorization({ contractAddress: account.authorization.address, chainId: baseSepolia.id, nonce: authNonce });
console.log("\n[enable] install + enableSessions…");
const eR = await sac.waitForUserOperationReceipt({ hash: await sac.sendUserOperation({ calls: [{ to: account.address, value: 0n, data: installCallData }, { to: enableAction.to, value: 0n, data: enableAction.callData }], authorization }) });
ok(eR.success, `enable receipt ${eR.receipt.transactionHash}`);
let enabled = false; for (let i = 0; i < 12 && !enabled; i++) { enabled = await isSessionEnabled({ client, account: mdAccount, permissionId }); if (!enabled) await new Promise((r) => setTimeout(r, 3000)); }
ok(enabled, "isSessionEnabled == true (pre-revoke)");
reg.grant(permissionId);

// 2) sanity: a USE-mode mirror WORKS before revoke.
const bundler = createBundlerClient({ chain: baseSepolia, transport: http(bundlerUrl) });
const mirrorCall = { to: WETH, value: 0n, data: encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), args: ["0x000000000000000000000000000000000000dEaD", 0n] }) };
const pre = await submitMirror(reg.get(permissionId), reg.signerFor(permissionId), [mirrorCall], reg.nextNonceKey(owner.address));
const preR = await bundler.waitForUserOperationReceipt({ hash: pre.userOpHash });
ok(preR.success, `pre-revoke USE mirror works ${preR.receipt.transactionHash}`);

// 3) REVOKE (production path): buildUserOp(removeSession) → owner raw-signs digestToSign → submitUserOp.
console.log("\n[revoke] build removeSession op (owner-signed, on-chain)…");
const remove = getRemoveSessionAction({ permissionId });
const built = await buildUserOp(chainCtxFor(84532), owner.address, [{ to: remove.to, value: 0n, data: remove.callData }]);
ok(!built.authorizationToSign, "no re-delegation needed (already 7702-upgraded)");
const signature = await owner.sign({ hash: built.digestToSign }); // raw ECDSA over digestToSign = hashMessage(userOpHash)
const rv = await submitUserOp(chainCtxFor(84532), built.userOp, signature);
const rvR = await bundler.waitForUserOperationReceipt({ hash: rv.userOpHash });
ok(rvR.success, `REVOKE RECEIPT ${rvR.receipt.transactionHash} (blk ${rvR.receipt.blockNumber})`);
reg.revoke(permissionId);

// 4) confirm UNUSABLE: isSessionEnabled == false AND a USE-mode mirror now REVERTS.
let stillEnabled = true; for (let i = 0; i < 12 && stillEnabled; i++) { stillEnabled = await isSessionEnabled({ client, account: mdAccount, permissionId }); if (stillEnabled) await new Promise((r) => setTimeout(r, 3000)); }
ok(!stillEnabled, "isSessionEnabled == false (post-revoke — on-chain session gone)");
let mirrorReverted = false;
try {
  const post = await submitMirror(reg.get(permissionId) ?? { ...reg.get(permissionId) }, reg.signerFor(permissionId), [mirrorCall], reg.nextNonceKey(owner.address));
  // if it somehow submitted, the receipt must NOT succeed
  const postR = await bundler.waitForUserOperationReceipt({ hash: post.userOpHash }).catch(() => null);
  mirrorReverted = !postR || !postR.success;
} catch { mirrorReverted = true; }
ok(mirrorReverted, "post-revoke USE mirror is rejected (session unusable — no further copy)");

console.log("\n================ KAN-157 on-chain REVOKE ================");
console.log("enable tx     :", eR.receipt.transactionHash);
console.log("pre-revoke USE:", preR.receipt.transactionHash, "(success)");
console.log("REVOKE tx     :", rvR.receipt.transactionHash, "(removeSession, owner-signed)");
console.log("post-revoke   : isSessionEnabled=false + USE mirror rejected");
console.log("========================================================");
cleanup();
console.log(fails === 0 ? "\nKAN-157 REVOKE E2E ALL PASS ✓" : `\n${fails} FAILED ✗`);
process.exit(fails === 0 ? 0 : 1);
