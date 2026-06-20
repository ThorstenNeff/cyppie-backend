# Copy-Trading (PRD-06) — Build-Plan · KAN-149 (Proposal → PO → Build)

> Backend-Agent proposal, analog zum AA-Foundation-Build-Plan (KAN-139), auf der **bewiesenen Ph1-Foundation**
> (aa-trigger OP-Pfad on-chain bewiesen, SubmitGate/Kill-Switch/Q7, Smart-Sessions-Enable-Mechanik, verifyGrant).
> **User-Entscheide (Ph2-Kickoff 2026-06-20):** HSM/KMS = Software+Keychain hinter Signer-Abstraktion →
> YubiHSM2-Drop-in später · Sequenz = **Copy (PRD-06) zuerst** · Copy-Detection = **Alchemy-Webhooks**.

## 0. Kern-Unterschied zu DCA (Ph1) — die eine Architektur-Achse

| | **DCA (Ph1, bewiesen)** | **Copy (Ph2, dieser Plan)** |
|---|---|---|
| Session-Signer | **on-device Owner-Key** (App signt jede Op) | **backend-gehaltener scoped Session-Key** (signt 24/7, App zu) |
| `sessionValidator`-Owner | Owner-EOA (`deriveAddress(0)`) | **Backend-Session-Pubkey** (frisches Keypair) |
| Op-Signatur | App, on-device, pro Op | **Backend `SessionKeySigner`** (HSM/Keychain), pro Mirror |
| Trigger | App / DCA-Scheduler | **Alchemy-Webhook** (gefolgter Trader swappt) |

**Invariante (ADR-0024, unverändert):** der **Haupt-/Owner-Key verlässt NIE das Gerät**. Der Copy-Session-Key
ist **scoped + capped + revocable + on-chain-limitiert** (Smart-Session-Policies) — ein Leak = die on-chain-Cap
(Harm-Reduction), **kein** Drain. Der User **autorisiert** die Session einmalig on-device (verifyGrant + owner-sign),
danach handelt der Backend-Session-Key **nur innerhalb** der on-chain erzwungenen Limits.

## 1. Flow (end-to-end)

```
ENABLE (einmalig, User-konsentiert):
  Backend generiert Copy-Session-Keypair (secp256k1)  ──►  SessionKeySigner (Keychain/HSM, privat bleibt backend-seitig)
        │ session-PUBKEY (address)
        ▼
  App baut Smart-Session-Enable:  sessionValidator = OwnableValidator(threshold=1, owners=[BACKEND_session_pubkey])
        scoped:  actions = [Copy-Router + Swap-Selector],  userOpPolicies = [SpendingLimits cap=TOTAL-Budget, TimeFrame]
        │ verifyGrant (wie DCA: Enable-Digest-Recompute + Policy-Pinning + Cap/Window-Decode + Broad-Access-Gate)
        │ No-blind-Disclosure: „Du erlaubst dem Copy-Service (Key 0x…), bis Cap X auf Router Y zu handeln, bis <Datum>."
        ▼  Owner signt den ENABLE on-device (einmalig)  ──►  grantSession → Registry (aa_session)

TRADE (24/7, ohne App):
  Alchemy-Webhook: gefolgter Trader-Swap  ──►  Parse (DEX-Router-Call → tokenIn/out, amount)
        ▼
  Mirror-Size = scale(source, follower-allocation)  ──►  buildUserOp (Follower-SCA, USE-mode, scoped call)
        ▼
  SUBMIT-GATE (Ph1-Reuse: Kill-Switch + Q7-Exposure)  ──►  SessionKeySigner.sign(userOpHash, EIP-2 low-S)
        ▼
  encodeSmartSessionSignature(USE, permissionId, ownableSig)  ──►  Pimlico-Bundler → EntryPoint v0.7
        ▼
  Smart-Session validiert ON-CHAIN (Router/Selector/Cap) — out-of-policy revertet.
```

## 2. Komponenten

### 2.1 `SessionKeySigner`-Abstraktion (Signer hinter Interface — Keychain jetzt, YubiHSM2-Drop-in)
- **Interface:** `sign(chainId, digest: 32B) -> 65B (r‖s‖v, EIP-2 low-S)` + `publicKeyAddress()`. Ein einziger
  Sign-Pfad; **EIP-2 low-S-Normalisierung verbindlich** (sonst on-chain-Reject) — am Interface erzwungen.
- **Impl-1 (jetzt): `KeychainSessionKeySigner`** — secp256k1-Key **SE-wrapped at-rest** (macOS-Keychain-Item,
  Secure-Enclave-umschlossen), entschlüsselt nur zum Sign-Zeitpunkt im Prozess-RAM. *(Harm-Reduction:
  scoped/capped Key — Kompromittierung = on-chain-Cap, nicht Drain. SE selbst kann secp256k1 NICHT signen →
  nur Wrapping, s. ph2-decision-package.)*
