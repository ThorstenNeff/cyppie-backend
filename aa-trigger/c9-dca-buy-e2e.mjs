// KAN-163 DCA recurring-buy E2E (PRD-05), Base Sepolia — the USE-mode on-device buy through PRODUCTION code.
//   AA_ALLOW_TESTNET=1 RUN_SEND=1 node --env-file=../.env c9-dca-buy-e2e.mjs
//
// Proves the aa-trigger DCA money-path (/v1/dca/build + /v1/dca/submit = buildDcaBuy/submitDcaBuy): enable a
// scoped DCA Smart-Session (OwnableValidator owner = the user's ON-DEVICE key) → buildDcaBuy (USE-mode op,
// smart-session nonce) → owner RAW-signs the userOpHash (C3 USE-lock, NOT EIP-191) → submitDcaBuy (wrap USE-mode)
// → real sponsored buy RECEIPT. No-liquidity-safe via a no-code DCA router (the SwapRouter02 multicall bytes are
// KAT-proven in dcaadapter.test.mjs); real-liquidity buy = with KAN-153 mainnet.
import { createPublicClient, http, encodeFunctionData, parseAbi, encodePacked, encodeAbiParameters, toHex } from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint07Address, createBundlerClient } from "viem/account-abstraction";
import { to7702KernelSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { createSmartAccountClient } from "permissionless";
import { getSmartSessionsValidator, getEnableSessionsAction, isSessionEnabled, getAccount, getPermissionId, SMART_SESSIONS_ADDRESS } from "@rhinestone/module-sdk";
import { buildSession } from "./dist/copySession.js";
import { buildDcaBuy, submitDcaBuy } from "./dist/dcaBuild.js";

const apiKey = process.env.PIMLICO_API_KEY;
if (!apiKey) throw new Error("PIMLICO_API_KEY not set");
const bundlerUrl = `https://api.pimlico.io/v2/base-sepolia/rpc?apikey=${apiKey}`;
const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com") });
let fails = 0; const ok = (c, m) => { if (c) console.log("  ✓", m); else { console.log("  ✗", m); fails++; } };

const WETH = "0x4200000000000000000000000000000000000006";
const DCA_ROUTER = "0x000000000000000000000000000000000000c0de"; // no-code (SwapRouter02 multicall bytes KAT-proven separately)
const SWAP_SELECTOR = "0x5ae401dc"; // multicall(uint256,bytes[])
const owner = privateKeyToAccount(process.env.TEST_PRIVATE_KEY ?? generatePrivateKey());
console.log("owner EOA (= DCA session key, on-device):", owner.address);

// DCA session: OwnableValidator owner = the on-device key (DCA signer = on-device). Dummy router → buildSession's
// 2-action fallback = [WETH.approve cap, router.multicall window] — exactly the C3-corrected DCA scope.
const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
const scope = { chainId: 84532, token: WETH, capTotalBudget: 10n ** 18n, router: DCA_ROUTER, selector: SWAP_SELECTOR,
  windowStart: 0, windowEnd: 1893456000, follower: owner.address, source: "0x1111111111111111111111111111111111111111" };
const session = buildSession(owner.address, salt, scope);
const permissionId = getPermissionId({ session });
console.log("permissionId:", permissionId, "| actions:", session.actions.length);

if (process.env.RUN_SEND !== "1") { console.log("\n[setup-only] set RUN_SEND=1 for the on-chain DCA buy."); process.exit(0); }

// 1) enable (owner): 7702 + install SmartSessions + enableSessions(session).
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
console.log("\n[enable] install + enableSessions…");
const eR = await sac.waitForUserOperationReceipt({ hash: await sac.sendUserOperation({ calls: [{ to: account.address, value: 0n, data: installCallData }, { to: enableAction.to, value: 0n, data: enableAction.callData }], authorization }) });
ok(eR.success, `enable receipt ${eR.receipt.transactionHash}`);
let enabled = false; for (let i = 0; i < 12 && !enabled; i++) { enabled = await isSessionEnabled({ client, account: md, permissionId }); if (!enabled) await new Promise((r) => setTimeout(r, 3000)); }
ok(enabled, "isSessionEnabled");

// 2) DCA BUY (production path): buildDcaBuy → owner raw-signs userOpHash → submitDcaBuy.
console.log("\n[dca-buy] build (USE-mode, smart-session) → owner raw-sign → submit…");
const built = await buildDcaBuy(84532, account.address, permissionId, {
  router: DCA_ROUTER, tokenIn: WETH, tokenOut: WETH, amountIn: 1n, amountOutMin: 0n, feeTier: 500, deadline: 1893456000n,
});
ok(built.digestToSign === built.userOpHash, "digestToSign == RAW userOpHash (C3 USE-lock, not EIP-191)");
const signature = await owner.sign({ hash: built.userOpHash }); // on-device raw secp256k1 over the userOpHash
const sub = await submitDcaBuy(84532, permissionId, built.userOp, signature);
const bundler = createBundlerClient({ chain: baseSepolia, transport: http(bundlerUrl) });
const buyR = await bundler.waitForUserOperationReceipt({ hash: sub.userOpHash });
ok(buyR.success, `DCA BUY RECEIPT ${buyR.receipt.transactionHash} (blk ${buyR.receipt.blockNumber}) success=${buyR.success}`);

console.log("\n================ KAN-163 DCA buy (USE-mode, on-device) ================");
console.log("enable tx     :", eR.receipt.transactionHash);
console.log("DCA buy tx    :", buyR.receipt.transactionHash, "| userOpHash:", sub.userOpHash);
console.log("=======================================================================");
import("node:child_process").then(() => {});
console.log(fails === 0 ? "\nKAN-163 DCA BUY E2E ALL PASS ✓" : `\n${fails} FAILED ✗`);
process.exit(fails === 0 ? 0 : 1);
