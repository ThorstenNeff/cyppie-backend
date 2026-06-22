// KAN-164 Strategy-Enable-userOp KAT — byte-exact reference for Dev-2's KAN-165 `verifyStrategyEnableUserOp`
// (StrategyGrantService + DTO-reconcile). Run: node scripts/strategy-enable-userop-vector.mjs
//
// The Vaults-B strategy session is the M-token generalization of the copy session: a backend-held, scoped,
// revocable Smart-Session whose action set is `[M Caps, Permit2, UR]` (PO-pinned):
//   actions[0..M-1] = tokenᵢ.approve(095ea7b3) → [SpendingLimits cap_i]   (one Sell-Cap per sell-able token)
//   actions[M]      = Permit2.approve(87517c45) → [TimeFrame window]
//   actions[M+1]    = UniversalRouter.execute(3593564c) → [TimeFrame]
//   userOpPolicies  = [TimeFrame window]
// Same install+enableSessions mechanism as copy/DCA enable (generic /v1/userop/build), so the SAME packing +
// verifyEnableUserOp + verify7702 apply — only the session config (M caps) differs. The copy enable vector is
// the M=1 case of THIS. FIXED gas/nonce ⇒ deterministic + pinnable; the strategy permissionId is the new pin.
import { createPublicClient, http, encodeFunctionData, parseAbi, encodePacked, encodeAbiParameters, toHex, hashMessage } from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint07Address, getUserOperationHash, toPackedUserOperation } from "viem/account-abstraction";
import { to7702KernelSmartAccount } from "permissionless/accounts";
import { getSmartSessionsValidator, getEnableSessionsAction, getPermissionId, SMART_SESSIONS_ADDRESS } from "@rhinestone/module-sdk";
import { buildStrategySession, sortLegs } from "../dist/strategySession.js";

const ENTRYPOINT = entryPoint07Address; // 0x0000000071727De22E5E9d8BAf0edAc6f37da032 (v0.7, both chains)

// ── Canonical KAT inputs (SESSION key + salt SAME convention as the copy enable vector) ──
const SESSION_PUBKEY = "0x489ccacAC8836C71Ad5B20Bf61e0b885425b227e"; // backend session key (owners[0]) — NOT the device main key
const SALT = "0x00000000000000000000000000000000000000000000000000000000000000aa";
const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // strategy SCA (= owner EOA, 7702 same-address) = sender
const WINDOW = { windowStart: 0, windowEnd: 1893456000 };
const UR = { 1: "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af", 8453: "0x6fF5693b99212Da76ad316178A184AB56D299b43" };

