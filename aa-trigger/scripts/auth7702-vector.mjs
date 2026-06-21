// EIP-7702 authorization KAT (KAN-160) — byte-exact reference for Dev-2's `verify7702Authorization`.
//   AA_ALLOW_TESTNET=1 node --env-file=../.env scripts/auth7702-vector.mjs
//
// The first-enable userOp (`/v1/userop/build`) returns `authorizationToSign = { chainId, address, nonce }` — the
// EIP-7702 delegation the owner signs to upgrade the EOA to the Kernel SCA. A malicious delegate target = account
// takeover, so the App MUST pin `address` == the canonical Kernel implementation (fail-closed reconcile, like the
// UniversalRouter address) BEFORE signing. This emits that delegate (verified identical + deployed on every chain)
// and the EIP-7702 authorization hash for a fixed nonce so Dev-2 pins the hash computation too.
import { createPublicClient, http } from "viem";
import { hashAuthorization } from "viem/utils";
import { mainnet, base, baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint07Address } from "viem/account-abstraction";
import { to7702KernelSmartAccount } from "permissionless/accounts";

// Kernel implementation (ZeroDev v0.3.3) — permissionless `to7702KernelSmartAccount({version:'0.3.3'})`. CREATE2 ⇒
// identical address on every chain; this is what `buildUserOp` puts in authorizationToSign.address. VERIFIED below
// (read from the SDK account + getCode on each chain — two sources, like the addresses.ts boot-gate).
const EXPECTED_KERNEL_IMPL = "0xd6CEDDe84be40893d153Be9d467CD6aD37875b28";
const FIXED_NONCE = 0n; // the EOA's tx nonce at runtime (chain state); fixed here only to make the hash pinnable.

const CHAINS = { 1: ["Ethereum", "https://ethereum-rpc.publicnode.com", mainnet], 8453: ["Base", "https://base-rpc.publicnode.com", base], 84532: ["Base Sepolia", "https://base-sepolia-rpc.publicnode.com", baseSepolia] };

let fails = 0;
for (const [id, [name, rpc, chain]] of Object.entries(CHAINS)) {
  const client = createPublicClient({ chain, transport: http(rpc) });
  const account = await to7702KernelSmartAccount({ client, owner: privateKeyToAccount(generatePrivateKey()), entryPoint: { address: entryPoint07Address, version: "0.7" }, version: "0.3.3" });
  const delegate = account.authorization.address;
  const code = await client.getCode({ address: delegate }).catch(() => null);
  const deployed = !!code && code !== "0x";
  const matches = delegate.toLowerCase() === EXPECTED_KERNEL_IMPL.toLowerCase();
  if (!deployed || !matches) fails++;
  // The EIP-7702 authorization signing hash: keccak256(0x05 ‖ rlp([chainId, address, nonce])).
  const authHash = hashAuthorization({ chainId: Number(id), contractAddress: delegate, nonce: Number(FIXED_NONCE) });
  console.log(`\n──────── ${name} (chain ${id}) ────────`);
  console.log("delegate (Kernel impl):", delegate, matches ? "✓ == expected" : "✗ MISMATCH");
  console.log("deployed on-chain     :", deployed, code ? `(${(code.length - 2) / 2} bytes)` : "");
  console.log("authorizationToSign   :", JSON.stringify({ chainId: Number(id), address: delegate, nonce: Number(FIXED_NONCE) }));
  console.log("EIP-7702 auth hash    :", authHash, "(= keccak256(0x05 ‖ rlp([chainId, address, nonce])); owner signs THIS)");
}
console.log(`\nKernel impl (all chains): ${EXPECTED_KERNEL_IMPL} · ZeroDev Kernel v0.3.3 · permissionless to7702KernelSmartAccount version '0.3.3'.`);
console.log(fails === 0 ? "ALL chains: delegate == expected + deployed ✓ — App pins authorizationToSign.address against this, fail-closed." : `${fails} chain(s) FAILED ✗`);
process.exit(fails === 0 ? 0 : 1);
