// KAN-161 DYNAMIC-mode E2E (PRD-06), Base Sepolia — proves the dynamic copy path through the REAL server handler.
//   AA_ALLOW_TESTNET=1 RUN_SEND=1 node --env-file=../.env c8-dynamic-e2e.mjs
//
// A session with scope.tokenOut = null (DYNAMIC mode): the webhook derives `tokenOut` from the source swap's
// OUTPUT leg (the token the trader received) and mirrors THAT — instead of a pre-pinned token. Proves:
// HMAC webhook (2-leg swap) → parseFollowedSpends derives tokenOut → dynamic-mode mirror → on-chain receipt.
// (The receipt leg uses the no-code test router so it lands without DEX liquidity, like c6-e2e; the derived
// tokenOut flows into the plan + the response, which is the dynamic-path proof. Real-liquidity = KAN-153.)
//
// 🔑 Guardrail (ADR-0024): dynamic never submits without a reliable minOut — mainnet fail-closes until QuoterV2
// (KAN-151); testnet (no MEV) allows a 0 floor for this proof. Fixed mode (scope.tokenOut set) is unchanged.
import { createPublicClient, http, encodeFunctionData, parseAbi, encodePacked, encodeAbiParameters, toHex } from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint07Address, createBundlerClient } from "viem/account-abstraction";
import { to7702KernelSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { createSmartAccountClient } from "permissionless";
import { getSmartSessionsValidator, getEnableSessionsAction, isSessionEnabled, getAccount, SMART_SESSIONS_ADDRESS } from "@rhinestone/module-sdk";
import { createHmac } from "node:crypto";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const apiKey = process.env.PIMLICO_API_KEY;
if (!apiKey) throw new Error("PIMLICO_API_KEY not set");
const bundlerUrl = `https://api.pimlico.io/v2/base-sepolia/rpc?apikey=${apiKey}`;
const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com") });
let fails = 0; const ok = (c, m) => { if (c) console.log("  ✓", m); else { console.log("  ✗", m); fails++; } };

const WETH = "0x4200000000000000000000000000000000000006";   // tokenIn (the trader spends)
const TOKEN_OUT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC — what the trader BOUGHT (dynamic target)
const POOL = "0x5555555555555555555555555555555555555555";
const DUMMY_ROUTER = "0x000000000000000000000000000000000000c0de";
const SOURCE = "0x1111111111111111111111111111111111111111";
const WEBHOOK_KEY = "whsec_c8_dyn";

const home = mkdtempSync(join(tmpdir(), "cyppie-c8-"));
process.env.CYPPIE_HOME = home;
process.env.ALCHEMY_WEBHOOK_SIGNING_KEY = WEBHOOK_KEY;
process.env.COPY_TEST_HOOKS = "1";

const { CopySessionRegistry } = await import("./dist/copySession.js");
const reg = new CopySessionRegistry(join(home, "aa-trigger", "copy-sessions.json"));
const owner = privateKeyToAccount(process.env.TEST_PRIVATE_KEY ?? generatePrivateKey());
console.log("follower owner EOA:", owner.address);

// DYNAMIC scope: tokenOut + feeTier OMITTED → dynamic mode.
const scope = { chainId: 84532, token: WETH, capTotalBudget: 10n ** 18n, router: DUMMY_ROUTER, selector: "0x5ae401dc",
  windowStart: 0, windowEnd: 1893456000, follower: owner.address, source: SOURCE };
const inputs = reg.prepare(scope);
const permissionId = inputs.permissionId;
console.log("permissionId:", permissionId, "| scope.tokenOut:", scope.tokenOut ?? "(null → DYNAMIC)");
const cleanup = () => { try { execFileSync("security", ["delete-generic-password", "-s", "cyppie-copy-session", "-a", reg.get(permissionId)?.keychainAccount ?? "x"]); } catch {} try { rmSync(home, { recursive: true, force: true }); } catch {} };

if (process.env.RUN_SEND !== "1") { console.log("\n[setup-only] set RUN_SEND=1 for the on-chain dynamic mirror."); cleanup(); process.exit(0); }

// enable (owner) + grant.
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
const authorization = await owner.signAuthorization({ contractAddress: account.authorization.address, chainId: baseSepolia.id, nonce: await client.getTransactionCount({ address: owner.address }) });
console.log("\n[enable] install + enableSessions…");
const eR = await sac.waitForUserOperationReceipt({ hash: await sac.sendUserOperation({ calls: [{ to: account.address, value: 0n, data: installCallData }, { to: enableAction.to, value: 0n, data: enableAction.callData }], authorization }) });
ok(eR.success, `enable receipt ${eR.receipt.transactionHash}`);
let enabled = false; for (let i = 0; i < 12 && !enabled; i++) { enabled = await isSessionEnabled({ client, account: mdAccount, permissionId }); if (!enabled) await new Promise((r) => setTimeout(r, 3000)); }
ok(enabled, "isSessionEnabled");
reg.grant(permissionId);

// test router/adapter (no-liquidity-safe approve(0)).
const { handle } = await import("./dist/server.js");
const { __registerTestAdapter, APPROVE_SELECTOR } = await import("./dist/swapAdapter.js");
const { __allowTestRouter } = await import("./dist/copyWebhook.js");
__allowTestRouter(84532, DUMMY_ROUTER);
__registerTestAdapter(DUMMY_ROUTER, {
  buildMirrorCalls: () => [{ to: WETH, value: 0n, data: encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), args: ["0x000000000000000000000000000000000000dEaD", 0n] }) }],
  requiredActions: ({ token, router }) => [
    { actionTarget: token, actionTargetSelector: APPROVE_SELECTOR, policy: "cap" },
    { actionTarget: router, actionTargetSelector: "0x5ae401dc", policy: "window" },
  ],
});

