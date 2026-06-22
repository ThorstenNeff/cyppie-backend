// DCA orchestration e2e helper (KAN-163) — ENABLE a scoped DCA session on Base Sepolia, print {account,permissionId}.
// Used by the Kotlin DcaOrchestrationE2eTest to set up an on-chain-enabled session the scheduler then buys through.
// This is the exact c9 enable scope (WETH cap + dummy DCA router 0x…c0de + multicall window), owner = TEST key.
//   TEST_PRIVATE_KEY=0x… node scripts/e2e-enable.mjs    (env-file/PIMLICO supplied by the caller)
import { createPublicClient, http, encodeFunctionData, parseAbi, encodePacked, encodeAbiParameters, toHex } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { entryPoint07Address } from "viem/account-abstraction";
import { to7702KernelSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { createSmartAccountClient } from "permissionless";
import { getSmartSessionsValidator, getEnableSessionsAction, isSessionEnabled, getAccount, getPermissionId, SMART_SESSIONS_ADDRESS } from "@rhinestone/module-sdk";
import { buildSession } from "../dist/copySession.js";

const apiKey = process.env.PIMLICO_API_KEY;
if (!apiKey) throw new Error("PIMLICO_API_KEY not set");
const pk = process.env.TEST_PRIVATE_KEY;
if (!pk) throw new Error("TEST_PRIVATE_KEY must be set (the e2e fixed owner key, shared with the sign step)");

const bundlerUrl = `https://api.pimlico.io/v2/base-sepolia/rpc?apikey=${apiKey}`;
const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com") });
const owner = privateKeyToAccount(pk);

const WETH = "0x4200000000000000000000000000000000000006";
const DCA_ROUTER = "0x000000000000000000000000000000000000c0de"; // no-code (SwapRouter02 multicall bytes KAT-proven separately)
const SWAP_SELECTOR = "0x5ae401dc";
const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
const scope = { chainId: 84532, token: WETH, capTotalBudget: 10n ** 18n, router: DCA_ROUTER, selector: SWAP_SELECTOR,
  windowStart: 0, windowEnd: 1893456000, follower: owner.address, source: "0x1111111111111111111111111111111111111111" };
const session = buildSession(owner.address, salt, scope);
const permissionId = getPermissionId({ session });

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
const eR = await sac.waitForUserOperationReceipt({ hash: await sac.sendUserOperation({ calls: [{ to: account.address, value: 0n, data: installCallData }, { to: enableAction.to, value: 0n, data: enableAction.callData }], authorization }) });
if (!eR.success) throw new Error("enable failed");
let enabled = false; for (let i = 0; i < 12 && !enabled; i++) { enabled = await isSessionEnabled({ client, account: md, permissionId }); if (!enabled) await new Promise((r) => setTimeout(r, 3000)); }
if (!enabled) throw new Error("session not enabled after enable receipt");

// The ONLY stdout line = the JSON the Kotlin harness parses (account, permissionId + the buy params it must seed).
process.stderr.write(`[e2e-enable] enabled ${permissionId} on ${account.address} (enable tx ${eR.receipt.transactionHash})\n`);
console.log(JSON.stringify({
  chainId: 84532, account: account.address, permissionId,
  tokenIn: WETH, tokenOut: WETH, router: DCA_ROUTER, amountIn: "1", feeTier: 500, amountOutMin: "0",
}));
