// C3 money-gate (PRD-06 / KAN-149) — the Copy-Trading USE-mode-Sign-LOCK, Base Sepolia.
//
//   AA_ALLOW_TESTNET=1 node --env-file=../.env c3-usemode-lock.mjs            -> LOCK only (no spend)
//   AA_ALLOW_TESTNET=1 RUN_SEND=1 node --env-file=../.env c3-usemode-lock.mjs -> + on-chain mirror receipt
//
// Proves the money-path: a BACKEND-HELD scoped session key (the copy signer) signs a USE-mode mirror UserOp
// through a Smart Session (OwnableValidator session-validator) and lands a real sponsored receipt — exactly
// like the DCA Inc.3 proof, but for the session-key path. Empirically LOCKS which 32-byte digest the
// OwnableValidator session-validator recovers from (raw userOpHash vs EIP-191 hashMessage(userOpHash)).
//
// 🔑 Auth ≠ Custody: the session key is the ONLY signer here — never the owner/main key. The session is
// scoped (router+selector) + capped (SpendingLimits) + time-boxed (TimeFrame) on-chain.
import { createPublicClient, http, encodeFunctionData, parseAbi, hashMessage, toHex, encodePacked, encodeAbiParameters } from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint07Address, getUserOperationHash, createBundlerClient } from "viem/account-abstraction";
import { to7702KernelSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { createSmartAccountClient } from "permissionless";
import {
  getOwnableValidator, getSpendingLimitsPolicy, getTimeFramePolicy, getSudoPolicy,
  getSmartSessionsValidator, getPermissionId, getOwnableValidatorSignature, getOwnableValidatorMockSignature,
  encodeSmartSessionSignature, encodeModuleInstallationData, encodeValidatorNonce, isSessionEnabled,
  getEnableSessionsAction, getAccount, SMART_SESSIONS_ADDRESS, SmartSessionMode,
} from "@rhinestone/module-sdk";
import { hexToBytes } from "viem";
// Production signer core (C1) — the EXACT byte path the KeychainSessionKeySigner uses (EIP-2 low-S).
import { signDigestLowS, addressFromPrivateKey } from "./dist/sessionKeySigner.js";

const apiKey = process.env.PIMLICO_API_KEY;
if (!apiKey) throw new Error("PIMLICO_API_KEY not set (node --env-file=../.env ...)");
const sponsorshipPolicyId = process.env.PIMLICO_SPONSORSHIP_POLICY_ID ?? "sp_next_micromax";
const bundlerUrl = `https://api.pimlico.io/v2/base-sepolia/rpc?apikey=${apiKey}`;
const publicRpc = process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com";
const client = createPublicClient({ chain: baseSepolia, transport: http(publicRpc) });

// ── 1) Fresh follower owner EOA + fresh BACKEND session key (the copy signer) ───────────────────────────
const owner = privateKeyToAccount(process.env.TEST_PRIVATE_KEY ?? generatePrivateKey());
const sessionPrivBytes = hexToBytes(generatePrivateKey());
const sessionPublicKey = addressFromPrivateKey(sessionPrivBytes);
console.log("follower owner EOA :", owner.address);
console.log("backend session key:", sessionPublicKey, "(scoped/capped/revocable — NOT the main key)");

// ── 2) Kernel 7702 account (== owner address) ──────────────────────────────────────────────────────────
const account = await to7702KernelSmartAccount({
  client, owner, entryPoint: { address: entryPoint07Address, version: "0.7" }, version: "0.3.3",
});
console.log("7702 SCA (== owner):", account.address, "| kernel impl:", account.authorization.address);

// ── 3) The scoped copy session (OwnableValidator owner = backend session key) ───────────────────────────
// Scoped action for the proof = WETH.deposit() (canonical OP-stack predeploy on Base Sepolia, succeeds with
// value 0). C4/C6 swap this for the real Uniswap Universal Router selector (Q-C). The cap/window policies
// are present in the enable digest either way.
const WETH = "0x4200000000000000000000000000000000000006";
const DEPOSIT_SELECTOR = "0xd0e30db0"; // deposit()
const ov = getOwnableValidator({ threshold: 1, owners: [sessionPublicKey] });
const sudo = getSudoPolicy();
const spend = getSpendingLimitsPolicy([{ token: WETH, limit: 10n * 10n ** 18n }]); // cap = total budget (N3)
const time = getTimeFramePolicy({ validAfter: 0, validUntil: 1893456000 }); // wide window for the proof
const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));

