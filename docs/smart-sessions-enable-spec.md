# Smart Sessions ENABLE-Digest — C-Build-Inputs für Dev-2 (on-device verify)

**Zweck:** Dev-2 baut den Grant-Enable **on-device** und muss den zu signierenden Digest **unabhängig
nachrechnen** (kein Trust auf Backend-Pins, sonst ist die No-blind-Verifikation wertlos). Dieses Doc
liefert die drei auditierten Pins: (1) den EIP-712-Typ, (2) einen Referenz-Vektor, (3) die Domain-/Chain-
Konstanten + die `account`-Ableitung. Extrahiert aus `@rhinestone/module-sdk@0.3.1`
(`_esm/module/smart-sessions/usage.js`); reproduzierbar via `aa-trigger/scripts/enable-vector.mjs`.

ADR-0024-Stack: Kernel(ERC-7579) + Rhinestone Smart Sessions + EIP-7702 same-address + Pimlico.

---

## 0. Kernaussage (was Dev-2 signiert)

Der Enable-Digest ist eine **reine EIP-712-`hashTypedData`** über eine `MultiChainSession` — **vollständig
offline rechenbar**. Der einzige Laufzeit-Input ist die **session `nonce`** (aus `getSessionNonce`, kommt
mit dem Grant-Material). **NICHT** Teil des signierten Digests ist der `getSessionDigest`-Contract-Call —
dessen Resultat füllt nur den *On-Chain*-Envelope (`hashesAndChainIds`/`chainDigests`), nicht die Signatur.

```
digestToSign  =  EIP712( domain, MultiChainSession{ sessionsAndChainIds: [ {chainId, session} ] } )
```

Single-chain-Enable = ein 1-elementiges Array. (Multi-chain = mehrere ChainSessions im selben Hash.)

---

## 1. EIP-712-Typ (PIN #1) — exakt, Reihenfolge signifikant

**Domain** — bewusst **OHNE `chainId`, OHNE `verifyingContract`**:
```json
{ "name": "SmartSession", "version": "1" }
```
> Die Chain-Bindung steckt **im Message-Body**, nicht in der Domain: `ChainSession.chainId` (uint64) +
> das Feld `SignedSession.smartSession` (die SmartSessions-Modul-Adresse). Das ist der Trick, der einen
> Enable über mehrere Chains in **einem** Hash erlaubt. Verifiziere die Domain genau so (kein chainId-Feld
> hineininterpretieren).

**primaryType:** `MultiChainSession`

**types** (1:1 aus dem SDK):
```jsonc
{
  "PolicyData":      [ {"name":"policy","type":"address"}, {"name":"initData","type":"bytes"} ],
  "ActionData":      [ {"name":"actionTargetSelector","type":"bytes4"},
                       {"name":"actionTarget","type":"address"},
                       {"name":"actionPolicies","type":"PolicyData[]"} ],
  "ERC7739Context":  [ {"name":"appDomainSeparator","type":"bytes32"}, {"name":"contentName","type":"string[]"} ],
  "ERC7739Data":     [ {"name":"allowedERC7739Content","type":"ERC7739Context[]"},
                       {"name":"erc1271Policies","type":"PolicyData[]"} ],
  "SignedPermissions":[ {"name":"permitGenericPolicy","type":"bool"},
                        {"name":"permitAdminAccess","type":"bool"},
                        {"name":"ignoreSecurityAttestations","type":"bool"},
                        {"name":"permitERC4337Paymaster","type":"bool"},
                        {"name":"userOpPolicies","type":"PolicyData[]"},
                        {"name":"erc7739Policies","type":"ERC7739Data"},
                        {"name":"actions","type":"ActionData[]"} ],
  "SignedSession":   [ {"name":"account","type":"address"},
                       {"name":"permissions","type":"SignedPermissions"},
                       {"name":"sessionValidator","type":"address"},
                       {"name":"sessionValidatorInitData","type":"bytes"},
                       {"name":"salt","type":"bytes32"},
                       {"name":"smartSession","type":"address"},
                       {"name":"nonce","type":"uint256"} ],
  "ChainSession":    [ {"name":"chainId","type":"uint64"}, {"name":"session","type":"SignedSession"} ],
  "MultiChainSession":[ {"name":"sessionsAndChainIds","type":"ChainSession[]"} ]
}
```

