// KAT for the Copy-Trading SessionKeySigner (KAN-149 C1). Run: node sessionkeysigner.test.mjs
// Verifies: address derivation, deterministic signature, recovery -> signer, EIP-2 low-S enforcement,
// and the high-S normalization (the guard that makes the YubiHSM2 drop-in safe).
import { recoverAddress, hexToBytes } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  InMemorySessionKeySigner, normalizeToLowS, encodeSignature65, signDigestLowS, addressFromPrivateKey,
} from "./dist/sessionKeySigner.js";

const N = secp256k1.CURVE.n;
const HALF_N = N / 2n;
let fails = 0;
const ok = (c, m) => { if (c) console.log("  ✓", m); else { console.log("  ✗", m); fails++; } };

// Known-answer: Hardhat acct0 key -> known address.
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const EXPECTED_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const DIGEST = "0x1111111111111111111111111111111111111111111111111111111111111111";

console.log("KAT: address derivation");
const addr = addressFromPrivateKey(hexToBytes(PK));
ok(addr.toLowerCase() === EXPECTED_ADDR.toLowerCase(), `address ${addr} == acct0`);

console.log("KAT: deterministic signature (RFC-6979) + 65-byte shape");
const signer = new InMemorySessionKeySigner(PK);
const sig1 = await signer.sign(DIGEST);
const sig2 = await signer.sign(DIGEST);
ok(sig1 === sig2, "signature is deterministic (same key+digest -> same sig)");
ok(sig1.length === 132, `65-byte signature (got ${(sig1.length - 2) / 2} bytes)`);
const v = parseInt(sig1.slice(130), 16);
ok(v === 27 || v === 28, `v ∈ {27,28} (got ${v})`);

console.log("KAT: recovery -> signer address");
const recovered = await recoverAddress({ hash: DIGEST, signature: sig1 });
ok(recovered.toLowerCase() === EXPECTED_ADDR.toLowerCase(), `recovered ${recovered} == acct0`);

console.log("EIP-2 low-S: output S <= n/2");
const s1 = BigInt("0x" + sig1.slice(66, 130));
ok(s1 <= HALF_N, "output S is canonical low-S");

console.log("high-S normalization (HSM-drop-in guard)");
// Take the canonical sig's (r,s,recovery); synthesize its high-S twin and normalize it back.
const raw = secp256k1.sign(hexToBytes(DIGEST), hexToBytes(PK)); // low-S, with recovery
const sLow = raw.s, rec = raw.recovery;
const sHigh = N - sLow; // the non-canonical twin
ok(sHigh > HALF_N, "synthesized S is high-S");
const norm = normalizeToLowS(raw.r, sHigh, rec ^ 1);
ok(norm.s === sLow && norm.recovery === rec, "normalizeToLowS flips S=n-S and toggles recovery -> canonical");
ok(normalizeToLowS(raw.r, sLow, rec).s === sLow, "normalizeToLowS is idempotent on low-S input");
// Both the high-S form and its normalized low-S form must recover to the same signer.
const sigHigh = encodeSignature65(raw.r, sHigh, rec ^ 1);
const sigLow = encodeSignature65(norm.r, norm.s, norm.recovery);
const recHigh = await recoverAddress({ hash: DIGEST, signature: sigHigh });
const recLow = await recoverAddress({ hash: DIGEST, signature: sigLow });
ok(recHigh.toLowerCase() === EXPECTED_ADDR.toLowerCase(), "high-S form recovers to signer (ecrecover-accepted)");
ok(recLow.toLowerCase() === EXPECTED_ADDR.toLowerCase(), "normalized low-S form recovers to signer");
ok(sigLow === sig1, "normalized low-S form == the signer's canonical output");

console.log("core signDigestLowS == signer.sign");
ok(signDigestLowS(hexToBytes(PK), hexToBytes(DIGEST)) === sig1, "raw core matches the InMemory signer path");

console.log(fails === 0 ? "\nALL PASS ✓" : `\n${fails} FAILED ✗`);
process.exit(fails === 0 ? 0 : 1);
