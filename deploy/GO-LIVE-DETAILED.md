# Go-Live (detailliert) — `cyppie.com`, Schwerpunkt **Secrets**

Ergänzt `GO-LIVE-cyppie.md` um die **genaue Secret-Handhabung**: was du dir ausdenken musst, was schon
existiert, **wie** du jedes Secret generierst, **wo genau** es auf dem Mac Mini liegt und **wie der Service
es liest**. 🔒 In diesem Dokument steht **kein einziger echter Secret-Wert** — nur Platzhalter.

> Annahme: DNS (`api.cyppie.com` + `auth.cyppie.com` → Mac-Mini-IP) ist ✅ propagiert
> (`dig +short api.cyppie.com` zeigt deine IP), Ports 80+443 ans Mac Mini geforwardet.

---

## 1. Secret-Inventar — was du brauchst

**Auth ≠ Custody:** dieser Stack hält **nur Plattform-Identität** (Postgres + Keycloak). Wallet-Seeds/
Keys liegen **ausschließlich auf dem Gerät** — kein Secret hier berührt je einen Nutzer-Schlüssel.

| Secret | Herkunft | Generieren mit | Liegt wo (Mac Mini) | Wie der Service es liest |
|---|---|---|---|---|
| **POSTGRES_PASSWORD** | 🆕 **selbst erfinden** | `openssl rand -hex 32` | `~/cyppie-secrets.env` (chmod 600) | `bootstrap.sh` legt damit die DB-Rolle `cyppie` an **und** rendert ihn in die launchd-Plists: KC → `KC_DB_PASSWORD`, User-Service → `CYPPIE_DB_PASSWORD` |
| **KC_ADMIN_PASSWORD** | 🆕 **selbst erfinden** | `openssl rand -hex 24` | `~/cyppie-secrets.env` (chmod 600) | gerendert in `com.cyppie.keycloak.plist` → `KC_BOOTSTRAP_ADMIN_PASSWORD`. **Nach dem 1. Admin-Login rotieren** (siehe §5) |
| **PIMLICO_API_KEY** | ✅ **existiert schon** (Pimlico-Dashboard, liegt aktuell in `./Backend/.env`) | — nur referenzieren — | `~/cyppie-secrets.env` (chmod 600) | gerendert in `com.cyppie.aa-trigger.plist` → `PIMLICO_API_KEY` (nur wenn gesetzt; sonst wird aa-trigger übersprungen) |
| **alchemyApiKey** | ✅ **existiert schon** (Key-Proxy, ADR-0021) | — nur referenzieren — | `~/.gradle/gradle.properties` *(unverändert, wo der Key-Proxy ihn schon liest)* | `:server` Key-Proxy liest `alchemyApiKey` / `$ALCHEMY_API_KEY` |

**Nicht-Secrets (Klartext-Config, KEINE Geheimnisse):** `KC_HOSTNAME=https://auth.cyppie.com`,
`KC_ADMIN=admin` (Benutzername), `POSTGRES_USER=cyppie`, `PIMLICO_SPONSORSHIP_POLICY_ID=sp_next_micromax`
(nur für Mainnet-Gas-Sponsoring relevant; hat einen Default). **`AA_ALLOW_TESTNET` in Prod NICHT setzen**
(Base Sepolia bleibt aus — Prod = ETH + Base).

> Genau **zwei** Secrets erfindest du frisch (POSTGRES_PASSWORD, KC_ADMIN_PASSWORD); die anderen zwei
> existieren bereits und werden nur referenziert.

---

## 2. Wo ablegen — **eine** klare Empfehlung

**Ein gitignored Secrets-File `~/cyppie-secrets.env`, `chmod 600`, das du vor `bootstrap.sh` sourcest.**
Liegt im Home des Deploy-Users, **außerhalb** des Repos — kommt **nie** in git. `bootstrap.sh` rendert die
Werte dann in die launchd-Plists unter `~/Library/LaunchAgents` (die das Skript automatisch `chmod 600`
setzt). Danach lesen die Services aus ihren Plists — das Secrets-File wird zur Laufzeit nicht mehr gebraucht.

```bash
# Einmalig anlegen (Werte ersetzen; die rand-Befehle erzeugen frische Geheimnisse):
umask 077                                  # neue Datei sofort nur für dich lesbar
cat > ~/cyppie-secrets.env <<EOF
export POSTGRES_PASSWORD='$(openssl rand -hex 32)'
export KC_ADMIN_PASSWORD='$(openssl rand -hex 24)'
export PIMLICO_API_KEY='<DEIN_EXISTIERENDER_PIMLICO_KEY>'
export KC_HOSTNAME='https://auth.cyppie.com'
EOF
chmod 600 ~/cyppie-secrets.env
```

Regeln: **nie ins Repo** (`~` liegt außerhalb des Projektordners — automatisch sicher). Datei-Rechte
`600` (nur dein User). Der `alchemyApiKey` bleibt, wo er ist (`~/.gradle/gradle.properties`) — nicht
duplizieren. Kein Secret landet je in einem committeten File.

