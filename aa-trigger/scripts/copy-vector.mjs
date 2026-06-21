// Copy-Trading enable KAT (KAN-154) — the byte-exact reference for Dev-2's app-side CopyEnableBuilder/verifyGrant.
//   node scripts/copy-vector.mjs
//
// Deterministic, no network. For a FIXED (sessionPubkey, salt, scope) on ETH(1) + Base(8453), emits the
// production C6 THREE-action UniversalRouter shape (token.approve→SpendingLimits, Permit2.approve→TimeFrame,
// router.execute→TimeFrame) and the per-chain permissionId + the app-reproducible enable digest. Dev-2 builds the
// same client-side and confirms byte-equality (the DCA-Vector-D convergence pattern). The enable digest depends
// ONLY on (validator + initData + salt + policies/actions + account + nonce) — NOT on tokenOut/feeTier/slippage
// (those are mirror-time swap calldata, so the app may set them freely without changing the permissionId).
import { assembleEnableInputs } from "../dist/copySession.js";
import { hashChainSessions } from "@rhinestone/module-sdk";
import { hashTypedData } from "viem";

// ── Fixed KAT inputs (pin these EXACTLY on the app side) ──
const SESSION_PUBKEY = "0x489ccacAC8836C71Ad5B20Bf61e0b885425b227e"; // example backend session key (owners[0])
const SALT = "0x00000000000000000000000000000000000000000000000000000000000000aa";
const FOLLOWER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // the follower SCA (= owner EOA, 7702 same-address)
const SOURCE = "0x1111111111111111111111111111111111111111"; // the followed trader
const WINDOW = { windowStart: 0, windowEnd: 1893456000 };

// UniversalRouter (Uniswap) per chain — the (target) the router.execute action pins; MUST match the backend
// swapAdapter table. ETH confirmed via Uniswap docs; Base from the adapter (cross-check vs the v4 deployments page).
const UR = { 1: "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af", 8453: "0x6fF5693b99212Da76ad316178A184AB56D299b43" };
const USDC = { 1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
const WETH = { 1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", 8453: "0x4200000000000000000000000000000000000006" };
const EXECUTE_SELECTOR = "0x3593564c";

// EIP-712 type table for the raw-viem cross-check (must equal :evm SmartSessionEnableDigest + the enable spec).
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

let fails = 0;
for (const chainId of [1, 8453]) {
  const scope = {
    chainId, token: USDC[chainId], capTotalBudget: 1000000000n, // 1000 USDC (6 dec) total budget (N3)
    router: UR[chainId], selector: EXECUTE_SELECTOR, ...WINDOW, follower: FOLLOWER, source: SOURCE,
    tokenOut: WETH[chainId], feeTier: 500, // mirror-time swap params (NOT in the permissionId)
  };
  const inputs = assembleEnableInputs(SESSION_PUBKEY, SALT, scope);
  const signedSession = {
    account: FOLLOWER,
    permissions: {
      permitGenericPolicy: false, permitAdminAccess: false, ignoreSecurityAttestations: false,
      permitERC4337Paymaster: true, userOpPolicies: inputs.userOpPolicies,
      erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] }, actions: inputs.actions,
    },
    sessionValidator: inputs.sessionValidator, sessionValidatorInitData: inputs.sessionValidatorInitData,
    salt: SALT, smartSession: inputs.smartSession, nonce: 0n,
  };
  const chainSessions = [{ chainId: BigInt(chainId), session: signedSession }];
  const sdkDigest = hashChainSessions(chainSessions);
  const rawDigest = hashTypedData({ domain: { name: "SmartSession", version: "1" }, types: TYPES, primaryType: "MultiChainSession", message: { sessionsAndChainIds: chainSessions } });
  const match = sdkDigest === rawDigest;
  if (!match) fails++;

  console.log(`\n──────── chain ${chainId} ${chainId === 1 ? "(Ethereum)" : "(Base)"} ────────`);
  console.log("sessionValidator   :", inputs.sessionValidator, "(OwnableValidator)");
  console.log("router (UR)        :", scope.router);
  console.log("actions            :");
  for (const a of inputs.actions) console.log("   ", a.actionTargetSelector, a.actionTarget, "→ policy", a.actionPolicies[0].policy);
  console.log("permissionId       :", inputs.permissionId);
  console.log("enable digest      :", sdkDigest, match ? "(SDK == raw-viem ✓)" : "(MISMATCH ✗)");
}
console.log(`\n${fails === 0 ? "ALL digests SDK==raw-viem ✓ (app-reproducible)" : `${fails} MISMATCH ✗`}`);
console.log("Pin on the app side: sessionPubkey/salt/follower/source/window/token/router/cap above; tokenOut/feeTier/slippage do NOT affect the permissionId.");
process.exit(fails === 0 ? 0 : 1);
