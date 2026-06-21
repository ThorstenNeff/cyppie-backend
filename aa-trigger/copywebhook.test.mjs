// C5 detection unit tests (KAN-149) — HMAC fail-closed + Alchemy parse + scale. Run: node copywebhook.test.mjs
import { createHmac } from "node:crypto";
import { verifyAlchemySignature, parseFollowedSpends, scaleMirror, isAllowlistedRouter, spendKey } from "./dist/copyWebhook.js";

let fails = 0;
const ok = (c, m) => { if (c) console.log("  ✓", m); else { console.log("  ✗", m); fails++; } };

const KEY = "whsec_test_key";
const SOURCE = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const ROUTER_BASE = "0x6fF5693b99212Da76ad316178A184AB56D299b43"; // UniversalRouter (Base) — allowlisted
const UNKNOWN_ROUTER = "0x9999999999999999999999999999999999999999";
const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

console.log("C5: HMAC verify — fail-closed");
const body = JSON.stringify({ event: { network: "BASE_MAINNET", activity: [] } });
const goodSig = createHmac("sha256", KEY).update(body, "utf8").digest("hex");
ok(verifyAlchemySignature(body, goodSig, KEY) === true, "valid signature accepted");
ok(verifyAlchemySignature(body, "0x" + goodSig, KEY) === true, "0x-prefixed signature accepted");
ok(verifyAlchemySignature(body, goodSig.slice(0, -2) + "00", KEY) === false, "tampered signature rejected");
ok(verifyAlchemySignature(body + " ", goodSig, KEY) === false, "tampered body rejected");
ok(verifyAlchemySignature(body, goodSig, undefined) === false, "missing signing key → fail-closed");
ok(verifyAlchemySignature(body, undefined, KEY) === false, "missing signature → fail-closed");
ok(verifyAlchemySignature(body, "abcd", KEY) === false, "length-mismatch signature rejected");

console.log("C5: router allowlist");
ok(isAllowlistedRouter(8453, ROUTER_BASE) === true, "Base UniversalRouter allowlisted");
ok(isAllowlistedRouter(8453, UNKNOWN_ROUTER) === false, "unknown router not allowlisted");
ok(isAllowlistedRouter(999, ROUTER_BASE) === false, "unknown chain not allowlisted");

console.log("C5: parseFollowedSpends — only followed-source → allowlisted-router ERC-20 spends");
const payload = { event: { network: "BASE_MAINNET", activity: [
  { category: "token", fromAddress: SOURCE, toAddress: ROUTER_BASE, hash: "0xtx1", rawContract: { address: TOKEN, rawValue: "0xf4240" } }, // 1_000_000 — KEEP
  { category: "token", fromAddress: OTHER, toAddress: ROUTER_BASE, hash: "0xtx2", rawContract: { address: TOKEN, rawValue: "0xf4240" } }, // not followed — DROP
  { category: "token", fromAddress: SOURCE, toAddress: UNKNOWN_ROUTER, hash: "0xtx3", rawContract: { address: TOKEN, rawValue: "0xf4240" } }, // unknown router — DROP
  { category: "external", fromAddress: SOURCE, toAddress: ROUTER_BASE, hash: "0xtx4" }, // non-token — DROP
  { category: "token", fromAddress: SOURCE, toAddress: ROUTER_BASE, hash: "0xtx5", rawContract: { address: TOKEN, rawValue: "0x0" } }, // zero amount — DROP
] } };
const isFollowed = (a) => a.toLowerCase() === SOURCE.toLowerCase();
const spends = parseFollowedSpends(payload, isFollowed);
ok(spends.length === 1, `exactly one spend detected (got ${spends.length})`);
ok(spends[0]?.sourceTxHash === "0xtx1", "the followed→allowlisted spend");
ok(spends[0]?.amountIn === 1000000n, "amountIn parsed from rawValue");
ok(spends[0]?.chainId === 8453, "chainId from network slug");
ok(spends[0]?.tokenIn.toLowerCase() === TOKEN.toLowerCase(), "tokenIn parsed");
ok(parseFollowedSpends({ event: { network: "DOGE", activity: [] } }, isFollowed).length === 0, "unknown network → empty");

console.log("P2-3 (KAN-156): one malformed activity is dropped, valid spends in the same batch survive");
const mixed = { event: { network: "BASE_MAINNET", activity: [
  { category: "token", fromAddress: SOURCE, toAddress: ROUTER_BASE, hash: "0xbad", rawContract: { address: "0xNOT_AN_ADDRESS", rawValue: "0xf4240" } }, // getAddress throws → DROP, no 500
  { category: "token", fromAddress: SOURCE, toAddress: ROUTER_BASE, hash: "0xgood", rawContract: { address: TOKEN, rawValue: "0xf4240" } }, // KEEP
] } };
let parsed;
try { parsed = parseFollowedSpends(mixed, isFollowed); } catch { parsed = "THREW"; }
ok(parsed !== "THREW", "malformed activity does not throw (no webhook 500 / retry storm)");
ok(Array.isArray(parsed) && parsed.length === 1 && parsed[0].sourceTxHash === "0xgood", "the valid spend in the batch survives");

