// C2 verification (KAN-149): assembleEnableInputs produces a byte-exact, app-reproducible ENABLE digest,
// and the registry prepare->grant->signer lifecycle round-trips. Run: node copysession.test.mjs
import { hashChainSessions } from "@rhinestone/module-sdk";
import { hashTypedData, hashMessage, recoverAddress, slice } from "viem";
import { rmSync } from "node:fs";
import { assembleEnableInputs, CopySessionRegistry, GateError, buildUseModeUserOpSignature, smartSessionUseModeNonceKey } from "./dist/copySession.js";
import { InMemorySessionKeySigner } from "./dist/sessionKeySigner.js";

let fails = 0;
const ok = (c, m) => { if (c) console.log("  ✓", m); else { console.log("  ✗", m); fails++; } };

// EIP-712 type table (must match :evm SmartSessionEnableDigest + the spec §1) for the raw-viem cross-check.
const TYPES = {
  PolicyData: [{ name: "policy", type: "address" }, { name: "initData", type: "bytes" }],
  ActionData: [{ name: "actionTargetSelector", type: "bytes4" }, { name: "actionTarget", type: "address" }, { name: "actionPolicies", type: "PolicyData[]" }],
  ERC7739Context: [{ name: "appDomainSeparator", type: "bytes32" }, { name: "contentName", type: "string[]" }],
  ERC7739Data: [{ name: "allowedERC7739Content", type: "ERC7739Context[]" }, { name: "erc1271Policies", type: "PolicyData[]" }],
  SignedPermissions: [
    { name: "permitGenericPolicy", type: "bool" }, { name: "permitAdminAccess", type: "bool" },
    { name: "ignoreSecurityAttestations", type: "bool" }, { name: "permitERC4337Paymaster", type: "bool" },
    { name: "userOpPolicies", type: "PolicyData[]" }, { name: "erc7739Policies", type: "ERC7739Data" }, { name: "actions", type: "ActionData[]" },
  ],
  SignedSession: [
    { name: "account", type: "address" }, { name: "permissions", type: "SignedPermissions" },
    { name: "sessionValidator", type: "address" }, { name: "sessionValidatorInitData", type: "bytes" },
    { name: "salt", type: "bytes32" }, { name: "smartSession", type: "address" }, { name: "nonce", type: "uint256" },
  ],
  ChainSession: [{ name: "chainId", type: "uint64" }, { name: "session", type: "SignedSession" }],
  MultiChainSession: [{ name: "sessionsAndChainIds", type: "ChainSession[]" }],
};

const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // follower SCA (= owner EOA)
const SESSION_PUBKEY = "0x489ccacAC8836C71Ad5B20Bf61e0b885425b227e"; // a backend session key (example)
const SALT = "0x00000000000000000000000000000000000000000000000000000000000000aa";
const scope = {
  chainId: 8453, token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", capTotalBudget: 1000000n,
  router: "0x6fF5693b99212Da76ad316178A184AB56D299b43", selector: "0x3593564c",
  windowStart: 0, windowEnd: 1893456000, follower: OWNER, source: "0x1111111111111111111111111111111111111111",
};

console.log("C2: assembleEnableInputs -> byte-exact, app-reproducible ENABLE digest");
const inputs = assembleEnableInputs(SESSION_PUBKEY, SALT, scope);
ok(inputs.permitERC4337Paymaster === true, "permitERC4337Paymaster=true (sponsored, N3/MED-2)");
ok(inputs.sessionValidator.toLowerCase() === "0x000000000013fdb5234e4e3162a810f54d9f7e98", "sessionValidator = OwnableValidator (GLOBAL_CONSTANTS)");
// C3 policy placement (on-chain finding): TimeFrame in userOpPolicies (IUserOpPolicy); SpendingLimits is an
// IActionPolicy that parses an ERC-20 transfer/approve → the cap sits on the spend-TOKEN's approve action, and
// the router swap is a SEPARATE time-boxed action. SpendingLimits in userOpPolicies / on the router reverts.
ok(inputs.userOpPolicies[0].policy.toLowerCase() === "0x0000000000d30f611fa3bf652ac6879428586930", "TimeFrame = userOp policy (GLOBAL_CONSTANTS)");
ok(inputs.actions.length === 2, "two actions: [token.approve cap, router.swap window]");
ok(inputs.actions[0].actionTargetSelector === "0x095ea7b3" && inputs.actions[0].actionTarget.toLowerCase() === scope.token.toLowerCase(), "cap action = approve on the spend token");
ok(inputs.actions[0].actionPolicies[0].policy.toLowerCase() === "0x000000000033212e272655d8a22402db819477a6", "SpendingLimits = the cap action policy (GLOBAL_CONSTANTS)");
ok(inputs.actions[1].actionTarget.toLowerCase() === scope.router.toLowerCase() && inputs.actions[1].actionTargetSelector === scope.selector, "swap action = the copy router/selector");
ok(inputs.actions[1].actionPolicies[0].policy.toLowerCase() === "0x0000000000d30f611fa3bf652ac6879428586930", "TimeFrame = the swap action window");

// Build the full SignedSession the app would build (owner + nonce) and recompute both ways.
const signedSession = {
  account: OWNER,
  permissions: {
    permitGenericPolicy: false, permitAdminAccess: false, ignoreSecurityAttestations: false,
    permitERC4337Paymaster: true, userOpPolicies: inputs.userOpPolicies,
    erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] }, actions: inputs.actions,
  },
  sessionValidator: inputs.sessionValidator, sessionValidatorInitData: inputs.sessionValidatorInitData,
  salt: SALT, smartSession: inputs.smartSession, nonce: 0n,
};
const chainSessions = [{ chainId: BigInt(scope.chainId), session: signedSession }];
const sdkDigest = hashChainSessions(chainSessions);
const rawDigest = hashTypedData({ domain: { name: "SmartSession", version: "1" }, types: TYPES, primaryType: "MultiChainSession", message: { sessionsAndChainIds: chainSessions } });
ok(sdkDigest === rawDigest, `enable digest SDK==raw-viem (app-reproducible): ${sdkDigest.slice(0, 18)}…`);