`permissionId` (separat, für Registry/Lookup) — **rein offline**, hängt NUR an 3 Feldern:
```
permissionId = keccak256( abi.encode(address sessionValidator, bytes sessionValidatorInitData, bytes32 salt) )
```

---

## 2. Pinned-Konstanten / Domain pro Chain (PIN #3) — **client-seitig fest verdrahten**

| Konstante | Wert | Quelle |
|---|---|---|
| `smartSession` (Feld in `SignedSession`) | `0x00000000008bDABA73cD9815d79069c247Eb4bDA` | `SMART_SESSIONS_ADDRESS`, **gleich auf ETH+Base** (CREATE2-deterministisch) |
| `chainId` ETH-Mainnet | `1` | `ChainSession.chainId` (uint64) |
| `chainId` Base | `8453` | `ChainSession.chainId` (uint64) |
| `mode` (ENABLE) | `0x01` | `SmartSessionMode.ENABLE` (USE=0x00, UNSAFE_ENABLE=0x02) |

> ⚠️ **Diese baut Dev-2 als Code-Konstanten ein — NICHT vom Backend beziehen.** Käme die SmartSessions-
> Adresse oder die chainId vom Backend, könnte ein kompromittiertes Backend den Digest auf einen anderen
> Vertrag/Chain umlenken und die Verifikation wäre wertlos.

