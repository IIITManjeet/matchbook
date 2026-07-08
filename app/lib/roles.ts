/**
 * Role-based access control, derived from on-chain state — the program
 * is the source of truth, not a backend table.
 *
 *   viewer    guest browsing; no wallet, read-only UI
 *   trader    connected wallet (its OpenOrders / MarginAccount PDAs
 *             are created on first use)
 *   operator  the perp market's admin — the oracle keeper identity;
 *             operator-only surfaces render for this wallet alone
 *
 * Resolution is one batched `getMultipleAccounts` round-trip: the perp
 * market (for its admin field) plus the wallet's two trading PDAs.
 */

import { PublicKey } from "@solana/web3.js";
import { getConnection } from "./chain";
import idl from "./idl/clob.json";

export type Role = "viewer" | "trader" | "operator";

export interface RoleInfo {
  role: Role;
  /** the perp market operator's address, for display */
  perpAdmin: string | null;
  /** whether the wallet already has trading accounts on-chain */
  onboarded: boolean;
}

const PROGRAM_ID = new PublicKey((idl as { address: string }).address);
const seed = (s: string) => new TextEncoder().encode(s);

export async function resolveRole(
  walletAddress: string,
  markets: { perp?: string; spot?: string },
): Promise<RoleInfo> {
  const wallet = new PublicKey(walletAddress);
  const keys: PublicKey[] = [];
  let perpIdx = -1;
  let marginIdx = -1;
  let ooIdx = -1;

  if (markets.perp) {
    const pm = new PublicKey(markets.perp);
    perpIdx = keys.push(pm) - 1;
    marginIdx =
      keys.push(
        PublicKey.findProgramAddressSync(
          [seed("margin"), pm.toBytes(), wallet.toBytes()],
          PROGRAM_ID,
        )[0],
      ) - 1;
  }
  if (markets.spot) {
    const sm = new PublicKey(markets.spot);
    ooIdx =
      keys.push(
        PublicKey.findProgramAddressSync(
          [seed("open_orders"), sm.toBytes(), wallet.toBytes()],
          PROGRAM_ID,
        )[0],
      ) - 1;
  }
  if (keys.length === 0) return { role: "trader", perpAdmin: null, onboarded: false };

  const infos = await getConnection().getMultipleAccountsInfo(keys);

  let perpAdmin: string | null = null;
  if (perpIdx >= 0 && infos[perpIdx]) {
    // PerpMarket layout: 8-byte discriminator, then `admin: Pubkey`.
    perpAdmin = new PublicKey(infos[perpIdx]!.data.subarray(8, 40)).toBase58();
  }

  const onboarded = (marginIdx >= 0 && !!infos[marginIdx]) || (ooIdx >= 0 && !!infos[ooIdx]);
  return {
    role: perpAdmin === walletAddress ? "operator" : "trader",
    perpAdmin,
    onboarded,
  };
}
