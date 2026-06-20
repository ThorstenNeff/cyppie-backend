// C2 verification (KAN-149): assembleEnableInputs produces a byte-exact, app-reproducible ENABLE digest,
// and the registry prepare->grant->signer lifecycle round-trips. Run: node copysession.test.mjs
import { hashChainSessions } from "@rhinestone/module-sdk";
import { hashTypedData } from "viem";
import { rmSync } from "node:fs";
import { assembleEnableInputs, CopySessionRegistry } from "./dist/copySession.js";

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
ok(inputs.userOpPolicies[0].policy.toLowerCase() === "0x000000000033212e272655d8a22402db819477a6", "SpendingLimits = GLOBAL_CONSTANTS policy");
ok(inputs.actions[0].actionPolicies[0].policy.toLowerCase() === "0x0000000000d30f611fa3bf652ac6879428586930", "TimeFrame = GLOBAL_CONSTANTS policy");
ok(inputs.actions[0].actionTarget.toLowerCase() === scope.router.toLowerCase(), "action scoped to the copy router");

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
// cleanup: keychain item + temp file
import("node:child_process").then(({ execFileSync }) => {
  try { execFileSync("security", ["delete-generic-password", "-s", "cyppie-copy-session", "-a", reg.get(prepared.permissionId).keychainAccount]); } catch {}
  rmSync(path, { force: true });
  console.log(fails === 0 ? "\nALL PASS ✓" : `\n${fails} FAILED ✗`);
  process.exit(fails === 0 ? 0 : 1);
});