// webhook: a 2-leg swap (source spends WETH → DUMMY, source receives USDC ← POOL), same tx hash.
const bundler = createBundlerClient({ chain: baseSepolia, transport: http(bundlerUrl) });
const body = JSON.stringify({ event: { network: "BASE_SEPOLIA", activity: [
  { category: "token", fromAddress: SOURCE, toAddress: DUMMY_ROUTER, hash: "0xc8dyn", rawContract: { address: WETH, rawValue: toHex(10n ** 17n) } },
  { category: "token", fromAddress: POOL, toAddress: SOURCE, hash: "0xc8dyn", rawContract: { address: TOKEN_OUT, rawValue: toHex(250000000n) } },
] } });
const sigHex = createHmac("sha256", WEBHOOK_KEY).update(body, "utf8").digest("hex");
console.log("\n[webhook] 2-leg swap → DYNAMIC derive + mirror…");
const res = await new Promise((resolve) => {
  const out = []; let code = 200;
  handle({ method: "POST", url: "/v1/copy/webhook", headers: { "x-alchemy-signature": sigHex }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(body, "utf8"); } },
    { writeHead(c) { code = c; }, end(s) { if (s) out.push(s); resolve({ status: code, body: JSON.parse(out.join("")) }); } }).catch((e) => resolve({ status: 500, body: { error: String(e?.message ?? e) } }));
});
ok(res.status === 200 && res.body.detected === 1, `webhook 200 + detected 1 (got ${res.status}/${res.body.detected})`);
const m = res.body.mirrors?.[0];
ok(m?.mode === "dynamic", `mirror mode = dynamic (got ${m?.mode})`);
ok(m?.tokenOut?.toLowerCase() === TOKEN_OUT.toLowerCase(), `tokenOut DERIVED from output leg = USDC (got ${m?.tokenOut})`);
ok(m?.status === "submitted" && !!m?.userOpHash, `dynamic mirror submitted (status=${m?.status})`);
if (m?.userOpHash) { const mr = await bundler.waitForUserOperationReceipt({ hash: m.userOpHash }); ok(mr.success, `DYNAMIC MIRROR RECEIPT ${mr.receipt.transactionHash} success=${mr.success}`); }

console.log("\n================ KAN-161 DYNAMIC mirror ================");
console.log("enable tx        :", eR.receipt.transactionHash);
console.log("derived tokenOut :", m?.tokenOut, "(from the trader's output leg)");
console.log("dynamic mirror   :", m?.userOpHash);
console.log("=======================================================");
cleanup();
console.log(fails === 0 ? "\nKAN-161 DYNAMIC E2E ALL PASS ✓" : `\n${fails} FAILED ✗`);
process.exit(fails === 0 ? 0 : 1);
