// Proves the build→(device-sign)→submit ENDPOINT SPLIT end-to-end on Base Sepolia (KAN-139 Inc.3).
//   RUN_SEND=1 node --env-file=../.env test-split.mjs
// The backend builds with the owner ADDRESS only (watch-only, never the device key); a local key mimics
// the device and signs the op-digest + the 7702 authorization OUTSIDE build; the backend submits verbatim.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { buildUserOp, submitUserOp, userOpReceipt } from "./dist/userop.js";

const key = process.env.PIMLICO_API_KEY;
if (!key) throw new Error("PIMLICO_API_KEY not set");
const ctx = {
  chain: baseSepolia,
  bundlerUrl: `https://api.pimlico.io/v2/base-sepolia/rpc?apikey=${key}`,
  publicRpc: "https://base-sepolia-rpc.publicnode.com",
};

// The DEVICE key (in prod on-device; backend only ever sees its address).
const device = privateKeyToAccount(process.env.TEST_PRIVATE_KEY ?? generatePrivateKey());
console.log("device/owner:", device.address);

// 1) BACKEND builds (watch-only address) — returns digest + serialized op + (first-op) auth-to-sign.
const built = await buildUserOp(ctx, device.address, [{ to: device.address, value: 0n, data: "0x" }]);
console.log("built.userOpHash:", built.userOpHash, "| authToSign?", !!built.authorizationToSign);

if (process.env.RUN_SEND !== "1") { console.log("(dry build only — set RUN_SEND=1 to submit)"); process.exit(0); }

// 2) DEVICE signs: the op-digest (raw 65-byte) + the 7702 authorization.
const signature = await device.sign({ hash: built.digestToSign });
let signedAuth;
if (built.authorizationToSign) {
  const a = await device.signAuthorization({
    contractAddress: built.authorizationToSign.address,
    chainId: built.authorizationToSign.chainId,
    nonce: built.authorizationToSign.nonce,
  });
  signedAuth = { address: built.authorizationToSign.address, chainId: built.authorizationToSign.chainId, nonce: built.authorizationToSign.nonce, r: a.r, s: a.s, yParity: a.yParity ?? a.v - 27n };
}

// 3) BACKEND submits the op verbatim + signature (+ signed auth on first op).
const { userOpHash } = await submitUserOp(ctx, built.userOp, signature, signedAuth);
console.log("submitted userOpHash:", userOpHash, "| == built:", userOpHash.toLowerCase() === built.userOpHash.toLowerCase());

// 4) receipt
let r;
for (let i = 0; i < 30; i++) { r = await userOpReceipt(ctx, userOpHash); if (r.found) break; await new Promise((s) => setTimeout(s, 2000)); }
console.log("RECEIPT:", JSON.stringify(r));