// The basket (sell-caps): budget USDC + basket {WETH, WBTC}. Caps are CUMULATIVE per token over the session.
// Per-chain canonical token addresses (real deployments — so the permissionId is chain-correct).
const USDC = { 1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
const WETH = { 1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", 8453: "0x4200000000000000000000000000000000000006" };
const WBTC = { 1: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", 8453: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" }; // Base = cbBTC
const CAPS = { USDC: 1_000_000_000n, WETH: 10n ** 18n, WBTC: 100_000_000n }; // 1000 USDC, 1 WETH, 1 WBTC (per-token)

const FIXED = {
  nonce: 0n, // first op, root-validator lane (key 0) — enable runs on the root validator
  callGasLimit: 600000n, verificationGasLimit: 1500000n, preVerificationGas: 200000n,
  maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 1000000000n,
  paymaster: "0x0000000000000039cd5e8aE05257CE51C473ddd1", paymasterVerificationGasLimit: 400000n, paymasterPostOpGasLimit: 100000n, paymasterData: "0x",
};

// Kernel v3.3 install initData = abi.encodePacked(hook=addr(1), abi.encode(validatorData, hookData, selectorData=execute))
const KERNEL_NO_HOOK = "0x0000000000000000000000000000000000000001";
const KERNEL_EXECUTE_SELECTOR = "0xe9ae5c53";
const installInitData = encodePacked(["address", "bytes"], [KERNEL_NO_HOOK,
  encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes" }], [getSmartSessionsValidator({}).initData ?? "0x", "0x", KERNEL_EXECUTE_SELECTOR])]);
const installCallData = encodeFunctionData({ abi: parseAbi(["function installModule(uint256 t, address m, bytes d)"]), args: [1n, SMART_SESSIONS_ADDRESS, installInitData] });

const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com") });
const account = await to7702KernelSmartAccount({ client, owner: privateKeyToAccount(generatePrivateKey()), entryPoint: { address: ENTRYPOINT, version: "0.7" }, version: "0.3.3" });

for (const chainId of [1, 8453]) {
  const scope = {
    chainId, router: UR[chainId], account: ACCOUNT, ...WINDOW,
    legs: [
      { token: USDC[chainId], cap: CAPS.USDC },
      { token: WETH[chainId], cap: CAPS.WETH },
      { token: WBTC[chainId], cap: CAPS.WBTC },
    ],
  };
  const session = buildStrategySession(SESSION_PUBKEY, SALT, scope);
  const permissionId = getPermissionId({ session });
  const enableAction = getEnableSessionsAction({ sessions: [session] });
  const callData = await account.encodeCalls([
    { to: ACCOUNT, value: 0n, data: installCallData },
    { to: enableAction.to, value: 0n, data: enableAction.callData },
  ]);

  const userOperation = {
    sender: ACCOUNT, nonce: FIXED.nonce, callData,
    callGasLimit: FIXED.callGasLimit, verificationGasLimit: FIXED.verificationGasLimit, preVerificationGas: FIXED.preVerificationGas,
    maxFeePerGas: FIXED.maxFeePerGas, maxPriorityFeePerGas: FIXED.maxPriorityFeePerGas,
    paymaster: FIXED.paymaster, paymasterVerificationGasLimit: FIXED.paymasterVerificationGasLimit,
    paymasterPostOpGasLimit: FIXED.paymasterPostOpGasLimit, paymasterData: FIXED.paymasterData, signature: "0x",
  };
  const packed = toPackedUserOperation(userOperation);
  const userOpHash = getUserOperationHash({ userOperation, entryPointAddress: ENTRYPOINT, entryPointVersion: "0.7", chainId });
  const digestToSign = hashMessage({ raw: userOpHash });
  const sorted = sortLegs(scope.legs);

  console.log(`\n──────── chain ${chainId} ${chainId === 1 ? "(Ethereum)" : "(Base)"} · EntryPoint ${ENTRYPOINT} ────────`);
  console.log("sender (strategy SCA):", userOperation.sender, "| session key (owner):", SESSION_PUBKEY);
  console.log("legs (canonical order):", sorted.map((l) => `${l.token}=${l.cap}`).join("  "));
  console.log("actions              :", session.actions.length, `(M=${sorted.length} caps + Permit2 + UR)`);
  session.actions.forEach((a, i) => console.log(`  [${i}] ${a.actionTargetSelector} @ ${a.actionTarget}`));
  console.log("nonce               :", toHex(userOperation.nonce));
  console.log("callData            :", callData);
  console.log("accountGasLimits    :", packed.accountGasLimits, "(verif<<128 | call)");
  console.log("preVerificationGas  :", toHex(packed.preVerificationGas));
  console.log("gasFees             :", packed.gasFees, "(maxPrio<<128 | maxFee)");
  console.log("paymasterAndData    :", packed.paymasterAndData);
  console.log("permissionId        :", permissionId, "← = keccak(OwnableValidator, initData(sessionKey), salt) — does NOT bind the basket/caps");
  console.log("userOpHash          :", userOpHash);
  console.log("digestToSign        :", digestToSign, "(= hashMessage(userOpHash), EIP-191 — enable path)");
}
console.log("\nStrategy enable = install(SmartSessions)+enableSessions(strategy session, [M Caps, Permit2, UR]). Backend session key = owner (Auth≠Custody). Same /v1/userop/build|submit + verifyEnableUserOp/verify7702 as copy — the copy session is the M=1 case. Legs canonical-sorted by token address (order-independent of user input).");
console.log("\n🔒 SECURITY for Dev-2's verify: permissionId = keccak(OwnableValidator, initData(sessionKey), salt) ONLY — it does NOT encode the basket, caps, router, or window (so it's identical across chains here). The SCOPE lives in the enableSessions ACTIONS inside callData. verifyStrategyEnableUserOp MUST decode the actions and assert: exactly M cap-actions (095ea7b3 on the user's tokens, each SpendingLimits limit == the granted per-token cap), then Permit2.approve(87517c45)+TimeFrame, then UR.execute(3593564c on the canonical UniversalRouter)+TimeFrame, and userOpPolicies == [TimeFrame window]. Do NOT trust the permissionId to bind the grant.");
console.log("USE-mode rebalance buy = the copy UniversalRouter mirror per leg (a separate buy vector when KAN-165 USE lands).");
