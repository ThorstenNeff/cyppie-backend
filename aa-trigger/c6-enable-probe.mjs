// C6 ENABLE-mode-on-first-use DISCOVERY PROBE (PRD-06 / KAN-149), Base Sepolia.
//   AA_ALLOW_TESTNET=1 RUN_SEND=1 node --env-file=../.env c6-enable-probe.mjs
//
// Goal: empirically LOCK the ENABLE-mode-on-first-use convention for a Kernel-7702 follower SCA — i.e. the
// (enableValidatorAddress, owner-signature-form) under which a session NOT yet enabled is enabled-and-used
// ATOMICALLY in the first backend-submitted mirror op, signed by the BACKEND session key (USE part) + the
// owner's OFF-CHAIN enable signature (consent), with no separate owner enableSessions tx.
//
// Methodology = the C3 digest-lock: isolate the unknown (a no-code dummy router → the 2-action no-liquidity
// shape so the mirror = token.approve(dead,0), which lands without funds), sweep candidates, use
// eth_estimateUserOperationGas as the validation ORACLE (the OwnableValidator hard-reverts on a bad sig), send
// the locked one, confirm the receipt + that isSessionEnabled flips true, then a SECOND mirror auto-USEs.
//
// 🔑 Auth ≠ Custody: the session key signs the mirror; the owner only signs (off-chain) the enable consent.
import { createPublicClient, http, encodeFunctionData, parseAbi, encodePacked, encodeAbiParameters, toHex, hexToBytes } from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint07Address, getUserOperationHash, createBundlerClient } from "viem/account-abstraction";
import { to7702KernelSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { createSmartAccountClient } from "permissionless";
import {
  getSmartSessionsValidator, getAccount, getEnableSessionDetails, encodeUseOrEnableSmartSessionSignature,
  getOwnableValidator, getOwnableValidatorSignature, getOwnableValidatorMockSignature, isSessionEnabled, getPermissionId,
  SMART_SESSIONS_ADDRESS,
} from "@rhinestone/module-sdk";
import { buildSession } from "./dist/copySession.js";
import { signDigestLowS, addressFromPrivateKey } from "./dist/sessionKeySigner.js";

const apiKey = process.env.PIMLICO_API_KEY;
if (!apiKey) throw new Error("PIMLICO_API_KEY not set (node --env-file=../.env ...)");
const sponsorshipPolicyId = process.env.PIMLICO_SPONSORSHIP_POLICY_ID ?? "sp_next_micromax";
const bundlerUrl = `https://api.pimlico.io/v2/base-sepolia/rpc?apikey=${apiKey}`;
const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com") });

// Kernel v3.3 ECDSA validator (permissionless KERNEL_V3_3 constant) — a candidate enable-validator.
const KERNEL_ECDSA_VALIDATOR = "0x845ADb2C711129d4f3966735eD98a9F09fC4cE57";
const WETH = "0x4200000000000000000000000000000000000006";
const DUMMY_ROUTER = "0x000000000000000000000000000000000000c0de"; // no code → not in the adapter table → 2-action shape
const SWAP_SELECTOR = "0x5ae401dc";

const owner = privateKeyToAccount(process.env.TEST_PRIVATE_KEY ?? generatePrivateKey());
const sessionPrivBytes = hexToBytes(generatePrivateKey());
const sessionPublicKey = addressFromPrivateKey(sessionPrivBytes);
console.log("follower owner EOA :", owner.address);
console.log("backend session key:", sessionPublicKey);

const account = await to7702KernelSmartAccount({ client, owner, entryPoint: { address: entryPoint07Address, version: "0.7" }, version: "0.3.3" });
const mdAccount = getAccount({ address: account.address, type: "kernel" });
console.log("7702 SCA (== owner):", account.address);

// The scoped session (dummy router → 2-action no-liquidity shape: token.approve cap + dummy swap window).
const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
const scope = {
  chainId: 84532, token: WETH, capTotalBudget: 10n ** 18n, router: DUMMY_ROUTER, selector: SWAP_SELECTOR,
  windowStart: 0, windowEnd: 1893456000, follower: owner.address, source: "0x1111111111111111111111111111111111111111",
};
const session = buildSession(sessionPublicKey, salt, scope);
const permissionId = getPermissionId({ session });
console.log("permissionId:", permissionId, "| actions:", session.actions.length);

const pimlico = createPimlicoClient({ transport: http(bundlerUrl) });
const sac = createSmartAccountClient({
  account, chain: baseSepolia, bundlerTransport: http(bundlerUrl), paymaster: pimlico,
  paymasterContext: { sponsorshipPolicyId },
  userOperation: { estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast },
});
const bundler = createBundlerClient({ chain: baseSepolia, transport: http(bundlerUrl) });

if (process.env.RUN_SEND !== "1") { console.log("\n[probe-only] set RUN_SEND=1 for the on-chain setup + ENABLE-first-use."); process.exit(0); }

// ── 1) SETUP op (owner-signed): 7702-delegate + install SmartSessions module ONLY (NO enableSessions) ──────
const KERNEL_NO_HOOK = "0x0000000000000000000000000000000000000001";
const KERNEL_EXECUTE_SELECTOR = "0xe9ae5c53";
const installModuleData = (moduleInitData) => encodePacked(["address", "bytes"], [KERNEL_NO_HOOK,
  encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes" }], [moduleInitData ?? "0x", "0x", KERNEL_EXECUTE_SELECTOR])]);
const installCall = (module, moduleInitData) => ({ to: account.address, value: 0n,
  data: encodeFunctionData({ abi: parseAbi(["function installModule(uint256 t, address m, bytes d)"]), args: [1n, module, installModuleData(moduleInitData)] }) });
// Install BOTH: (a) the SmartSessions validator (the session-key path), and (b) an OwnableValidator holding the
// OWNER as a real Kernel validator — the ENABLE-mode enable-sig is verified against an INSTALLED validator that
// recognizes the owner; on a 7702 Kernel the root is the EOA sentinel (no module), so the owner OwnableValidator
// is what SmartSession routes the permissionEnableSig to. (It shares the canonical OwnableValidator address with
// the session's sessionValidator, but the session path is stateless/inline initData — no config conflict.)
const ownerValidator = getOwnableValidator({ threshold: 1, owners: [owner.address] });
const authNonce = await client.getTransactionCount({ address: owner.address });
const authorization = await owner.signAuthorization({ contractAddress: account.authorization.address, chainId: baseSepolia.id, nonce: authNonce });
console.log("\n[setup] 7702-delegate + install SmartSessions + OwnableValidator(owner) (NO enableSessions)…");
const setupHash = await sac.sendUserOperation({ calls: [
  installCall(SMART_SESSIONS_ADDRESS, getSmartSessionsValidator({}).initData),
  installCall(ownerValidator.address, ownerValidator.initData),
], authorization });
const setupRcpt = await sac.waitForUserOperationReceipt({ hash: setupHash });
console.log("[setup] RECEIPT tx:", setupRcpt.receipt.transactionHash, "| success:", setupRcpt.success);
if (!setupRcpt.success) throw new Error("setup (install) reverted");
// Wait for the 7702 delegation code (0xef0100…) to PROPAGATE to the public RPC. If a later prepare sees no
// code (RPC lag) it re-attaches a 7702 authorization → re-delegation re-inits Kernel → WIPES the just-installed
// SmartSessions module → InvalidValidator(0x682a6e7c). Poll until the designator is visible.
let code = "0x";
for (let i = 0; i < 15 && !code.toLowerCase().startsWith("0xef0100"); i++) { code = (await client.getCode({ address: account.address })) ?? "0x"; if (!code.toLowerCase().startsWith("0xef0100")) await new Promise((r) => setTimeout(r, 2000)); }
console.log("[setup] account code:", code.slice(0, 12), code.toLowerCase().startsWith("0xef0100") ? "(7702-delegated ✓)" : "(NOT delegated ✗)");
const enabledAfterSetup = await isSessionEnabled({ client, account: mdAccount, permissionId }).catch(() => false);
console.log("[setup] isSessionEnabled (expect false):", enabledAfterSetup);

// ── 2) Build enable details + the validator-nonce route to the Smart Sessions validator (vtype=0x01) ───────
const validatorKey = BigInt(encodePacked(["bytes1", "bytes1", "address", "bytes2"], ["0x00", "0x01", SMART_SESSIONS_ADDRESS, "0x0000"]));
const nonce = await client.readContract({
  address: entryPoint07Address, functionName: "getNonce",
  abi: [{ type: "function", name: "getNonce", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint192" }], outputs: [{ type: "uint256" }] }],
  args: [account.address, validatorKey],
});

// The mirror op for the proof = the cap action (token.approve(dead, 0)) — succeeds with no liquidity.
const mirrorCall = { to: WETH, value: 0n, data: encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), args: ["0x000000000000000000000000000000000000dEaD", 0n] }) };

// Candidate matrix: (enableValidatorAddress) × (owner signature form over permissionEnableHash).
const validatorCandidates = [
  ["OwnableValidator(owner) installed", ownerValidator.address],
  ["ECDSA_VALIDATOR", KERNEL_ECDSA_VALIDATOR],
];
const ownerSigForms = {
  "raw ecrecover (owner.sign hash)": async (h) => owner.sign({ hash: h }),
  "EIP-191 (owner.signMessage raw)": async (h) => owner.signMessage({ message: { raw: h } }),
};

let locked = null;
outer:
for (const [vLabel, enableValidatorAddress] of validatorCandidates) {
  // enable details (reads sessionNonce=0 + sessionDigest from chain); rebuilt per validator candidate.
  const details = await getEnableSessionDetails({ sessions: [session], account: mdAccount, clients: [client], enableValidatorAddress });
  console.log(`[probe] (${vLabel}) permissionEnableHash:`, details.permissionEnableHash);
  for (const [sLabel, signHash] of Object.entries(ownerSigForms)) {
    const permissionEnableSig = await signHash(details.permissionEnableHash);
    const enableSessionData = { ...details.enableSessionData, enableSession: { ...details.enableSessionData.enableSession, permissionEnableSig } };

    // Prepare a sponsored op with an ENABLE-shaped STUB (mock session sig) + explicit generous gas (skip the
    // mock-sig estimation the session-validator hard-reverts). Then sign the REAL session sig over the op hash.
    const stub = await encodeUseOrEnableSmartSessionSignature({ account: mdAccount, client, permissionId, signature: getOwnableValidatorMockSignature({ threshold: 1 }), enableSessionData });
    let op;
    try {
      op = await sac.prepareUserOperation({
        calls: [mirrorCall], nonce,
        callGasLimit: 700_000n, verificationGasLimit: 2_000_000n, preVerificationGas: 300_000n,
        paymasterVerificationGasLimit: 500_000n, paymasterPostOpGasLimit: 100_000n, signature: stub,
      });
      delete op.authorization; delete op.eip7702Auth; // already delegated — never re-delegate (would wipe modules)
    } catch (e) {
      console.log(`[probe] prepare failed (${vLabel} / ${sLabel}):`, oneLine(e)); continue;
    }
    const userOpHash = getUserOperationHash({ userOperation: op, entryPointAddress: entryPoint07Address, entryPointVersion: "0.7", chainId: baseSepolia.id });
    const sessionSig = signDigestLowS(sessionPrivBytes, hexToBytes(userOpHash)); // C3 lock: RAW userOpHash
    const ownableSig = getOwnableValidatorSignature({ signatures: [sessionSig] });
    const useOrEnableSig = await encodeUseOrEnableSmartSessionSignature({ account: mdAccount, client, permissionId, signature: ownableSig, enableSessionData });
    try {
      await bundler.request({ method: "eth_estimateUserOperationGas", params: [{ ...serialize(op), signature: useOrEnableSig }, entryPoint07Address] });
      console.log(`[probe] ✅ ENABLE-mode VALIDATED -> validator="${vLabel}" ownerSig="${sLabel}"`);
      locked = { vLabel, sLabel, op, useOrEnableSig }; break outer;
    } catch (e) {
      const d = String(e.details ?? e.cause?.details ?? e.cause?.cause?.details ?? e.shortMessage ?? e.message ?? e);
      const m = d.match(/0x3ca8ef0c([0-9a-f]{64})([0-9a-f]{64})/i);
      if (m) console.log(`[probe] ✗ ${vLabel} / ${sLabel}: InvalidEnableSignature(account=0x${m[1].slice(24)}, hash=0x${m[2]})  [signed=${details.permissionEnableHash}]`);
      else console.log(`[probe] ✗ ${vLabel} / ${sLabel}: ${oneLine(e)}`);
    }
  }
}
if (!locked) throw new Error("no ENABLE-mode candidate validated — convention undetermined");

// ── 3) SEND the locked ENABLE-first-use mirror → receipt; confirm the session got enabled atomically ──────
locked.op.signature = locked.useOrEnableSig;
const m1 = await bundler.sendUserOperation({ ...locked.op, entryPointAddress: entryPoint07Address });
const m1r = await bundler.waitForUserOperationReceipt({ hash: m1 });
console.log("\n[mirror1 ENABLE] RECEIPT tx:", m1r.receipt.transactionHash, "| success:", m1r.success, "| block:", m1r.receipt.blockNumber);
if (!m1r.success) throw new Error("ENABLE-first-use mirror reverted");
let enabledNow = false;
for (let i = 0; i < 10 && !enabledNow; i++) { enabledNow = await isSessionEnabled({ client, account: mdAccount, permissionId }); if (!enabledNow) await new Promise((r) => setTimeout(r, 3000)); }
console.log("[mirror1] isSessionEnabled (expect true after ENABLE):", enabledNow);

// ── 4) SECOND mirror: encodeUseOrEnable now sees the session enabled → auto-USE → receipt ─────────────────
const nonce2 = await client.readContract({ address: entryPoint07Address, functionName: "getNonce",
  abi: [{ type: "function", name: "getNonce", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint192" }], outputs: [{ type: "uint256" }] }], args: [account.address, validatorKey] });
const op2 = await sac.prepareUserOperation({ calls: [mirrorCall], nonce: nonce2,
  callGasLimit: 700_000n, verificationGasLimit: 2_000_000n, preVerificationGas: 300_000n,
  paymasterVerificationGasLimit: 500_000n, paymasterPostOpGasLimit: 100_000n,
  signature: encodeUseOrEnableSmartSessionSignatureSyncUseStub(permissionId) });
delete op2.authorization; delete op2.eip7702Auth;
const h2 = getUserOperationHash({ userOperation: op2, entryPointAddress: entryPoint07Address, entryPointVersion: "0.7", chainId: baseSepolia.id });
const ownable2 = getOwnableValidatorSignature({ signatures: [signDigestLowS(sessionPrivBytes, hexToBytes(h2))] });
op2.signature = await encodeUseOrEnableSmartSessionSignature({ account: mdAccount, client, permissionId, signature: ownable2, enableSessionData: { enableSession: { chainDigestIndex: 0, hashesAndChainIds: [], sessionToEnable: session, permissionEnableSig: "0x" }, validator: session.sessionValidator, accountType: "kernel" } });
const m2 = await bundler.sendUserOperation({ ...op2, entryPointAddress: entryPoint07Address });
const m2r = await bundler.waitForUserOperationReceipt({ hash: m2 });
console.log("[mirror2 USE]    RECEIPT tx:", m2r.receipt.transactionHash, "| success:", m2r.success);

console.log("\n================ C6 ENABLE-mode-on-first-use LOCK ================");
console.log("enable-validator     :", locked.vLabel);
console.log("owner enable-sig form:", locked.sLabel);
console.log("setup (install) tx   :", setupRcpt.receipt.transactionHash);
console.log("mirror1 ENABLE tx    :", m1r.receipt.transactionHash, "| success:", m1r.success);
console.log("mirror2 USE tx       :", m2r.receipt.transactionHash, "| success:", m2r.success);
console.log("=================================================================");

function serialize(op) { const out = {}; for (const [k, v] of Object.entries(op)) { if (k === "signature" || k === "authorization" || k === "eip7702Auth") continue; out[k] = typeof v === "bigint" ? toHex(v) : v; } return out; }
function oneLine(e) { const d = e.details ?? e.cause?.details ?? e.cause?.cause?.details ?? e.shortMessage ?? e.cause?.shortMessage ?? String(e.message ?? e); return String(d).split("\n")[0].slice(0, 160); }
// USE stub for the already-enabled path (mode 0x00 ‖ permissionId ‖ mockOwnableSig).
function encodeUseOrEnableSmartSessionSignatureSyncUseStub(pid) { return encodePacked(["bytes1", "bytes32", "bytes"], ["0x00", pid, getOwnableValidatorMockSignature({ threshold: 1 })]); }
