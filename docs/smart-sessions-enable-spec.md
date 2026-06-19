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
**Vektor C — DCA SPONSORED** (identisch zu B, aber **`permitERC4337Paymaster = true`**) = der **echte
DCA-Enable** (Pimlico-Sponsoring). Das ist der zu pinnende Real-Vektor:
```
permitERC4337Paymaster     = true              // erc7739Policies weiterhin { [], [] }
permissionId               = 0xb6fab81ecda7453b12cafad20272ddf52459013a0e78f92e1ee528313ec20553
digestToSign  chainId=1    = 0x3829dee4858a5943584350f109b100cd6e8a6c1a17bc94fcf45d0357bc0c4d39
digestToSign  chainId=8453 = 0xe85a3ea587b69870b1584e165e4b700d6e5c89fd0ddf2e56e56a4ecc31ebe320
```
> `permissionId` ist in A==B==C identisch (hängt nur an sessionValidator/initData/salt — die hier gleich sind).
> `chainId` ändert den Digest (1 vs 8453 verschieden) → bestätigt die Chain-Bindung über `ChainSession.chainId`.
> **B vs C verschieden** (`0x4b7fe8e3…` vs `0x3829dee4…`) → der `permitERC4337Paymaster`-Flip ändert den Digest
> ⇒ dieses Feld **muss** im disclosed Material stehen + gemappt werden, sonst weicht der Recompute ab.

### ⚠️ MED-2: die zwei `SignedPermissions`-Felder `permitERC4337Paymaster` + `erc7739Policies`

Beide sind **Pflichtfelder** des `Session`-Typs (`@rhinestone/module-sdk`, **kein SDK-Default**) und gehen
**in den signierten Digest** ein. Defaultet die App sie (false / leer), während das Backend andere Werte
encodet, **weicht der Recompute ab → `verifyGrant` lehnt JEDEN ehrlichen Grant ab.** Daher:

1. **Disclosure-Pflicht:** das Grant-Material **muss beide Felder explizit liefern** — `toSigned()` mappt
   sie aus dem disclosed Material, defaultet sie **nie**.
2. **Kanonische DCA-Werte:**
   - **`permitERC4337Paymaster = true`** — DCA-Ops sind **Pimlico-gesponsert**; die Session **muss** den
     ERC-4337-Paymaster erlauben, sonst wird der gesponserte UserOp bei der Session-Validierung abgelehnt
     (Rhinestone Smart Sessions, ERC-4337+Pimlico bestätigt via Context7).
   - **`erc7739Policies = { allowedERC7739Content: [], erc1271Policies: [] }`** (leer) — DCA nutzt **kein**
     ERC-1271/ERC-7739-Content-Signing in der Session. (Leere Tuple-Arrays, NICHT weglassen — das Feld ist
     Teil des Hash-Encodings.)
3. **Pin-Vektor:** Vektor **C** oben (paymaster=true, erc7739 leer) — Dev-1/Dev-2 müssen genau diese 2
   Digests reproduzieren.

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

## 3c. Session-Validator + initData + Nonce-Getter (PIN #5) — für Dev-1s app-gebauten Enable

Die DCA-Session autorisiert den **on-device Owner-Key** (`deriveAddress(0)` = SCA = SIWE-Identität, 7702
same-address). Validator = Rhinestone **OwnableValidator** (ECDSA, threshold-1-single-owner):

| Feld | Wert |
|---|---|
| **`sessionValidator`** (OwnableValidator, gepinnt ETH+Base) | `0x000000000013fdB5234E4E3162a810F54d9f7E98` (on-chain code ✓ ETH+Base, CREATE2-uniform) |
| **`sessionValidatorInitData`-Layout** | **`abi.encode(uint256 threshold, address[] owners)`** — **NICHT** raw-20B, **nicht** bloß left-padded-Adresse |

initData für DCA (threshold=1, owners=[owner]) = **vier 32-Byte-Worte**:
```
0x 0000…0001                                                        // threshold = 1               (uint256)
   0000…0040                                                        // offset zu owners[] = 0x40    (uint256)
   0000…0001                                                        // owners.length = 1           (uint256)
   000000000000000000000000<owner 20B>                              // owner, left-padded auf 32B  (address)
```
Beispiel owner=acct0 `0xf39F…2266` → `0x…0001 …0040 …0001 000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266`.

> ⚠️ **Gleicher Zwei-Adressen-Gotcha wie bei den Policies:** **emittiert** wird `getOwnableValidator().address`
> = `GLOBAL_CONSTANTS.OWNABLE_VALIDATOR_ADDRESS` = `0x…7E98` — **NICHT** der Top-Level-Export
> `OWNABLE_VALIDATOR_ADDRESS` (`0x2483DA3A…Bf06` = Legacy). Dev-1 pinnt die `0x…7E98`.

**Nonce-Getter** (read-only, über den Key-Proxy-RPC) — der `nonce` im Enable-Digest kommt hier her:
```
getNonce(bytes32 permissionId, address account) -> uint256
  Contract = SmartSession-Modul  0x00000000008bDABA73cD9815d79069c247Eb4bDA   (= das smartSession-Feld)
  Selector = 0x795f9269   |   stateMutability = view
  permissionId = keccak256(abi.encode(sessionValidator, sessionValidatorInitData, salt))
  (live verifiziert: nie-enabled account → 0)
```