console.log("C2: registry prepare -> grant -> signer lifecycle (host Keychain)");
const path = "./copy-sessions.test.json";
rmSync(path, { force: true });
let reg = new CopySessionRegistry(path);
const prepared = reg.prepare(scope);
ok(prepared.permissionId && prepared.sessionPublicKey, "prepare returns permissionId + sessionPublicKey");
const rec = reg.get(prepared.permissionId);
ok(rec?.status === "prepared", "record persisted as 'prepared'");
ok(rec?.permissionId === prepared.permissionId, "record permissionId matches assembled inputs");
// reload from disk -> persistence works
reg = new CopySessionRegistry(path);
ok(reg.get(prepared.permissionId)?.sessionPublicKey === prepared.sessionPublicKey, "registry persists across reload");
const granted = reg.grant(prepared.permissionId, "0xdeadbeef");
ok(granted.status === "granted" && reg.get(prepared.permissionId)?.enableSignature === "0xdeadbeef", "grant -> status granted + enableSig stored");
const signer = reg.signerFor(prepared.permissionId);
ok(signer.publicKeyAddress().toLowerCase() === prepared.sessionPublicKey.toLowerCase(), "signerFor resolves the session key (address matches)");
console.log("C4: SubmitGate — kill-switch + Q7 exposure + idempotency (deterministic, no network)");
{
  const expectGate = (fn, m) => { try { fn(); ok(false, m); } catch (e) { ok(e instanceof GateError, `${m}: ${e.message}`); } };
  const pid = prepared.permissionId; // 'granted' from the lifecycle test above; cap = scope.capTotalBudget (1_000_000)
  ok(reg.assertMirrorable(pid, 400000n, "0xsrcA").permissionId === pid, "granted+unpaused+under-cap → mirrorable");
  reg.recordMirror(pid, 400000n, "0xsrcA");
  ok(BigInt(reg.get(pid).spentTotal) === 400000n, "Q7 spentTotal accrues");
  expectGate(() => reg.assertMirrorable(pid, 1n, "0xsrcA"), "idempotency: duplicate source tx rejected");
  reg.setPaused(pid, true);
  expectGate(() => reg.assertMirrorable(pid, 1n, "0xsrcB"), "kill-switch: paused rejected");
  reg.setPaused(pid, false);
  expectGate(() => reg.assertMirrorable(pid, 700000n, "0xsrcC"), "Q7: exposure over cap rejected (400k+700k > 1M)");
  ok(reg.assertMirrorable(pid, 600000n, "0xsrcC").permissionId === pid, "Q7: exactly to the cap is allowed (400k+600k = 1M)");
  reg.revoke(pid);
  expectGate(() => reg.assertMirrorable(pid, 1n, "0xsrcD"), "revoked: rejected");
}

console.log("C3: USE-mode DIGEST-LOCK — session signs the RAW userOpHash (proven on Base Sepolia)");
{
  const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const signer = new InMemorySessionKeySigner(PK);
  const sessionAddr = signer.publicKeyAddress();
  const userOpHash = "0x9f66fd0bba0e39f732f3e21db75850a54dab147af9234bb4db18bf39be8f1a9f";
  const permissionId = "0x33b06a752791815d0741a21d63a9c77d388fc51e088bd127b3c95d91d0efb981";
  const sig = await buildUseModeUserOpSignature(signer, userOpHash, permissionId);
  ok(slice(sig, 0, 1) === "0x00", "USE-mode byte = 0x00");
  ok(slice(sig, 1, 33).toLowerCase() === permissionId.toLowerCase(), "permissionId packed after the mode byte");
  const ownableSig = slice(sig, 33); // threshold-1 → the single 65-byte session sig
  ok((ownableSig.length - 2) / 2 === 65, "inner OwnableValidator sig = 65 bytes");
  const recRaw = await recoverAddress({ hash: userOpHash, signature: ownableSig });
  ok(recRaw.toLowerCase() === sessionAddr.toLowerCase(), "inner sig recovers the session key over the RAW userOpHash (the lock)");
  const recEip191 = await recoverAddress({ hash: hashMessage({ raw: userOpHash }), signature: ownableSig });
  ok(recEip191.toLowerCase() !== sessionAddr.toLowerCase(), "NOT the EIP-191 form (the DCA root-validator digest) — distinct from copy USE-mode");
}

console.log("C3: Kernel USE-mode validator-nonce key routes to the Smart Sessions validator (vtype=0x01)");
{
  const key = smartSessionUseModeNonceKey();
  // [1B mode 0x00][1B vtype 0x01][20B SmartSessions 0x00000000008bDABA…4bDA][2B nonceKey]
  const hex = "0x" + key.toString(16).padStart(48, "0");
  ok(hex.toLowerCase() === "0x000100000000008bdaba73cd9815d79069c247eb4bda0000", `nonce key = ${hex} (vtype=0x01 VALIDATOR + SmartSessions)`);
}

// cleanup: keychain item + temp file
import("node:child_process").then(({ execFileSync }) => {
  try { execFileSync("security", ["delete-generic-password", "-s", "cyppie-copy-session", "-a", reg.get(prepared.permissionId).keychainAccount]); } catch {}
  rmSync(path, { force: true });
  console.log(fails === 0 ? "\nALL PASS ✓" : `\n${fails} FAILED ✗`);
  process.exit(fails === 0 ? 0 : 1);
});