console.log("P2-2 (KAN-156): idempotency key = (txHash, logIndex) — a multi-swap tx yields distinct legs");
const multiLeg = { event: { network: "BASE_MAINNET", activity: [
  { category: "token", fromAddress: SOURCE, toAddress: ROUTER_BASE, hash: "0xmulti", rawContract: { address: TOKEN, rawValue: "0xf4240" }, log: { logIndex: "0x3" } },
  { category: "token", fromAddress: SOURCE, toAddress: ROUTER_BASE, hash: "0xmulti", rawContract: { address: TOKEN, rawValue: "0x1e8480" }, log: { logIndex: 7 } },
] } };
const legs = parseFollowedSpends(multiLeg, isFollowed);
ok(legs.length === 2, `both legs of the same tx detected (got ${legs.length})`);
ok(legs[0].logIndex === 3 && legs[1].logIndex === 7, "logIndex parsed (hex + number)");
ok(spendKey(legs[0]) !== spendKey(legs[1]), "distinct idempotency keys for the two legs");
ok(spendKey(legs[0]) === "0xmulti:3", `spendKey = txHash:logIndex (got ${spendKey(legs[0])})`);
ok(spendKey({ sourceTxHash: "0xNOLOG", logIndex: 0 }) === "0xnolog:0", "no-log activity → logIndex 0");

console.log("KAN-161: dynamic mode — derive tokenOut from the source swap's OUTPUT leg");
const TOKEN_OUT = "0x4200000000000000000000000000000000000006"; // WETH (Base) — what the trader received
const POOL = "0x5555555555555555555555555555555555555555";
const swap = { event: { network: "BASE_MAINNET", activity: [
  { category: "token", fromAddress: SOURCE, toAddress: ROUTER_BASE, hash: "0xswap", rawContract: { address: TOKEN, rawValue: "0xf4240" } }, // input leg: source spends TOKEN
  { category: "token", fromAddress: POOL, toAddress: SOURCE, hash: "0xswap", rawContract: { address: TOKEN_OUT, rawValue: "0x2710" } }, // output leg: source receives TOKEN_OUT
] } };
const sw = parseFollowedSpends(swap, isFollowed);
ok(sw.length === 1, `input leg detected (got ${sw.length})`);
ok(sw[0].tokenOutDetected?.toLowerCase() === TOKEN_OUT.toLowerCase(), "tokenOut derived from the output leg");
ok(sw[0].amountOutDetected === 10000n, "amountOut derived from the output leg");
// ambiguous: two distinct received tokens → no derive (fail-closed)
const ambig = { event: { network: "BASE_MAINNET", activity: [
  { category: "token", fromAddress: SOURCE, toAddress: ROUTER_BASE, hash: "0xamb", rawContract: { address: TOKEN, rawValue: "0xf4240" } },
  { category: "token", fromAddress: POOL, toAddress: SOURCE, hash: "0xamb", rawContract: { address: TOKEN_OUT, rawValue: "0x2710" } },
  { category: "token", fromAddress: POOL, toAddress: SOURCE, hash: "0xamb", rawContract: { address: "0x111122223333444455556666777788889999AaAa", rawValue: "0x1" } },
] } };
ok(parseFollowedSpends(ambig, isFollowed)[0]?.tokenOutDetected === undefined, "ambiguous output (2 tokens) → no derive (dynamic fail-closed)");
// no output leg (only the input transfer) → no derive
const noOut = { event: { network: "BASE_MAINNET", activity: [
  { category: "token", fromAddress: SOURCE, toAddress: ROUTER_BASE, hash: "0xnoout", rawContract: { address: TOKEN, rawValue: "0xf4240" } },
] } };
ok(parseFollowedSpends(noOut, isFollowed)[0]?.tokenOutDetected === undefined, "no output leg → no derive");

console.log("C5: scaleMirror — proportional, cap-clamped");
ok(scaleMirror(1000000n, 5000, 10n ** 18n) === 500000n, "50% allocation");
ok(scaleMirror(1000000n, 10000, 400000n) === 400000n, "clamped to remaining cap");
ok(scaleMirror(1000000n, 0, 10n ** 18n) === 0n, "0 allocation → 0");
ok(scaleMirror(1000000n, 10000, 0n) === 0n, "cap exhausted → 0");

console.log(fails === 0 ? "\nALL PASS ✓" : `\n${fails} FAILED ✗`);
process.exit(fails === 0 ? 0 : 1);