// POLICY layout — the on-chain truth (C3 finding): SpendingLimitsPolicy implements only IActionPolicy, so it
// is rejected in the userOpPolicies slot (UnsupportedPolicy). Two layouts:
//   POLICY=sudo (default) — Sudo userOp + Sudo action: guaranteed-valid, isolates the digest-LOCK proof.
//   POLICY=prod           — the corrected copy-trading scope: TimeFrame as userOp policy, SpendingLimits as
//                           ACTION policy (the spend cap belongs on the scoped router action).
const POLICY = process.env.POLICY ?? "sudo";
// The scoped action for the proof. sudo → WETH.deposit() (any call succeeds under Sudo). prod → WETH.transfer
// (the selector SpendingLimits parses): transfer(dead, 0) — amount 0 ≤ cap, so the spend policy PASSES and the
// ERC-20 transfer of 0 succeeds. C4/C6 swap this for the real Uniswap Universal Router selector (Q-C).
const TRANSFER_SELECTOR = "0xa9059cbb"; // transfer(address,uint256)
const APPROVE_SELECTOR = "0x095ea7b3"; // approve(address,uint256) — the DCA spend cap sits here
const action = POLICY === "prod"
  ? { selector: TRANSFER_SELECTOR, callData: encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256)"]), args: ["0x000000000000000000000000000000000000dEaD", 0n] }) }
  : POLICY === "dca"
  ? { selector: APPROVE_SELECTOR, callData: encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), args: ["0x000000000000000000000000000000000000dEaD", 0n] }) }
  : { selector: DEPOSIT_SELECTOR, callData: DEPOSIT_SELECTOR };
// Policy layouts:
//   sudo → Sudo userOp + Sudo action (isolates the digest-lock).
//   prod → TimeFrame userOp + SpendingLimits on the token transfer action.
//   dca  → the corrected DCA enable shape (Vector D): TimeFrame userOp + TWO actions — SpendingLimits on the
//          token APPROVE (the cap) + a TimeFrame-boxed router swap action (op2 exercises the approve action).
const DUMMY_ROUTER = "0x000000000000000000000000000000000000c0de";
const SWAP_SELECTOR = "0x5ae401dc";
const layout = POLICY === "dca"
  ? {
      userOpPolicies: [{ policy: time.policy, initData: time.initData }],
      actions: [
        { actionTargetSelector: action.selector, actionTarget: WETH, actionPolicies: [{ policy: spend.policy, initData: spend.initData }] }, // cap on approve
        { actionTargetSelector: SWAP_SELECTOR, actionTarget: DUMMY_ROUTER, actionPolicies: [{ policy: time.policy, initData: time.initData }] }, // swap, time-boxed
      ],
    }
  : POLICY === "prod"
  ? {
      userOpPolicies: [{ policy: time.policy, initData: time.initData }],
      actions: [{ actionTargetSelector: action.selector, actionTarget: WETH, actionPolicies: [{ policy: spend.policy, initData: spend.initData }] }],
    }
  : {
      userOpPolicies: [{ policy: sudo.policy, initData: sudo.initData }],
      actions: [{ actionTargetSelector: action.selector, actionTarget: WETH, actionPolicies: [{ policy: sudo.policy, initData: sudo.initData }] }],
    };
console.log("POLICY layout:", POLICY);
const session = {
  sessionValidator: ov.address,
  sessionValidatorInitData: ov.initData,
  salt,
  userOpPolicies: layout.userOpPolicies,
  erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] },
  actions: layout.actions,
  permitERC4337Paymaster: true,
  chainId: BigInt(baseSepolia.id),
};
const permissionId = getPermissionId({ session });
console.log("permissionId:", permissionId, "| sessionValidator:", ov.address);

const pimlico = createPimlicoClient({ transport: http(bundlerUrl) });
const sac = createSmartAccountClient({
  account, chain: baseSepolia, bundlerTransport: http(bundlerUrl),
  paymaster: pimlico,
  paymasterContext: { sponsorshipPolicyId },
  userOperation: { estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast },
});
const bundler = createBundlerClient({ chain: baseSepolia, transport: http(bundlerUrl) });

if (process.env.RUN_SEND !== "1") {
  console.log("\n[LOCK-only] set RUN_SEND=1 for the on-chain enable + mirror receipt.");
  process.exit(0);
}

