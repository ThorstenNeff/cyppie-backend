# EIP-7702 authorization verify contract (KAN-160) — for Dev-2's `verify7702Authorization`

> The first-enable userOp (`/v1/userop/build`) returns `authorizationToSign = { chainId, address, nonce }` — the
> EIP-7702 delegation the owner signs to upgrade the EOA into the Kernel SCA. A malicious `address` (delegate
> target) = **account takeover**. So the App MUST pin `authorizationToSign.address` == the canonical Kernel
> implementation BEFORE signing (fail-closed reconcile, exactly like the UniversalRouter address). The backend
> only ever sets the SDK-pinned impl; this doc is the byte-exact reference.

## Canonical delegate (Kernel implementation)
**`0xd6CEDDe84be40893d153Be9d467CD6aD37875b28`** — ZeroDev **Kernel v0.3.3**, via permissionless
`to7702KernelSmartAccount({ version: "0.3.3" })` (`account.authorization.address`). **CREATE2 ⇒ identical on every
chain.** Verified (two sources, like the addresses.ts boot-gate): the SDK account value + on-chain `getCode` —
**identical + deployed (24469 bytes) on Ethereum(1), Base(8453), Base Sepolia(84532)**. This is exactly what
`buildUserOp` puts in `authorizationToSign.address` on the first (not-yet-upgraded) op.

App reconcile (fail-closed): pin the canonical Kernel v0.3.3 impl client-side (official ZeroDev docs), assert
`authorizationToSign.address == 0xd6CE…75b28` on EVERY chain before signing; on any mismatch, REFUSE to sign
(don't blind-sign a delegation to an unknown target). If ZeroDev publishes a different/newer impl than this pin,
escalate to reconcile (one-line version bump on my side) — never silently accept.

## The authorization tuple + signing hash
`authorizationToSign = { chainId, address: <Kernel impl>, nonce: <EOA tx nonce> }`. The owner signs the EIP-7702
authorization hash:
```
authHash = keccak256( 0x05 ‖ rlp([ chainId, address, nonce ]) )
```
(`0x05` = EIP-7702 MAGIC.) Compute with viem `hashAuthorization({ chainId, contractAddress: address, nonce })`.
`chainId` + `nonce` are runtime (per chain / the EOA's current tx count); `address` is the constant above.

## Deterministic vector (`scripts/auth7702-vector.mjs`)
`AA_ALLOW_TESTNET=1 node --env-file=../.env scripts/auth7702-vector.mjs` — per chain: the delegate (asserted ==
canonical + deployed) and the EIP-7702 auth hash for `nonce=0` (so Dev-2 pins the hash computation):
- **ETH(1):** delegate `0xd6CE…75b28` · authHash(nonce 0) `0x277da3848b6154880dc13cebd5d5c0561fba74538ed0df07872871fc611f307c`
- **Base(8453):** delegate `0xd6CE…75b28` · authHash(nonce 0) `0x949b51ff7d9fd8771fe3391c8e48ac208195590ea744bfe95ea9b3f5bbc0d0bc`
- **Base Sepolia(84532):** delegate `0xd6CE…75b28` · authHash(nonce 0) `0x2ae929e109570ef110f255d51751661454598e1a1f2f747a2a0cc364d15e774b`

Note: the 7702 authorization is NOT part of the userOpHash (`enable-userop-vector.mjs`) — it's a separate signed
object the App authorizes once, on the first op only (subsequent ops return no `authorizationToSign`).

Status: **KAN-160 backend input ✅** — canonical Kernel v0.3.3 delegate `0xd6CE…75b28` (all chains, verified) +
auth-hash vector. App pins + fail-closed reconciles.
