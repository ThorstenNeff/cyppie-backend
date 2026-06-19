# Ph2 Decision-Package (Copy/Vaults) — recon

Non-binding research for the PRD-06/07 (Copy-Trading / Vaults) phase — backend-held, scoped session keys
(ADR-0024 Q1 = backend-scoped). The crux for the user's Ph2 kickoff is the **HSM/KMS choice**.

## 1. 🔑 HSM/KMS for the backend-held Copy/Vaults session keys — THE crux

The session keys are **secp256k1** (Ethereum's curve). Hard constraint, verified:

> **macOS Secure Enclave is P-256 (secp256r1) ONLY — it cannot sign secp256k1.** So the Mac Mini's
> built-in hardware HSM is **out** for the signing key. AWS KMS, GCP KMS, and YubiHSM 2 all support
> secp256k1. (All require EIP-2 "low-S" signature normalization.)

| Option | secp256k1 | Key isolation | Self-hosted | RAM/ops on Mac Mini | Notes |
|---|---|---|---|---|---|
| **YubiHSM 2** (USB HSM) | ✅ native | ✅ sign-in-HSM, non-extractable | ✅ | light (USB device) | FIPS, ~one-time hardware cost; the clean self-hosted true-HSM |
| **Software + macOS Keychain** | ✅ (software sign) | ⚠️ key in process memory at sign-time; encrypted at-rest (SE-wrapped Keychain item) | ✅ | lightest | no extra hardware; weaker — but the on-chain caps bound the blast radius |
| **AWS / GCP KMS** | ✅ native | ✅ sign-in-KMS | ❌ cloud | none local | true HSM + IAM/audit, but cloud-dependency (vs the self-hosted v1 posture); fits the cloud-exit |
| HashiCorp Vault | ⚠️ Transit has no native secp256k1 (needs a community Ethereum plugin) | ✅ if plugin | ✅ | heavy (RAM/ops) | **not recommended** on the RAM-constrained Mac Mini |

**Recommendation:** **YubiHSM 2** for the self-hosted v1 — a true secp256k1 hardware HSM that keeps the
keys on the Mac Mini (sign-in-HSM, non-extractable), RAM-light, one-time cost. **Software + Keychain** as
the no-extra-hardware interim (defensible: the keys are *scoped/capped session keys*, so a compromise =
the on-chain cap, **not a drain** — ADR-0024 harm-reduction; the HSM is defense-in-depth, not custody).
**Cloud KMS** (AWS/GCP secp256k1) is the cloud-exit option. → The user pins this at the Ph2 kickoff.

## 2. Backend-trigger architecture (Copy/Vaults, 24/7)

Unlike DCA (on-device sign), Copy/Vaults run **without the app** — the backend signs with the scoped
session key (HSM/KMS) within on-chain limits.

```
signal (copy trade detected / vault rebalance trigger)
  → aa-trigger builds the mirrored/rebalance UserOp on the follower's 7702 SCA
  → SUBMIT-GATE (kill-switch + Q7 exposure — reuse Ph1)
  → sign with the scoped session key (HSM/KMS, sign-in-HSM)
  → Pimlico bundler → EntryPoint → Smart Sessions module enforces the policy ON-CHAIN (reverts out-of-policy)
```

Reuses the Ph1 primitives verbatim: `aa-trigger /v1/session/trigger` (backend-scoped path), the
`SubmitGate` (kill-switch + Q7 exposure), the session registry, on-chain revoke. The session key is the
ONLY new sensitive material — scoped, capped, revocable; never the main key (on-device).

## 3. Copy-Trading data flow

- **Source detection:** watch the followed trader's address for DEX swaps. Options: **Alchemy address-
  activity webhooks** (push, low-latency) or Transfers-API polling or per-block scan; mempool-watching
  for fastest mirroring (more complexity/MEV exposure). We already proxy Alchemy ([[0021]]) → reuse it.
- **Parse:** recognize a swap (known DEX routers) → extract token-in/out + amounts.
- **Mirror:** scale to the follower's allocation (follower config vs source size) → build the mirrored
  swap UserOp on the follower's SCA, **within the session's spending/target/time limits**.
- **Open questions for the kickoff:** which DEXs/routers to mirror; scaling policy (fixed amount vs
  proportional); latency target (real-time vs near-real-time) + slippage/price-move handling between
  detect→execute; MEV/front-running of the mirror; per-follower max-exposure (ties to Q7).

## → Ph2 Decision-Package (for the user's Ph2 kickoff)
1. **HSM/KMS choice** (YubiHSM 2 [recommended self-hosted] vs software+Keychain interim vs cloud-KMS).
2. Copy-trade **source/detection** mechanism (Alchemy webhooks vs polling vs mempool) + **scaling policy**.
3. Vault rebalance trigger model (price/time/threshold).
The trigger architecture + the Ph1 reuse (submit-gate, registry, kill-switch, Smart-Sessions caps) are
settled; the above are the open user decisions.
