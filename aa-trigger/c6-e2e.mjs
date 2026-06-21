// C6 END-TO-END (PRD-06 / KAN-149), Base Sepolia — the copy money-path through the REAL server handler.
//   AA_ALLOW_TESTNET=1 RUN_SEND=1 node --env-file=../.env c6-e2e.mjs
//
// Proves: a real HMAC-signed Alchemy Address-Activity webhook → the production /v1/copy/webhook handler →
// HMAC-verify (fail-closed) → parse the followed source→router spend → fan out to the granted session → scale →
// SubmitGate → swapAdapter builds the mirror calls → submitMirror (USE-mode, backend session key) → a REAL
// sponsored on-chain mirror RECEIPT → record (Q7 + idempotency). Then the gate paths (idempotent replay,
// kill-switch) are exercised through the same handler.
//
// 🔑 Auth ≠ Custody: the mirror is signed ONLY by the backend-held, scoped/capped/revocable session key.
// Liquidity boundary (documented): a fresh sponsored testnet SCA has no DEX liquidity, so the RECEIPT leg uses a
// no-code test router (test-only adapter → a safe token.approve(0) call) — the real UniversalRouter swap-calldata
// bytes are KAT-proven in swapadapter.test.mjs. Enable is the owner-present setup (install + enableSessions),
// USE-mode mirrors after (ENABLE-mode-on-first-use = the documented fast-follow, see c6-enable-probe.mjs).
import { createPublicClient, http, encodeFunctionData, parseAbi, encodePacked, encodeAbiParameters, toHex } from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint07Address, createBundlerClient } from "viem/account-abstraction";
import { to7702KernelSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { createSmartAccountClient } from "permissionless";
import { getSmartSessionsValidator, getEnableSessionsAction, isSessionEnabled, getAccount, SMART_SESSIONS_ADDRESS } from "@rhinestone/module-sdk";
import { createHmac } from "node:crypto";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const apiKey = process.env.PIMLICO_API_KEY;
if (!apiKey) throw new Error("PIMLICO_API_KEY not set (node --env-file=../.env ...)");
const bundlerUrl = `https://api.pimlico.io/v2/base-sepolia/rpc?apikey=${apiKey}`;
const client = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com") });
let fails = 0; const ok = (c, m) => { if (c) console.log("  ✓", m); else { console.log("  ✗", m); fails++; } };

const WETH = "0x4200000000000000000000000000000000000006";
const DUMMY_ROUTER = "0x000000000000000000000000000000000000c0de"; // no code → test-only adapter (safe approve(0))
const SWAP_SELECTOR = "0x5ae401dc";
const SOURCE = "0x1111111111111111111111111111111111111111"; // the followed trader
const WEBHOOK_KEY = "whsec_c6_e2e";

// Isolate the registry + Keychain to this run. The server's defaultRegistry() reads CYPPIE_HOME, so we set it
// BEFORE importing server.js and write the granted session to the file first.
const home = mkdtempSync(join(tmpdir(), "cyppie-c6-"));
process.env.CYPPIE_HOME = home;
process.env.ALCHEMY_WEBHOOK_SIGNING_KEY = WEBHOOK_KEY;

const { CopySessionRegistry } = await import("./dist/copySession.js");
const regPath = join(home, "aa-trigger", "copy-sessions.json");
const reg = new CopySessionRegistry(regPath);

const owner = privateKeyToAccount(process.env.TEST_PRIVATE_KEY ?? generatePrivateKey());
console.log("follower owner EOA:", owner.address, "| CYPPIE_HOME:", home);

// 1) prepare: registry provisions the backend session key + assembles the enable (dummy router → 2-action shape).
const scope = {
  chainId: 84532, token: WETH, capTotalBudget: 10n ** 18n, router: DUMMY_ROUTER, selector: SWAP_SELECTOR,
  windowStart: 0, windowEnd: 1893456000, follower: owner.address, source: SOURCE,
  tokenOut: WETH, feeTier: 500, // copy-direction params (the test adapter ignores them for the safe call)
};
const inputs = reg.prepare(scope);
const permissionId = inputs.permissionId;
console.log("prepared permissionId:", permissionId, "| backend session key:", inputs.sessionPublicKey);

if (process.env.RUN_SEND !== "1") { console.log("\n[setup-only] set RUN_SEND=1 for the on-chain enable + webhook-driven mirror."); cleanup(); process.exit(0); }

// 2) on-chain enable (owner-present setup): 7702-delegate + install SmartSessions (+execute grant, hook=addr(1))
//    + enableSessions(the registry session). The owner's one-time grant; USE-mode mirrors follow.
const account = await to7702KernelSmartAccount({ client, owner, entryPoint: { address: entryPoint07Address, version: "0.7" }, version: "0.3.3" });
const mdAccount = getAccount({ address: account.address, type: "kernel" });
const installData = encodePacked(["address", "bytes"], ["0x0000000000000000000000000000000000000001",
  encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }, { type: "bytes" }], [getSmartSessionsValidator({}).initData ?? "0x", "0x", "0xe9ae5c53"])]);