> Alternativen (bewusst NICHT empfohlen): Secrets direkt im Shell-Profil (`.zshrc`) — vermischt sich mit
> interaktiven Sessions; oder von Hand in jede Plist — fehleranfällig. Das eine gesourcte `600`-File ist
> am saubersten und passt exakt zu `bootstrap.sh`.

---

## 3. Deploy — Schritt für Schritt (copy-paste)

```bash
# (0) Secrets in die aktuelle Shell laden (Werte aus §2):
source ~/cyppie-secrets.env

# (1) Plattform-Backend turnkey hochziehen (idempotent — gefahrlos wiederholbar).
#     Baut/installiert Postgres + Keycloak(+SIWE, :8082) + User-Service(:8081) [+ aa-trigger(:8090),
#     wenn PIMLICO_API_KEY gesetzt], importiert das Realm, deaktiviert VERIFY_PROFILE und schließt den
#     generischen ROPC (admin-cli). Secrets kommen aus der Umgebung, nichts wird ins Repo geschrieben.
cd ~/cyppie-backend            # = dein Backend-Repo-Checkout
./deploy/bootstrap.sh

# (2) Caddy: die zwei Host-Blöcke aus GO-LIVE-cyppie.md §3 in die Oakhost-Caddyfile mergen, dann:
caddy reload --config /opt/homebrew/etc/Caddyfile     # oder: brew services restart caddy

# (3) Verifizieren — lokal + öffentlich:
./deploy/healthcheck.sh                                          # postgres, realm, SIWE-nonce, /v1/me 401, aa-trigger
curl -s https://auth.cyppie.com/realms/cyppie/siwe/nonce         # öffentlich → {"nonce":...}
curl -s -o /dev/null -w '%{http_code}\n' https://auth.cyppie.com/v1/me   # → 401 (fail-closed)
curl -s https://api.cyppie.com/healthz                           # Key-Proxy up
```

Wenn `healthcheck.sh` „All checks passed." zeigt und der öffentliche SIWE-Nonce-Call ein `{"nonce":…}`
liefert, steht das Backend. (`aa-trigger` erscheint im Healthcheck nur, wenn `PIMLICO_API_KEY` gesetzt war.)

---

## 4. Was wohin gerendert wird (zur Kontrolle)

`bootstrap.sh` schreibt die Secrets aus der Umgebung in drei `chmod 600`-Plists — du kannst es prüfen
(zeigt die **Keys**, nicht zwingend die Werte): `ls -l@ ~/Library/LaunchAgents/com.cyppie.*.plist`

- `com.cyppie.keycloak.plist` → `KC_DB_USERNAME`, `KC_DB_PASSWORD` (= POSTGRES_PASSWORD),
  `KC_BOOTSTRAP_ADMIN_USERNAME`, `KC_BOOTSTRAP_ADMIN_PASSWORD` (= KC_ADMIN_PASSWORD), `KC_HOSTNAME`.
- `com.cyppie.user-service.plist` → `CYPPIE_DB_USER`, `CYPPIE_DB_PASSWORD` (= POSTGRES_PASSWORD).
- `com.cyppie.aa-trigger.plist` → `PIMLICO_API_KEY` (nur wenn gesetzt).

---

## 5. Direkt nach Go-Live (Pflicht)

1. **Keycloak-Bootstrap-Admin rotieren:** auf `https://auth.cyppie.com/admin` mit `admin` /
   `KC_ADMIN_PASSWORD` einloggen → einen **namentlichen** Admin anlegen → das Bootstrap-`admin`-Passwort
   ändern (oder den Bootstrap-Admin deaktivieren). Danach `KC_ADMIN_PASSWORD` aus `~/cyppie-secrets.env`
   entfernen (wurde nur für den 1. Start gebraucht).
2. **Secrets-File-Hygiene:** `~/cyppie-secrets.env` bleibt `chmod 600`; nach erfolgreichem Deploy kannst du
   es archivieren/löschen — die Laufzeit-Secrets liegen in den `600`-Plists. (Bei Re-Deploy wieder anlegen.)
3. **Cert-Renewal:** Caddy erneuert beide Zertifikate automatisch — nach ~60 Tagen Logs prüfen.
4. **Monitoring:** `https://api.cyppie.com/healthz` + `https://auth.cyppie.com/health` (Single Mac Mini =
   ein Punkt, ADR-0022; Clients degradieren bei Ausfall auf `Approximate`/stale, FR-4 — kein Crash).

## 6. Rollback

`launchctl unload ~/Library/LaunchAgents/com.cyppie.{keycloak,user-service,aa-trigger}.plist` stoppt den
08/05-Stack; der Key-Proxy (`api.cyppie.com`) ist unabhängig und serviert weiter. Den `auth.cyppie.com`-
Block aus der Caddyfile nehmen + `caddy reload` nimmt Auth offline, lässt den Proxy laufen.
