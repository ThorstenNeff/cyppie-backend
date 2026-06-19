# AA-Foundation Build-Plan (KAN-139) — proposal

Concrete build design for the unattended-automation foundation (ADR-0024, Epic KAN-138). Stack pinned at
the PRD-05 kickoff: **Kernel (ERC-7579) + Rhinestone Smart Sessions + EIP-7702 same-address + Pimlico**,
**ETH + Base**, **per-feature custody** (DCA on-device; Copy/Vaults backend-scoped). 🔑 The main seed/key
**never** leaves the device; the backend only ever holds **scoped, revocable, on-chain-limited** session
keys (Copy/Vaults), never the main key — Auth ≠ Custody ([[0005]]/[[0023]]).

## 0. Key architecture call — the AA layer is a TypeScript service

The AA ecosystem (permissionless.js, Rhinestone module-sdk, viem) is **TS/viem-native**; there is no
mature Kotlin/JVM ERC-4337/7579 SDK. Re-implementing UserOp construction + 7579/Smart-Sessions encoding +
session-key signing + Pimlico submission in Kotlin would be large and error-prone.

→ **Proposal: a small Node/TS `aa-trigger` service** (permissionless.js + Rhinestone SDK + viem) that owns
UserOp construction, session-key signing, and Pimlico submission. It sits **alongside** the Kotlin
User-Service (both launchd-native; ADR-0023). The Kotlin side keeps identity/profiles/auth; the Node side
keeps the on-chain automation. Internal boundary = a small private HTTP API on loopback (not internet-exposed).

## 1. Component map + ownership

| Component | Owner | Notes |
|---|---|---|
| **7702 SCA upgrade** (EOA→Kernel at the SIWE address) | **App** (Dev-1/Dev-2) | on-device EIP-7702 authorization, signed by the main key once |
| **Smart-Session grant UX** (review scopes/limits → enable) | **App** | user signs the session enable on-device |
| **DCA on-device signing** (Q1: DCA = on-device) | **App** | app signs the DCA UserOp when running |
| **`aa-trigger` service** (UserOp build/sign/submit via Pimlico) | **Backend (me)** | Node/TS; Copy/Vaults backend-scoped keys |
| **Session-key storage** (HSM/KMS) | **Backend (me)** | Copy/Vaults only (Q1c); dev = encrypted-at-rest, prod = cloud KMS / hardware-backed |
| **Session registry + exposure tracking** (Postgres) | **Backend (me)** | sessions, scopes, expiry, cumulative spend (Q7 total-exposure cap) |
| **Kill-switch / revoke** | **Backend + App** | global pause (backend) + on-chain revoke (user, app); backend honors |
| **Contracts** | **none custom for v1** | audited Kernel + Smart Sessions; only confirm module addresses on ETH+Base |

## 2. Flows

**DCA (PRD-05, on-device):** scheduler (backend signal "buy now") → the **app** constructs + **signs** the
DCA UserOp on-device (or signs a backend-prepared UserOp) → Pimlico. Backend signs **nothing** here — it
only emits the signal/schedule. Fully non-custodial; works when the device is available (interim (E)).

**Copy / Vaults (PRD-06/07, backend-scoped):**
1. **Grant (on-device, once):** user enables a Smart-Session on their SCA — signer = the **backend session
   key**, scoped to `ScopedAction` (allowed router/contract + selector) + policies (`SpendingLimits` per
   token, time-frame, usage) + expiry. Signed on-device by the main key.
2. **Trigger:** a copy event / rebalance signal → `aa-trigger` builds a UserOp, **signs with the scoped
   session key** (within limits), submits via Pimlico → EntryPoint → Kernel → Smart Sessions module
   **enforces the policy on-chain** (out-of-policy = revert/fail-closed).
3. The backend pre-validates against the registry (avoid wasted reverts) + tracks **cumulative exposure**
   across all of a user's active sessions (Q7) — the on-chain per-session cap is the hard gate; the
   cross-session aggregate is an additional backend gate.

## 3. Build phasing (sequence)

- **Phase 0 (shared, blocks both):** confirm Kernel + Smart Sessions module addresses on ETH + Base;
  define the **session-config schema** (targets/selectors/limits/expiry) shared App↔Backend; define the
  `aa-trigger` internal API; SCA-address = SIWE-address invariant ([[0026]]).
- **Phase 1 (PRD-05 DCA, on-device):** App = 7702 upgrade + Smart-Session grant UX + on-device DCA signing.
  Backend = DCA **schedule/signal** service only (no signing). Smallest backend footprint → ships first.
- **Phase 2 (PRD-06/07 Copy/Vaults, backend-scoped):** Backend = `aa-trigger` service + session-key
  storage (HSM/KMS) + registry/exposure + kill-switch + Pimlico per-chain. The heavier backend AA build.

## 4. Backend deliverables (my KAN-139 track)

1. `aa-trigger` (Node/TS): permissionless.js + Rhinestone + Pimlico; build/sign/submit UserOp for a
   `(user, session, action)` within limits; status + receipt tracking. launchd service, loopback API.
2. Session-key **storage abstraction** (HSM/KMS; dev fallback = encrypted-at-rest, prod = cloud KMS).
3. Session **registry + exposure** (Postgres migration `V2__aa_sessions.sql`): sessions, scopes, expiry,
   cumulative spend; total-exposure cap (Q7).
4. **Kill-switch**: global pause flag (stop new UserOps) + revoke-honoring.
5. **Pimlico** config per chain (API keys host-env), ETH + Base.

## 5. Open / risks (for the build kickoff)

- **HSM/KMS choice** for backend session keys (Q1c) — dev vs prod path.
- **EIP-7702 on Base** maturity + Kernel 7702 mode addresses — confirm in Phase 0.
- **Total-exposure (Q7)** = on-chain per-session cap + backend cross-session aggregate (off-chain) — define the aggregate policy.
- **TS↔Kotlin boundary** — keep the `aa-trigger` API minimal + loopback-only; secrets host-env.
- **Harm-reduction (ADR-0024)** stays binding: low staged caps, multi-eye review/bounty, pause/revoke.

→ **Next:** PO review of this plan → sequence Phase 0/1 (Backend signal + App 7702/grant) ahead of the
heavier Phase 2 backend AA service. Backend (me) + App-side (Dev-1/Dev-2) split per the table above.
