// KAN-164 (B) deriveSellCaps KAT — the single-source per-token Sell-Cap formula + the enable/clamp helpers. No network.
//   node strategycaps.test.mjs
import { getAddress } from "viem";
import { deriveSellCaps, sellCapsToScopeLegs, sellCapsToClampMap, TURNOVER_DEFAULT } from "./dist/strategyCaps.js";

let fails = 0;
const ok = (c, m) => { if (c) console.log("  ✓", m); else { console.log("  ✗", m); fails++; } };

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // budget token
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
const capOf = (caps, t) => caps.find((c) => c.token.toLowerCase() === t.toLowerCase())?.capBaseUnits;

console.log("KAN-164(B): default turnover = 2");
ok(TURNOVER_DEFAULT === 2, "TURNOVER_DEFAULT == 2");

console.log("KAN-164(B): deriveSellCaps — formula cap_i = ceil(budget × w_i × turnover / price_i)");
{
  const intent = { budgetToken: USDC, budget: 10000n, basket: [{ token: WETH, weightBps: 5000 }, { token: WBTC, weightBps: 5000 }] };
  const quotes = [{ token: WETH, amountIn: 100n, amountOut: 200n }, { token: WBTC, amountIn: 100n, amountOut: 50n }];
  const caps = deriveSellCaps(intent, quotes, 2);
  ok(caps.length === 3, `3 caps = 2 basket + budget token (got ${caps.length})`);
  // cap_WETH = 10000*5000*2*100/(10000*200) = 5000
  ok(capOf(caps, WETH) === "5000", `WETH cap 5000 (got ${capOf(caps, WETH)})`);
  // cap_WBTC = 10000*5000*2*100/(10000*50) = 20000
  ok(capOf(caps, WBTC) === "20000", `WBTC cap 20000 (got ${capOf(caps, WBTC)})`);
  // budget token cap = budget × turnover = 20000 (the source — full budget can rotate out)
  ok(capOf(caps, USDC) === "20000", `USDC (budget) cap = budget×turnover = 20000 (got ${capOf(caps, USDC)})`);
  // ≈value disclosure (FR-9): basket value = budget×weight×turnover/10000 = 10000; budget token value = budget×turnover.
  const valOf = (t) => caps.find((c) => c.token.toLowerCase() === t.toLowerCase())?.valueSnapshotBaseUnits;
  ok(valOf(WETH) === "10000" && valOf(WBTC) === "10000", `basket ≈value = 10000 (WETH ${valOf(WETH)}, WBTC ${valOf(WBTC)})`);
  ok(valOf(USDC) === "20000", `budget-token ≈value = budget×turnover = 20000 (got ${valOf(USDC)})`);
  // canonical address order: WBTC(0x2260) < USDC(0xA0b8) < WETH(0xC02a)
  ok(caps.map((c) => c.token.toLowerCase()).join() === [WBTC, USDC, WETH].map((a) => a.toLowerCase()).join(), "canonical address order");
}

console.log("KAN-164(B): conservative ceil (round UP, never below the intended max sell)");
{
  // 10001*5000*1*3/(10000*10) = 1500.15 → ceil 1501
  const caps = deriveSellCaps({ budgetToken: USDC, budget: 10001n, basket: [{ token: WETH, weightBps: 5000 }] }, [{ token: WETH, amountIn: 3n, amountOut: 10n }], 1);
  ok(capOf(caps, WETH) === "1501", `ceil(1500.15) = 1501 (got ${capOf(caps, WETH)})`);
}

console.log("KAN-164(B): budget token also a basket member → source cap (budget×turnover) wins");
{
  const caps = deriveSellCaps({ budgetToken: USDC, budget: 1000n, basket: [{ token: USDC, weightBps: 5000 }] }, [{ token: USDC, amountIn: 1n, amountOut: 1n }], 2);
  ok(caps.length === 1 && capOf(caps, USDC) === "2000", `USDC cap = max(basket, budget×turnover) = 2000 (got ${capOf(caps, USDC)})`);
}

console.log("KAN-164(B): weight 0 skipped; turnover default");
{
  const caps = deriveSellCaps({ budgetToken: USDC, budget: 1000n, basket: [{ token: WETH, weightBps: 0 }] }, []);
  ok(caps.length === 1 && capOf(caps, USDC) === "2000", `only budget cap, default turnover 2 → 2000 (got ${JSON.stringify(caps)})`);
}

console.log("KAN-164(B): guards");
{
  let threw = false; try { deriveSellCaps({ budgetToken: USDC, budget: 0n, basket: [] }, []); } catch { threw = true; }
  ok(threw, "budget 0 rejected");
  threw = false; try { deriveSellCaps({ budgetToken: USDC, budget: 1n, basket: [{ token: WETH, weightBps: 5000 }] }, [{ token: WETH, amountIn: 1n, amountOut: 0n }], 2); } catch { threw = true; }
  ok(threw, "dead quote (amountOut 0) rejected");
  threw = false; try { deriveSellCaps({ budgetToken: USDC, budget: 1n, basket: [{ token: WETH, weightBps: 5000 }] }, [], 2); } catch { threw = true; }
  ok(threw, "missing price snapshot rejected");
}

console.log("KAN-164(B): single-source helpers — same caps feed enable legs AND rebalance clamp");
{
  const caps = deriveSellCaps({ budgetToken: USDC, budget: 10000n, basket: [{ token: WETH, weightBps: 5000 }] }, [{ token: WETH, amountIn: 100n, amountOut: 200n }], 2);
  const legs = sellCapsToScopeLegs(caps);
  ok(legs.length === caps.length && legs.every((l) => typeof l.cap === "bigint"), "sellCapsToScopeLegs → {token, cap:bigint}[] (enable side)");
  ok(legs.find((l) => l.token.toLowerCase() === WETH.toLowerCase())?.cap === 5000n, "leg cap == derived cap (bigint)");
  const clamp = sellCapsToClampMap(caps);
  ok(clamp.get(WETH.toLowerCase()) === 5000n && clamp.get(USDC.toLowerCase()) === 20000n, "sellCapsToClampMap → lower-cased token→cap (execution side)");
}

console.log(fails === 0 ? "\nALL PASS ✓" : `\n${fails} FAILED ✗`);
process.exit(fails === 0 ? 0 : 1);