const installCallData = encodeFunctionData({ abi: parseAbi(["function installModule(uint256 t, address m, bytes d)"]), args: [1n, SMART_SESSIONS_ADDRESS, installData] });
const session = { sessionValidator: inputs.sessionValidator, sessionValidatorInitData: inputs.sessionValidatorInitData, salt: inputs.salt,
  userOpPolicies: inputs.userOpPolicies, erc7739Policies: inputs.erc7739Policies, actions: inputs.actions, permitERC4337Paymaster: true };
const enableAction = getEnableSessionsAction({ sessions: [session] });
const pimlico = createPimlicoClient({ transport: http(bundlerUrl) });
const sac = createSmartAccountClient({ account, chain: baseSepolia, bundlerTransport: http(bundlerUrl), paymaster: pimlico,
  paymasterContext: { sponsorshipPolicyId: process.env.PIMLICO_SPONSORSHIP_POLICY_ID ?? "sp_next_micromax" },
  userOperation: { estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast } });
const authNonce = await client.getTransactionCount({ address: owner.address });
const authorization = await owner.signAuthorization({ contractAddress: account.authorization.address, chainId: baseSepolia.id, nonce: authNonce });
console.log("\n[enable] install + enableSessions (owner-signed one-time grant)…");
const eH = await sac.sendUserOperation({ calls: [{ to: account.address, value: 0n, data: installCallData }, { to: enableAction.to, value: 0n, data: enableAction.callData }], authorization });
const eR = await sac.waitForUserOperationReceipt({ hash: eH });
ok(eR.success, `enable receipt ${eR.receipt.transactionHash}`);
let enabled = false; for (let i = 0; i < 12 && !enabled; i++) { enabled = await isSessionEnabled({ client, account: mdAccount, permissionId }); if (!enabled) await new Promise((r) => setTimeout(r, 3000)); }
ok(enabled, "isSessionEnabled");

// 3) grant (USE-mode: the registry marks granted; enableSig unused for USE).
reg.grant(permissionId, "0x01");

// 4) import the REAL server handler (reads the granted session from CYPPIE_HOME) + register the test router.
const { handle } = await import("./dist/server.js");
const { __registerTestAdapter, APPROVE_SELECTOR, UNIVERSAL_ROUTER_EXECUTE_SELECTOR } = await import("./dist/swapAdapter.js");
const { __allowTestRouter } = await import("./dist/copyWebhook.js");
__allowTestRouter(84532, DUMMY_ROUTER);
// Test adapter: a no-liquidity-safe mirror = a single WETH.approve(dead, 0); requiredActions matches the
// 2-action enabled scope (token.approve cap + dummy swap window).
__registerTestAdapter(DUMMY_ROUTER, {
  buildMirrorCalls: () => [{ to: WETH, value: 0n, data: encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), args: ["0x000000000000000000000000000000000000dEaD", 0n] }) }],
  requiredActions: ({ token, router }) => [
    { actionTarget: token, actionTargetSelector: APPROVE_SELECTOR, policy: "cap" },
    { actionTarget: router, actionTargetSelector: SWAP_SELECTOR, policy: "window" },
  ],
});

// 5) POST a real HMAC-signed Alchemy webhook → the production handler → mirror RECEIPT.
const bundler = createBundlerClient({ chain: baseSepolia, transport: http(bundlerUrl) });
async function postWebhook(activity) {
  const body = JSON.stringify({ event: { network: "BASE_SEPOLIA", activity } });
  const sigHex = createHmac("sha256", WEBHOOK_KEY).update(body, "utf8").digest("hex");
  return invoke("POST", "/v1/copy/webhook", body, { "x-alchemy-signature": sigHex });
}
const spend1 = { category: "token", fromAddress: SOURCE, toAddress: DUMMY_ROUTER, hash: "0xc6source1", rawContract: { address: WETH, rawValue: toHex(10n ** 17n) } };

console.log("\n[webhook] HMAC-signed Address-Activity → production handler…");
const r1 = await postWebhook([spend1]);
ok(r1.status === 200, `webhook 200 (got ${r1.status})`);
ok(r1.body.detected === 1, `detected 1 spend (got ${r1.body.detected})`);
const m = r1.body.mirrors?.[0];
ok(m?.status === "submitted", `mirror submitted (status=${m?.status} reason=${m?.reason ?? ""})`);
ok(!!m?.userOpHash, `userOpHash returned: ${m?.userOpHash}`);
if (m?.userOpHash) {
  const mr = await bundler.waitForUserOperationReceipt({ hash: m.userOpHash });
  ok(mr.success, `MIRROR RECEIPT ${mr.receipt.transactionHash} (blk ${mr.receipt.blockNumber}) success=${mr.success}`);
}