- **Impl-2 (Drop-in): `YubiHsm2SessionKeySigner`** — gleiches Interface, Key sign-in-HSM/non-extractable.
  Kein Aufrufer-Code ändert sich (Abstraktion = der ganze Zweck). Aktivierung = Config-Flip + Hardware.
- **Keine** Key-Persistenz im Repo/in Logs; Keychain-Item host-lokal, ACL auf den Service-User.

### 2.2 Backend-Session-Keypair-Flow + Enable-Inputs für die App
- `POST /v1/copy/session/prepare {follower, source, chainId, scope}` → Backend generiert das Keypair (SessionKeySigner),
  persistiert nur den **Pubkey** + Scope-Metadaten, gibt der App zurück: `{ sessionPublicKey, sessionValidator,
  sessionValidatorInitData = abi.encode(1,[sessionPublicKey]), scope(router/selector/cap/window), nonce }`.
- Die App baut daraus den Enable + `verifyGrant` (dieselbe :evm-Maschinerie wie DCA) → owner-sign → `POST
  /v1/copy/session/grant {enableSig, …}` → Registry. **Der Backend-Pubkey ist client-verifizierbar** (die App
  pinnt nichts Geheimes; sie zeigt nur „Service-Key 0x…" in der Disclosure).

### 2.3 Der scoped Enable (Wiederverwendung der DCA-Enable-Mechanik)
- `sessionValidator` = **OwnableValidator** `0x000000000013fdB5234E4E3162a810F54d9f7E98` (gepinnt, wie DCA), aber
  `owners = [BACKEND_session_pubkey]` (statt Owner-EOA).
- Scope-Policies (alle on-chain, im Enable-Digest): **action** = Copy-Router-Adresse + Swap-Selector;
  **SpendingLimits** `cap = Gesamt-Exposure-Budget` (kumulativ! — N3, `cap = perTrade × maxTrades` *nicht* perTrade);
  **TimeFrame** [start,end]; optional **UsageLimit** (Trade-Anzahl). `permitERC4337Paymaster=true` (Pimlico).
- `verifyGrant` greift **unverändert** (Display-Integritäts-Self-Check). Disclosure-Text Copy-spezifisch.

### 2.4 `/v1/session/trigger` (Ph1-Reuse) + USE-mode-Sign-Pfad
- Reuse **verbatim**: `SubmitGate` (Kill-Switch `isPaused` + Q7 `withinExposureCap`/`recordSpend`), aa_session-Registry,
  on-chain-Revoke. Der Endpoint ist heute der 501-Stub → implementieren.
- **USE-mode-Signatur:** `SessionKeySigner.sign(userOpHash')` → `getOwnableValidatorSignature` →
  `encodeSmartSessionSignature(mode=USE(0x00), permissionId, signature)` = `userOp.signature`. **Build-Time-LOCK**
  (wie der DCA-DIGEST-LOCK): welcher Digest die OwnableValidator-Session-Signatur erwartet (raw userOpHash vs
  EIP-191) wird gegen permissionless/`module-sdk` **on Base Sepolia bewiesen**, bevor der Money-Pfad live geht.

### 2.5 Alchemy-Webhook-Copy-Detection
- **Address-Activity-Webhook** pro gefolgtem Trader (Proxy-Reuse [[ADR-0021]]). Push → `POST /v1/copy/webhook`
  (HMAC-signatur-verifiziert, Alchemy-Signing-Key, fail-closed).
- **Parse:** bekannte DEX-Router/Selector → tokenIn/out + amount. Unbekannter Router → ignorieren (kein blindes Mirror).
- **Mirror-Build:** Size = `scale(sourceAmount, follower-allocation)` → `buildUserOp` (Follower-SCA, scoped call) →
  SubmitGate → Sign → Pimlico. **Idempotenz** pro Source-TxHash (kein Doppel-Mirror bei Webhook-Retry).

## 3. Sub-Decisions — Empfehlungen (zur PO/User-Ratifizierung)

1. **Scaling → proportional-zur-Follower-Allocation** (default): `mirror = sourceFraction × followerBudget`,
   gedeckelt durch die on-chain SpendingLimits-Cap. *(Fixed-Amount simpler, aber weniger treu — als Option.)*
2. **DEX-Router → Uniswap Universal Router (ETH+Base) zuerst** (breite Coverage, bekannte Selektoren); Aggregatoren
   (1inch/0x) als Fast-Follow. Der **action-Scope pinnt die erlaubten Router** — eng starten, additiv erweitern.
3. **Latenz + Slippage → near-real-time akzeptiert** (Webhook-Push, **nicht** MEV-kompetitiv). Pro Mirror ein
   **Slippage-Bound (minOut)** + **Staleness-Window** (skip, wenn detect→build > N s oder Preis > X% bewegt) —
   **kein Chasing**. Werte konfigurierbar, konservativ defaulten.
4. **Per-Follower-Max-Exposure (Q7) → on-chain SpendingLimits-Cap (pro Session) + Backend-Q7-Aggregat**
   (Cross-Session, rest-trust — wie in N3 akzeptiert). Rolling-Window + Gesamt = Backend-Accounting.
5. **MEV → Slippage-Bound + private Submission** (Pimlico/Flashbots-Protect wo verfügbar); Residual (Mirror liegt
   per Definition hinter der Source) **dokumentiert akzeptiert** für Ph2. Kein Front-Running-Anspruch.

## 4. Build-Sequenz (Increments, je verifiziert)

- **C1 — `SessionKeySigner` + Keychain-Impl** (Interface, EIP-2 low-S, KAT-Test recover→pubkey; SE-Wrap at-rest).
- **C2 — Session-Keypair-Flow** (`/v1/copy/session/prepare|grant`, Registry-Erweiterung copy_session, Pubkey-Emit).
- **C3 — USE-mode-Sign-LOCK** (Base-Sepolia: Backend-Session-Key enabled eine scoped Session → signt eine Mirror-Op →
  on-chain-Receipt, wie der DCA-Inc.3-Beweis). **Gate für den Money-Pfad.**
- **C4 — `/v1/session/trigger`** (SubmitGate/Kill-Switch/Q7-Reuse + buildUserOp(USE) + Submit).
- **C5 — Alchemy-Webhook-Detection** (Webhook-Register, HMAC-Verify, Swap-Parse, Mirror-Scale, Idempotenz).
- **C6 — Integration + Härtung** (E2E: Source-Swap → Mirror-Receipt auf Testnet; Kill-Switch/Revoke/Q7-Pfade).
- App-Seite (Dev-1/Dev-2): Copy-Grant-UX (verifyGrant + Copy-Disclosure) + Follow/Allocation-Config + Status — **nach diesem Design**.

## 5. Sicherheits-Modell (Auth ≠ Custody, unverändert)
- Haupt-Key on-device; Backend hält **nur** den scoped Copy-Session-Key (Keychain/HSM), nie den Haupt-Key.
- Jede Mirror-Op: Kill-Switch + Q7 (off-chain) **und** Smart-Session-Policy (on-chain) — doppelt gegated.
- Session-Key = das **einzige** neue sensible Material → Signer-Abstraktion + EIP-2 low-S + HSM-Pfad.
- Webhook fail-closed (HMAC), Router-Allowlist (kein blindes Mirror), Idempotenz (kein Doppel-Submit).
- ADR-0024-Harm-Reduction (enge Caps, staged Rollout, Revoke/Pause) bleibt verbindlich; on-chain-Audit-Linie unverändert.

## 6. Offene Fragen für PO/User (vor C1)
- **Q-A Session-Granularität:** ein Copy-Session-Key **pro Follow-Relationship** (sauberste Revoke/Q7-Trennung) oder
  pro Follower (weniger Enables)? *(Empfehlung: pro Relationship.)*
- **Q-B Allocation-Modell:** fixer Budget-Betrag pro Follow vs. %-des-Portfolios? *(Empfehlung: fixer Budget-Cap =
  die on-chain SpendingLimits-Cap, simpel + deckungsgleich mit dem on-chain-Bound.)*
- **Q-C Router-Set v1:** nur Uniswap Universal Router, oder direkt 1inch/0x mit? *(Empfehlung: Uniswap zuerst.)*
- **Q-D Private Submission:** Flashbots-Protect/Pimlico-privat ab v1 oder Fast-Follow? *(Empfehlung: Slippage-Bound v1,
  private Submission Fast-Follow.)*
- **Q-E Multi-Chain:** ETH+Base parallel ab v1 oder Base-zuerst (günstiger Testnet/Gas)? *(Empfehlung: Base zuerst.)*

## 7. Crypto-Lock-downs (Build-Time, bevor Money-Pfad live)
1. **USE-mode-Session-Digest** (C3): welcher 32-Byte-Digest die OwnableValidator-Session-Signatur erwartet — gegen
   permissionless/module-sdk auf Base Sepolia bewiesen (wie der DCA-DIGEST-LOCK), inkl. echtem Mirror-Receipt.
2. **EIP-2 low-S** am `SessionKeySigner`-Interface erzwungen + KAT-Test.
3. **Enable-Digest** = dieselbe verifyGrant-Maschinerie wie DCA (bereits bewiesen) — nur `sessionValidator`-Owner = Backend-Pubkey.