**`account`-SCA-Ableitung (PIN #3, der wichtigste):** Unter **EIP-7702 same-address** gilt die Invariante
`SCA-Adresse == Owner-EOA-Adresse` (= die SIWE-Identität). Es gibt **keine neue Adresse**. Dev-2 setzt
also `account = <on-device Owner-EOA>` — abgeleitet aus dem **Geräte-Key**, nie aus einer Backend-
Antwort. (Backend-Ref: `aa-trigger/src/userop.ts` → `sca7702Address(owner) = owner`.)

---

## 3. Referenz-Vektoren (PIN #2) — bekannte SessionConfig → erwarteter `digestToSign`

Fixe literale Inputs (alles unten ist im Vektor wörtlich gepinnt; `account` = bekannter Hardhat-acct0):
```
account                  = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
sessionValidator         = 0x0000000000000000000000000000000000000777
sessionValidatorInitData = 0x000000000000000000000000cafecafecafecafecafecafecafecafecafecafe
salt                     = 0x0000…0001
smartSession             = 0x00000000008bDABA73cD9815d79069c247Eb4bDA
nonce                    = 0
permitGenericPolicy = permitAdminAccess = ignoreSecurityAttestations = permitERC4337Paymaster = false
erc7739Policies = { allowedERC7739Content: [], erc1271Policies: [] }
```

**Vektor A — minimal** (`userOpPolicies: []`, `actions: []`): isoliert das reine Typed-Data-Encoding.
```
permissionId               = 0xb6fab81ecda7453b12cafad20272ddf52459013a0e78f92e1ee528313ec20553
digestToSign  chainId=1    = 0xc21b5f1771f70475cff1d6ee9a69a8e7575b984f7b31a009bf497a57ee4a62fc
digestToSign  chainId=8453 = 0x4e72e4786fd4b20eadd3211939947907da495ef97899faad30ce99801aa1f76b
```

**Vektor B — realistische DCA** (ein Spending-Limit-`userOpPolicy` + eine Swap-`action` mit Time-Frame-
Action-Policy). Zusätzliche literale Felder:
```
userOpPolicies = [ { policy: 0x0000…0511,
                     initData: 0x…a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48…0f4240 } ]   // USDC, cap 1_000_000
actions = [ { actionTargetSelector: 0x5ae401dc,                                          // multicall(uint256,bytes[])
              actionTarget:         0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45,          // UniV3 router (Beispiel)
              actionPolicies: [ { policy: 0x0000…0522,
                                  initData: 0x…683f9e80…687a4f00 } ] } ]                  // Time-Frame [start,end]
permissionId               = 0xb6fab81ecda7453b12cafad20272ddf52459013a0e78f92e1ee528313ec20553
digestToSign  chainId=1    = 0x4b7fe8e3ab2cf1929e70dda85aee35b48a005ce95a0d73a94f2221351ce62632
digestToSign  chainId=8453 = 0x612b0831cbca241f4726678f3f8a17db5de2eb6838447f416514b635331b9ddd
```
> `permissionId` ist in A==B identisch (hängt nur an sessionValidator/initData/salt — die hier gleich sind).
> `chainId` ändert den Digest (1 vs 8453 verschieden) → bestätigt die Chain-Bindung über `ChainSession.chainId`.

**Verifikations-Gate (im Script geprüft):** SDK-`hashChainSessions` == raw-viem-`hashTypedData(domain,types,…)`
für alle vier Digests **MATCH ✓** — d.h. die Typ-Tabelle in §1 ist genau die, die den Digest erzeugt.
Dev-2: Kotlin-`hashTypedData` über §1 + obige Literale muss exakt diese 4 Digests reproduzieren.

Reproduzieren: `cd aa-trigger && node scripts/enable-vector.mjs`.

---

## 3a. Production-Policy-Pins (PIN #4) — echte Rhinestone-Policy-Adressen für `verifyGrant`

Dev-2s `verifyGrant` pinnt, welche Policy-Contracts in einer Session erlaubt sind (gegen getauschte
Policies). Die echten, **vom SDK tatsächlich emittierten** Adressen (= das, was `getSpendingLimitsPolicy`/
`getTimeFramePolicy` als `PolicyData.policy` encoden — NICHT die Legacy-`constants.js`-Werte):

| Policy | Adresse | ETH (1) | Base (8453) |
|---|---|---|---|
| **Spending-Limits** | `0x000000000033212e272655d8a22402db819477a6` | code ✓ | code ✓ |
| **Time-Frame** | `0x0000000000D30f611fA3bf652ac6879428586930` | code ✓ | code ✓ |

**Chain-uniform — je EINE Konstante, KEINE `policyFor(chainId)`-Map.** Beide sind CREATE2-deterministisch
(wie `smartSession` `0x…4bDA`): **dieselbe Adresse trägt deployten Code auf ETH UND Base** (on-chain
verifiziert). Dev-2 trägt also je eine Konstante ein, gültig für beide Chains.

> ⚠️ **Gotcha:** `@rhinestone/module-sdk` enthält ZWEI Adress-Sätze — die Legacy-`policies/*/constants.js`
> (`0x00000088D48c…`/`0x81774515…`) und die `GLOBAL_CONSTANTS` (oben). **Emittiert wird der GLOBAL_CONSTANTS-
> Satz** (geprüft via dem `.policy`-Feld der Getter). Würde Dev-2 die `constants.js`-Werte pinnen, würde
> `verifyGrant` JEDE echte Session ablehnen. Vergleich case-insensitive (lowercase). Quelle: module-sdk 0.3.1,
> `GLOBAL_CONSTANTS.{SPENDING_LIMITS,TIME_FRAME}_POLICY_ADDRESS`. (Weitere bei Bedarf: UniversalAction
> `0x0000000000714Cf48FcF88A0bFBa70d313415032`, UsageLimit `0x00000000001d4479FA2A947026204d0283ceDe4B`,
> ValueLimit `0x000000000021dC45451291BCDfc9f0B46d6f0278`, Sudo `0x0000000000FEEc8D74e3143fBaBbca515358d869`.)

## 4. Schnittstelle Backend ↔ Dev-2 (Recompute-Vertrag)

1. Backend liefert das **Grant-Material** (SessionConfig §2 + `account` + `nonce` + chainId).
2. Dev-2 baut die `MultiChainSession`-Message aus diesem Material **+ seinen gepinnten Konstanten** (§2).
3. Dev-2 rechnet `digestToSign` per §1 lokal nach.
4. **Nur wenn** der nachgerechnete Digest == der zu signierende Digest → re-auth → raw-secp256k1-sign
   (`EvmKeyManager.sign(index0, digest)` → 65-Byte `r‖s‖v`, owner-bound, zeroize — wie AaSigner/UserOpSigner).
   Mismatch = fail-closed, **nicht** signieren.

Der Signatur-Primitiv ist identisch zum DCA-userOpHash-Pfad (eine raw-sign-Primitive über einen vom
Konstrukt gelieferten 32-Byte-Digest) — nur die *Digest-Konstruktion* ist hier Smart-Sessions-Enable
statt `hashMessage(userOpHash)`.
