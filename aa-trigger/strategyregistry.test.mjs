// KAN-164 strategy registry KAT — viewByFollower status filter + grant/revoke/pause lifecycle. No network.
//   node strategyregistry.test.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StrategySessionRegistry } from "./dist/strategyRegistry.js";

let fails = 0;
const ok = (c, m) => { if (c) console.log("  ✓", m); else { console.log("  ✗", m); fails++; } };

const ACC = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER = "0x1111111111111111111111111111111111111111";
const mkRec = (permissionId, account = ACC) => ({
  permissionId, sessionPublicKey: "0x489ccacAC8836C71Ad5B20Bf61e0b885425b227e", keychainAccount: "k-" + permissionId,
  account, chainId: 8453, budgetToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  caps: [{ token: "0x4200000000000000000000000000000000000006", capBaseUnits: "1000" }],
  router: "0x6fF5693b99212Da76ad316178A184AB56D299b43", windowStart: 0, windowEnd: 1893456000,
  salt: "0x" + "00".repeat(32),
});

const reg = new StrategySessionRegistry(join(mkdtempSync(join(tmpdir(), "cyppie-strat-")), "strategy-sessions.json"));

console.log("KAN-164: viewByFollower excludes prepared/revoked, scopes by account");
reg.recordPrepared(mkRec("0xaa")); // prepared → excluded
reg.recordPrepared(mkRec("0xbb")); reg.grant("0xbb"); // granted → included
reg.recordPrepared(mkRec("0xcc")); reg.grant("0xcc"); reg.revoke("0xcc"); // revoked → excluded
reg.recordPrepared(mkRec("0xdd", OTHER)); reg.grant("0xdd"); // other account → excluded
{
  const v = reg.viewByFollower(ACC);
  ok(v.length === 1 && v[0].permissionId === "0xbb", `only granted for this account (got ${v.map((x) => x.permissionId).join()})`);
  ok(v[0].status === "active", "granted+unpaused → active");
  ok(v[0].since > 0, "since = grantedAt");
  ok(v[0].caps.length === 1 && v[0].caps[0].capBaseUnits === "1000", "caps carried (capBaseUnits decimal string)");
}

console.log("KAN-164: pause → paused; case-insensitive account match");
reg.setPaused("0xbb", true);
{
  const v = reg.viewByFollower(ACC.toUpperCase());
  ok(v.length === 1 && v[0].status === "paused", "paused status + case-insensitive account");
}

console.log("KAN-164: revoke removes from the list (self-heal path)");
reg.revoke("0xbb");
ok(reg.viewByFollower(ACC).length === 0, "revoked → excluded");

console.log("KAN-164: persistence round-trips");
{
  const path = reg2Path();
  const r1 = new StrategySessionRegistry(path);
  r1.recordPrepared(mkRec("0xee")); r1.grant("0xee");
  const r2 = new StrategySessionRegistry(path); // reload from disk
  ok(r2.viewByFollower(ACC).length === 1 && r2.get("0xee")?.status === "granted", "reload sees granted session");
}

function reg2Path() { return join(mkdtempSync(join(tmpdir(), "cyppie-strat2-")), "strategy-sessions.json"); }

console.log(fails === 0 ? "\nALL PASS ✓" : `\n${fails} FAILED ✗`);
process.exit(fails === 0 ? 0 : 1);
