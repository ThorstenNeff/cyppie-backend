// DCA orchestration e2e helper (KAN-163) — poll the bundler receipt for a submitted userOpHash.
//   node scripts/e2e-receipt.mjs <chainId> <userOpHash>   → prints {success, transactionHash, blockNumber}
import { createBundlerClient } from "viem/account-abstraction";
import { baseSepolia } from "viem/chains";
import { http } from "viem";

const apiKey = process.env.PIMLICO_API_KEY;
if (!apiKey) throw new Error("PIMLICO_API_KEY not set");
const chainId = Number(process.argv[2]);
const hash = process.argv[3];
if (chainId !== 84532) throw new Error("e2e is Base Sepolia (84532) only");
if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? "")) throw new Error("usage: e2e-receipt.mjs <chainId> <userOpHash>");

const bundler = createBundlerClient({ chain: baseSepolia, transport: http(`https://api.pimlico.io/v2/base-sepolia/rpc?apikey=${apiKey}`) });
const r = await bundler.waitForUserOperationReceipt({ hash });
console.log(JSON.stringify({ success: r.success, transactionHash: r.receipt.transactionHash, blockNumber: r.receipt.blockNumber.toString() }));
