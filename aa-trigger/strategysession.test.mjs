// KAN-164 Strategy session KAT — the [M Caps, Permit2, UR] action layout + canonical leg order + cap placement.
// Locks the M-token generalization of the copy session against regressions. No network.
//   node strategysession.test.mjs
import { decodeAbiParameters, parseAbi, getAddress, slice, decodeFunctionData } from "viem";
import { getPermissionId, getOwnableValidator } from "@rhinestone/module-sdk";
import { buildStrategySession, assembleStrategyEnableInputs, sortLegs } from "./dist/strategySession.js";
import { PERMIT2_ADDRESS, APPROVE_SELECTOR, PERMIT2_APPROVE_SELECTOR, UNIVERSAL_ROUTER_EXECUTE_SELECTOR } from "./dist/swapAdapter.js";

let fails = 0;
const ok = (c, m) => { if (c) console.log("  ✓", m); else { console.log("  ✗", m); fails++; } };

const SESSION_PUBKEY = "0x489ccacAC8836C71Ad5B20Bf61e0b885425b227e";
const SALT = "0x00000000000000000000000000000000000000000000000000000000000000aa";
const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const UR = "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
const CAPS = { [USDC.toLowerCase()]: 1_000_000_000n, [WETH.toLowerCase()]: 10n ** 18n, [WBTC.toLowerCase()]: 100_000_000n };
// Deliberately UNSORTED user input — assembly must canonicalize by token address.
const scope = {
  chainId: 1, router: UR, account: ACCOUNT, windowStart: 0, windowEnd: 1893456000,
  legs: [ { token: WETH, cap: CAPS[WETH.toLowerCase()] }, { token: USDC, cap: CAPS[USDC.toLowerCase()] }, { token: WBTC, cap: CAPS[WBTC.toLowerCase()] } ],
};

console.log("KAN-164: buildStrategySession — [M Caps, Permit2, UR] layout (M=3)");
const session = buildStrategySession(SESSION_PUBKEY, SALT, scope);
ok(session.actions.length === 5, `5 actions = 3 caps + Permit2 + UR (got ${session.actions.length})`);

// Caps first, in canonical (ascending address) order — order-independent of user input.
const sorted = sortLegs(scope.legs);
ok(sorted.map((l) => l.token.toLowerCase()).join() === [WBTC, USDC, WETH].map((a) => a.toLowerCase()).join(), "legs canonical-sorted by address (WBTC<USDC<WETH)");
for (let i = 0; i < 3; i++) {
  ok(slice(session.actions[i].actionTargetSelector, 0, 4).toLowerCase() === APPROVE_SELECTOR, `cap[${i}] selector = approve`);
  ok(getAddress(session.actions[i].actionTarget) === getAddress(sorted[i].token), `cap[${i}] target = sorted token ${i}`);
}

// Then Permit2, then UR.
ok(session.actions[3].actionTargetSelector.toLowerCase() === PERMIT2_APPROVE_SELECTOR && getAddress(session.actions[3].actionTarget) === getAddress(PERMIT2_ADDRESS), "action[3] = Permit2.approve");
ok(session.actions[4].actionTargetSelector.toLowerCase() === UNIVERSAL_ROUTER_EXECUTE_SELECTOR && getAddress(session.actions[4].actionTarget) === getAddress(UR), "action[4] = UniversalRouter.execute");

// userOpPolicies = single TimeFrame window; each cap action carries exactly one (SpendingLimits) policy.
ok(session.userOpPolicies.length === 1, "userOpPolicies = [TimeFrame window]");
ok(session.actions.slice(0, 3).every((a) => a.actionPolicies.length === 1), "each cap action has exactly one (SpendingLimits) policy");

// Each cap's SpendingLimits initData encodes (token, limit) for THAT leg — the per-token Sell-Cap.
console.log("KAN-164: per-token cap = the granted limit (SpendingLimits initData)");
for (let i = 0; i < 3; i++) {
  const [tokens, limits] = decodeAbiParameters([{ type: "address[]" }, { type: "uint256[]" }], session.actions[i].actionPolicies[0].initData);
  ok(tokens.length === 1 && getAddress(tokens[0]) === getAddress(sorted[i].token), `cap[${i}] SpendingLimits token == leg token`);
  ok(limits[0] === sorted[i].cap, `cap[${i}] SpendingLimits limit == granted cap (${sorted[i].cap})`);
}

console.log("KAN-164: permissionId = keccak(validator, initData, salt) — independent of basket/caps");
const inputs = assembleStrategyEnableInputs(SESSION_PUBKEY, SALT, scope);
ok(inputs.legCount === 3, "legCount = M = 3");
ok(inputs.permissionId === getPermissionId({ session }), "assembled permissionId == session permissionId");
// Same validator+salt but a DIFFERENT basket ⇒ SAME permissionId (the scope is in the actions, not the id).
const otherBasket = buildStrategySession(SESSION_PUBKEY, SALT, { ...scope, legs: [{ token: USDC, cap: 1n }] });
ok(getPermissionId({ session: otherBasket }) === inputs.permissionId, "different basket → SAME permissionId (scope lives in actions, NOT the id)");
// The OwnableValidator owner is the BACKEND session key (Auth≠Custody), not the account.
ok(session.sessionValidatorInitData === getOwnableValidator({ threshold: 1, owners: [SESSION_PUBKEY] }).initData, "OwnableValidator owner = backend session key");

// Guard: empty basket rejected.
let threw = false; try { buildStrategySession(SESSION_PUBKEY, SALT, { ...scope, legs: [] }); } catch { threw = true; }
ok(threw, "empty basket rejected");

console.log(fails === 0 ? "\nALL PASS ✓" : `\n${fails} FAILED ✗`);
process.exit(fails === 0 ? 0 : 1);
