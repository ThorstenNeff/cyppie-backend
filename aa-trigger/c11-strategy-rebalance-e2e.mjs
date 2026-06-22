// KAN-164 Vaults-B strategy REBALANCE e2e (PRD-07), Base Sepolia — the drift-triggered rebalance through
// PRODUCTION code, signed by the BACKEND strategy session key (USE-mode, RAW userOpHash — the C3 lock).
//   AA_ALLOW_TESTNET=1 RUN_SEND=1 node --env-file=.env c11-strategy-rebalance-e2e.mjs
//
// Proves the strategy runtime money-path: enable a scoped strategy Smart-Session ([M Sell-Caps, Permit2, UR],
// OwnableValidator owner = the BACKEND session key, NOT the device key) → computeRebalanceLegs (drift → the
// over→under swap, clamped to the per-token cap) → buildRebalanceCalls (the SAME UR [approve→Permit2→execute]
// the session enables) → submitRebalanceLeg (USE-mode, session-key raw-signs the userOpHash) → real sponsored
// RECEIPT. No-liquidity-safe via a no-code router (the UR calldata bytes are KAT-proven in strategyrebalance.test
// + swapadapter.test). This is the copy mirror (c6) machinery, drift- instead of webhook-triggered.
import { createPublicClient, http, encodeFunctionData, parseAbi, encodePacked, encodeAbiParameters, toHex } from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint07Address, createBundlerClient } from "viem/account-abstraction";
import { to7702KernelSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { createSmartAccountClient } from "permissionless";
import { getSmartSessionsValidator, getEnableSessionsAction, isSessionEnabled, getAccount, getPermissionId, SMART_SESSIONS_ADDRESS } from "@rhinestone/module-sdk";
import { buildStrategySession } from "./dist/strategySession.js";
import { computeRebalanceLegs, submitRebalanceLeg } from "./dist/strategyRebalance.js";
import { InMemorySessionKeySigner } from "./dist/sessionKeySigner.js";

const apiKey = process.env.PIMLICO_API_KEY;
if (!apiKey) throw new Error("PIMLICO_API_KEY not set");
const bundlerUrl = `https://api.pimlico.io/v2/base-sepolia/rpc?apikey=${apiKey}`;
const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com") });
let fails = 0; const ok = (c, m) => { if (c) console.log("  ✓", m); else { console.log("  ✗", m); fails++; } };

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia USDC (any ERC-20; balance not needed for approve)
const WETH = "0x4200000000000000000000000000000000000006";
const NO_CODE_ROUTER = "0x000000000000000000000000000000000000c0de"; // no-code (UR calldata bytes KAT-proven separately)
const CAP = 10n ** 18n;

const owner = privateKeyToAccount(process.env.TEST_PRIVATE_KEY ?? generatePrivateKey()); // signs the enable (account owner)
const sessionKey = new InMemorySessionKeySigner(generatePrivateKey());                    // BACKEND-held strategy session key
console.log("owner EOA (SCA):", owner.address, "| strategy session key (backend):", sessionKey.publicKeyAddress());

// Strategy session: owners[0] = the backend session key (Auth≠Custody). Legs = [USDC cap, WETH cap]; router = no-code.
const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
const scope = { chainId: 84532, router: NO_CODE_ROUTER, account: owner.address, windowStart: 0, windowEnd: 1893456000,
  legs: [{ token: USDC, cap: CAP }, { token: WETH, cap: CAP }] };
const session = buildStrategySession(sessionKey.publicKeyAddress(), salt, scope);
const permissionId = getPermissionId({ session });
console.log("permissionId:", permissionId, "| actions:", session.actions.length, "(2 caps + Permit2 + UR)");

// Drift: 70/30 vs a 50/50 target → sell 2000 (units) USDC → WETH, clamped to the USDC Sell-Cap.
const legs = computeRebalanceLegs(
  [{ token: USDC, value: 7000n }, { token: WETH, value: 3000n }],
  [{ token: USDC, weightBps: 5000 }, { token: WETH, weightBps: 5000 }],
  100, new Map([[USDC.toLowerCase(), CAP], [WETH.toLowerCase(), CAP]]),
);
ok(legs.length === 1 && legs[0].tokenIn.toLowerCase() === USDC.toLowerCase() && legs[0].tokenOut.toLowerCase() === WETH.toLowerCase(), `drift → 1 leg USDC→WETH amountIn=${legs[0]?.amountIn}`);

if (process.env.RUN_SEND !== "1") { console.log("\n[setup-only] set RUN_SEND=1 for the on-chain rebalance."); process.exit(fails); }

// 1) enable (owner): 7702 + install SmartSessions + enableSessions(strategy session).
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
let enabled = false; for (let i = 0; i < 12 && !enabled; i++) { enabled = await isSessionEnabled({ client, account: md, permissionId }); if (!enabled) await new Promise((r) => setTimeout(r, 3000)); }
ok(enabled, "isSessionEnabled");

// 2) REBALANCE (production path): build the leg's UR calls + session-key raw-signs USE-mode → submit.
console.log("\n[rebalance] submitRebalanceLeg (USE-mode, backend session key raw-signs userOpHash)…");
const sub = await submitRebalanceLeg(84532, account.address, permissionId, sessionKey, NO_CODE_ROUTER, legs[0], { feeTier: 500, amountOutMin: 0n, deadline: 1893456000n });
const bundler = createBundlerClient({ chain: baseSepolia, transport: http(bundlerUrl) });
const rR = await bundler.waitForUserOperationReceipt({ hash: sub.userOpHash });
ok(rR.success, `REBALANCE RECEIPT ${rR.receipt.transactionHash} (blk ${rR.receipt.blockNumber}) success=${rR.success}`);

console.log("\n================ KAN-164 strategy rebalance (USE-mode, backend session key) ================");
console.log("enable tx      :", eR.receipt.transactionHash);
console.log("rebalance tx   :", rR.receipt.transactionHash, "| userOpHash:", sub.userOpHash);
console.log("leg            : USDC→WETH amountIn", legs[0].amountIn.toString(), "(clamped to cap)");
console.log("==========================================================================================");
console.log(fails === 0 ? "\nKAN-164 STRATEGY REBALANCE E2E ALL PASS ✓" : `\n${fails} FAILED ✗`);
process.exit(fails === 0 ? 0 : 1);