### Vektor D — REAL DCA-Pin (alles echt: OwnableValidator + GLOBAL_CONSTANTS-Policies + paymaster=true)

**Der byte-exakte Pin** für Dev-1s app-gebauten Enable (A/B/C oben nutzten Platzhalter-Validator/-Policies
zur Encoding-Illustration). `salt` ist app-gewählt (hier `0x…0001`), `nonce=0` (frische Session):
```
account                   = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266   (= owner, 7702 same-address)
sessionValidator          = 0x000000000013fdB5234E4E3162a810F54d9f7E98   (OwnableValidator)
sessionValidatorInitData  = 0x0000…0001 0000…0040 0000…0001 …f39f…2266   (abi.encode(1,[owner]))
userOpPolicies[0].policy  = 0x000000000033212e272655d8a22402db819477a6   (SpendingLimits)
actions[0].actionPolicies[0].policy = 0x0000000000D30f611fA3bf652ac6879428586930   (TimeFrame)
permitERC4337Paymaster    = true   |   erc7739Policies = { [], [] }   |   salt = 0x…0001   |   nonce = 0
permissionId              = 0x82bc397553fc6577974c762cd42958d860cd838a55f55f245ee5f6debab698b0
digestToSign  chainId=1    = 0xba3ebab8845eff4c0f5c2871bdccaecb934b9909049bd36d776386a0390a133a
digestToSign  chainId=8453 = 0xb45d0bc89f3abd41006eab254dccc8e5d9e206a3e3c180da16dfafb719191ca8
```
> SDK `hashChainSessions` == raw-viem `hashTypedData` über die §1-Typtabelle → **MATCH ✓** (beide Chains).
> Dev-1s app-gebaute Konstruktion muss mit seinem **eigenen** `salt`/`nonce` denselben Encoding-Pfad treffen;
> mit den obigen literalen `salt=0x…0001`/`nonce=0` muss er exakt diese zwei Digests reproduzieren.

## 3d. ⚠️ N3: Spending-Limit-Cap-Semantik = **KUMULATIV** (`cap = Gesamt-Budget`, nicht per-Buy)

Die Rhinestone **Spending-Limit-Policy erzwingt den `cap` KUMULATIV** — den **Gesamtbetrag über alle
Uses der Session** (depletierend, **kein** on-chain-Fenster/Reset). **Zwei Quellen, bestätigt:**
- **On-chain-ABI:** `getPolicyData(...)` liefert `spendingLimit` **+ `alreadySpent`** (laufender Akkumulator)
  + `approvedAmount` — **kein** Timestamp/Window-Feld ⇒ kumulativ, kein Reset.
- **Rhinestone-Docs** (Context7): „caps the **cumulative amount** transferable **across all uses** of that
  function within the session".

**Konsequenzen (ADR-0024-relevant):**
1. **Exposure pro Token = `cap` → on-chain GEBUNDEN ✓** — „Worst-Case = der Cap" hält **pro Session/Token**.
2. **`cap = Betrag-pro-Buy` ist FALSCH** — die Session wäre nach **einem** Buy erschöpft (DCA bricht).
   ⇒ **`cap` MUSS das Gesamt-Budget sein = `perBuy × Anzahl-Buys`** (das Gesamt-Commitment des Users über
   die Session). **Disclosure muss das als Gesamt-Budget zeigen** (nicht „pro Buy"), damit der signierte
   on-chain-Bound == dem konsentierten Betrag ist.
3. **`rollingWindowSeconds` + `usageLimit` sind NICHT in dieser Policy / nicht im Digest** — die Spending-
   Limit-Policy hat **kein Zeitfenster**. Ein „max X pro rollierende Woche" ist **NICHT on-chain** (nur
   Backend-Accounting). On-chain-Garantie = rein: kumulativer Total ≤ cap über die Session-Lebenszeit.
4. **Op-Anzahl on-chain bounden** (optional): die **Usage-Limit-Policy** (`USAGE_LIMIT_POLICY_ADDRESS`
   `0x00000000001d4479FA2A947026204d0283ceDe4B`, `initData = encodePacked(uint128 limit)`) begrenzt die
   **Zahl** der Calls. Ohne sie ist die Op-Anzahl unbeschränkt — der **Token-Total** bleibt aber via (1) gecappt.

**Q7-`totalExposureCap` — on-chain oder Backend?**
- **Pro einzelner DCA-Session:** der Token-Total ist via Spending-Limit-Policy **on-chain gebunden** (cap).
- **Über MEHRERE Session-Keys eines Users aggregiert** (= Q7): **kein** Off-the-shelf-Policy erzwingt das —
  jede Policy bindet nur ihre eigene Session. Der **Cross-Session-Aggregat-Cap ist Backend-Accounting
  (rest-trust)**.
- **Merge-Gate-Empfehlung:** Ein **einzelner** DCA-Enable braucht **keinen** zusätzlichen on-chain-Total-Cap
  — die kumulative Spending-Limit-Policy liefert ihn bereits, **vorausgesetzt `cap = Gesamt-Budget`** (Punkt 2,
  der eigentliche Fix). Der **Cross-Session-Q7-Aggregat** bleibt Backend (rest-trust, konsistent mit ADR-0024-
  Harm-Reduction, solange jede Session einzeln on-chain gecappt ist). Ein echter on-chain-Aggregat über
  Sessions bräuchte eine Shared-State-Policy (nicht off-the-shelf) → separat, falls das Produkt es verlangt.

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