// 6) HMAC fail-closed + idempotency + kill-switch through the same handler.
console.log("\n[webhook] security + gate paths:");
const badSig = await invoke("POST", "/v1/copy/webhook", JSON.stringify({ event: { network: "BASE_SEPOLIA", activity: [spend1] } }), { "x-alchemy-signature": "deadbeef" });
ok(badSig.status === 401, `bad HMAC → 401 (got ${badSig.status})`);

const r2 = await postWebhook([spend1]); // same sourceTxHash → idempotent (already mirrored)
ok(r2.body.mirrors?.[0]?.status === "gated", `idempotent replay gated (status=${r2.body.mirrors?.[0]?.status})`);

// P1-2 (KAN-156): a spend on a token NOT in the session scope (here USDC, scope.token=WETH) → skipped BEFORE any
// submit (no sponsored gas-drain on a guaranteed-revert op). Router still DUMMY (allowlisted) + same source.
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const offScope = { category: "token", fromAddress: SOURCE, toAddress: DUMMY_ROUTER, hash: "0xc6offscope", rawContract: { address: USDC_BASE, rawValue: toHex(10n ** 17n) } };
const rP12 = await postWebhook([offScope]);
ok(rP12.body.mirrors?.[0]?.status === "skipped" && /scope/.test(rP12.body.mirrors?.[0]?.reason ?? ""), `P1-2: off-scope token skipped (no submit): ${rP12.body.mirrors?.[0]?.reason}`);

// P1-3 (KAN-156): /v1/session/trigger rejects calls that target a NON-enabled (target,selector) — the session
// key never signs arbitrary calls. A random target/selector → 400 (loopback BadRequest).
const rP13 = await invoke("POST", "/v1/session/trigger", JSON.stringify({ permissionId, sourceTxHash: "0xc6trig", calls: [{ to: "0x000000000000000000000000000000000000dEaD", data: "0xdeadbeef" }] }), {});
ok(rP13.status === 400 && /not in the session's enabled action set/.test(rP13.body?.error ?? ""), `P1-3: trigger rejects un-enabled call → 400 (${rP13.body?.error})`);

await invoke("POST", "/v1/copy/session/pause", JSON.stringify({ permissionId }), {});
const r3 = await postWebhook([{ ...spend1, hash: "0xc6source2" }]); // new source → but kill-switch on
// Kill-switch: a paused session is excluded from the fan-out (findBySource skips paused) AND would be re-gated by
// assertMirrorable — so NO mirror is submitted (the spend is still detected).
ok(r3.body.detected === 1 && !(r3.body.mirrors ?? []).some((x) => x.status === "submitted"), `kill-switch → no mirror submitted (mirrors=${JSON.stringify(r3.body.mirrors)})`);

console.log("\n================ C6 E2E (webhook → mirror receipt) ================");
console.log("enable (install+enableSessions) tx:", eR.receipt.transactionHash);
console.log("webhook-driven mirror userOpHash  :", m?.userOpHash);
console.log("===================================================================");
cleanup();
console.log(fails === 0 ? "\nC6 E2E ALL PASS ✓" : `\n${fails} FAILED ✗`);
process.exit(fails === 0 ? 0 : 1);

// ── minimal in-process req/res shim for the real `handle` (mirrors server.ts's createServer error mapping) ──
function invoke(method, url, body, headers) {
  const req = makeReq(method, url, body, headers);
  return new Promise((resolve) => {
    const res = makeRes(resolve);
    handle(req, res).catch((e) => {
      const code = e?.constructor?.name === "GateError" ? 409 : e?.constructor?.name === "BadRequest" ? 400 : 500;
      res.writeHead(code, {}); res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    });
  });
}
function makeReq(method, url, body, headers) {
  const chunks = body ? [Buffer.from(body, "utf8")] : [];
  const req = { method, url, headers: headers ?? {}, [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; } };
  return req;
}
function makeRes(resolve) {
  let code = 200; const out = [];
  return { writeHead(c) { code = c; }, end(s) { if (s) out.push(s); let parsed; try { parsed = JSON.parse(out.join("")); } catch { parsed = out.join(""); } resolve({ status: code, body: parsed }); } };
}
function cleanup() {
  try { const r = reg.get(permissionId); if (r) execFileSync("security", ["delete-generic-password", "-s", "cyppie-copy-session", "-a", r.keychainAccount]); } catch {}
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}