// ── 4) Op 1 (OWNER-signed): 7702-delegate + install Smart Sessions + enable the scoped session ───────────
// Batched self-calls (install runs before enable). Install initData is encoded manually (module-sdk's
// installModule does an on-chain read that fails on a not-yet-deployed 7702 account). The session is enabled
// via a direct owner-authorized enableSessions call — equivalent, for the on-chain USE-mode LOCK, to the
// production ENABLE-mode (owner-signed enable carried in the first op's signature); op2's session-key path is
// identical either way.
// Kernel v3.3 validator install initData = abi.encodePacked(hook, abi.encode(validatorData, hookData,
// selectorData)) — THREE fields. module-sdk's encodeModuleInstallationData emits the Kernel-3.0 TWO-field
// layout (validatorData, hookData), which sets the ValidationConfig wrong → Kernel treats the validator as
// not-installed at validation (InvalidValidator 0x682a6e7c). hook = address(1) is Kernel's "no-hook" sentinel.
const KERNEL_NO_HOOK = "0x0000000000000000000000000000000000000001";
const ssValidator = getSmartSessionsValidator({}); // install the module (no sessions in initData)
const mdAccount = getAccount({ address: account.address, type: "kernel" });
// selectorData grants the validator permission to validate ops calling Kernel's execute selector
// (0xe9ae5c53) — without it Kernel rejects the validator for that selector (InvalidValidator).
const KERNEL_EXECUTE_SELECTOR = "0xe9ae5c53";
const installData = encodePacked(
  ["address", "bytes"],
  [KERNEL_NO_HOOK, encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes" }], [ssValidator.initData ?? "0x", "0x", KERNEL_EXECUTE_SELECTOR])],
);
const installCallData = encodeFunctionData({
  abi: parseAbi(["function installModule(uint256 moduleType, address module, bytes initData)"]),
  args: [1n, SMART_SESSIONS_ADDRESS, installData], // moduleType 1 = validator
});
const enableAction = getEnableSessionsAction({ sessions: [session] });
const authNonce = await client.getTransactionCount({ address: owner.address });
const authorization = await owner.signAuthorization({ contractAddress: account.authorization.address, chainId: baseSepolia.id, nonce: authNonce });
console.log("\n[op1] install Smart Sessions + enableSessions — owner-signed, delegate ->", account.authorization.address);
const op1Hash = await sac.sendUserOperation({
  calls: [
    { to: account.address, value: 0n, data: installCallData },
    { to: enableAction.to, value: 0n, data: enableAction.callData },
  ],
  authorization,
});
const op1Rcpt = await sac.waitForUserOperationReceipt({ hash: op1Hash });
console.log("[op1] RECEIPT tx:", op1Rcpt.receipt.transactionHash, "| success:", op1Rcpt.success);
if (!op1Rcpt.success) throw new Error("op1 (install/enable) reverted");

// Poll isSessionEnabled (the public RPC can lag the bundler's mined block). Don't hard-fail on a stale read —
// op2's bundler simulation is the real judge against latest on-chain state.
let enabled = false;
for (let i = 0; i < 10 && !enabled; i++) {
  enabled = await isSessionEnabled({ client, account: mdAccount, permissionId });
  if (!enabled) await new Promise((r) => setTimeout(r, 3000));
}
console.log("[op1] isSessionEnabled:", enabled, enabled ? "" : "(stale read tolerated — op2 sim is the judge)");

// ── 5) Op 2 (SESSION-KEY-signed, USE-mode): the empirical DIGEST-LOCK + mirror receipt ──────────────────
// The OwnableValidator session-validator HARD-REVERTS on a non-matching signature (InvalidSignature 0x8baa579f),
// so the usual mock-signature gas estimation is unusable. Instead: fixed generous gas limits (sponsored — over-
// estimation is free), build the op fully, sign the REAL session-key signature over that exact op, and use
// eth_estimateUserOperationGas purely as a validation ORACLE to pick the digest convention. Then send verbatim.
// Route to the Smart Sessions validator via the Kernel v3 validator-nonce KEY (uint192):
//   [1B mode=0x00 DEFAULT][1B vtype=0x01 VALIDATOR][20B validator][2B nonceKey=0x0000]
// NOTE 1: permissionless's to7702KernelSmartAccount.getNonce({key}) ignores the key, so we read the
// EntryPoint directly. NOTE 2: module-sdk's encodeValidatorNonce emits vtype=0x00 (SUDO/root) for this
// Kernel version — wrong; Kernel then ignores the embedded validator and routes to the root ECDSA validator,
// which reverts InvalidSignature (0x8baa579f) on the 98-byte smart-session signature. vtype MUST be 0x01.
const validatorKey = BigInt(encodePacked(
  ["bytes1", "bytes1", "address", "bytes2"],
  ["0x00", "0x01", SMART_SESSIONS_ADDRESS, "0x0000"],
));
const nonce = await client.readContract({
  address: entryPoint07Address,
  abi: [{ type: "function", name: "getNonce", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint192" }], outputs: [{ type: "uint256" }] }],
  functionName: "getNonce",
  args: [account.address, validatorKey],
});
console.log("[op2] validator-nonce key:", toHex(validatorKey, { size: 24 }), "| nonce:", toHex(nonce, { size: 32 }));
// Build the sponsored op via permissionless's working prepare path, but pass EXPLICIT generous gas so it
// SKIPS the mock-signature gas estimation (which the session-validator hard-reverts). prepareUserOperation
// fills the sponsored paymaster data (op1's proven path) without signing; we sign the real session sig after.
const useStub = encodeSmartSessionSignature({ mode: SmartSessionMode.USE, permissionId, signature: getOwnableValidatorMockSignature({ threshold: 1 }) });
const op = await sac.prepareUserOperation({
  calls: [{ to: WETH, value: 0n, data: action.callData }], // the scoped action
  nonce,
  callGasLimit: 600_000n, verificationGasLimit: 1_500_000n, preVerificationGas: 200_000n,
  paymasterVerificationGasLimit: 400_000n, paymasterPostOpGasLimit: 100_000n,
  signature: useStub,
});
const userOpHash = getUserOperationHash({ userOperation: op, entryPointAddress: entryPoint07Address, entryPointVersion: "0.7", chainId: baseSepolia.id });
console.log("\n[op2] userOpHash:", userOpHash);

// The empirical LOCK: try each candidate digest; the one the session-validator accepts is the lock.
const candidates = {
  "raw userOpHash": userOpHash,
  "EIP-191 hashMessage(userOpHash)": hashMessage({ raw: userOpHash }),
};
let locked = null;
for (const [label, digest] of Object.entries(candidates)) {
  const sessionSig = signDigestLowS(sessionPrivBytes, hexToBytes(digest)); // C1 production core, EIP-2 low-S
  const ownableSig = getOwnableValidatorSignature({ signatures: [sessionSig] });
  const userOpSignature = encodeSmartSessionSignature({ mode: SmartSessionMode.USE, permissionId, signature: ownableSig });
  try {
    await bundler.request({
      method: "eth_estimateUserOperationGas",
      params: [{ ...serialize(op), signature: userOpSignature }, entryPoint07Address],
    });
    console.log(`[op2] DIGEST-LOCK candidate ACCEPTED by validation -> "${label}"`);
    locked = { label, digest, userOpSignature };
    break;
  } catch (e) {
    const detail = e.details ?? e.cause?.details ?? e.cause?.cause?.details ?? e.shortMessage ?? e.cause?.shortMessage ?? String(e.message ?? e);
    console.log(`[op2] candidate rejected: "${label}" -> ${String(detail).split("\n")[0].slice(0, 160)}`);
  }
}
if (!locked) throw new Error("no digest candidate validated — LOCK undetermined");

// The prepared op already carries valid sponsored paymaster data (gas is fixed/explicit). Send it verbatim
// with the locked session signature.
op.signature = locked.userOpSignature;
const op2Hash = await bundler.sendUserOperation({ ...op, entryPointAddress: entryPoint07Address });
console.log("[op2] submitted userOpHash:", op2Hash);
const op2Rcpt = await bundler.waitForUserOperationReceipt({ hash: op2Hash });
console.log("[op2] MIRROR RECEIPT tx:", op2Rcpt.receipt.transactionHash, "| success:", op2Rcpt.success, "| block:", op2Rcpt.receipt.blockNumber);

console.log("\n================ C3 USE-mode-LOCK ================");
console.log("session-validator digest LOCK :", locked.label);
console.log("op1 (install+enable) tx        :", op1Rcpt.receipt.transactionHash);
console.log("op2 (session-signed mirror) tx :", op2Rcpt.receipt.transactionHash, "| success:", op2Rcpt.success);
console.log("=================================================");

// Serialize a prepared op to the JSON-RPC shape (bigints -> hex) for eth_estimateUserOperationGas.
function serialize(op) {
  const out = {};
  for (const [k, v] of Object.entries(op)) {
    if (k === "signature") continue;
    out[k] = typeof v === "bigint" ? toHex(v) : v;
  }
  return out;
}
