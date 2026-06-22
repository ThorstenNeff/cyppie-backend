// DCA orchestration e2e helper (KAN-163) — the APP's on-device sign: raw secp256k1 over the RAW userOpHash
// (the C3 USE-lock, NOT EIP-191). Stands in for Dev-1's app-sign half. Prints the 65-byte signature.
//   TEST_PRIVATE_KEY=0x… node scripts/e2e-sign.mjs <digest>
import { privateKeyToAccount } from "viem/accounts";

const pk = process.env.TEST_PRIVATE_KEY;
if (!pk) throw new Error("TEST_PRIVATE_KEY must be set (same fixed owner key as the enable step)");
const digest = process.argv[2];
if (!/^0x[0-9a-fA-F]{64}$/.test(digest ?? "")) throw new Error("usage: e2e-sign.mjs <0x32-byte-digest>");

const owner = privateKeyToAccount(pk);
const signature = await owner.sign({ hash: digest }); // raw over userOpHash — the DCA USE-mode signer
console.log(signature);
