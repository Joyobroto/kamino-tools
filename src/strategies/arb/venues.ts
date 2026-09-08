/**
 * DEX venue registry with on-chain pool layouts.
 *
 * Every constant here was calibrated empirically against mainnet on 2026-09-05
 * (see docs/ARB_TREASURE_RESEARCH.md): known pools were decoded byte-by-byte
 * and the candidate vault offsets were confirmed by fetching live token
 * balances from them. Venues whose layouts could not be fully verified
 * (raydium-cpmm) or whose vaults require PDA derivation (raydium-ammv4) are
 * excluded from the default watch set.
 */

import bs58 from "bs58";

export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhMpASfgMQLBV4hYsXhHtHjCgwm";

/** A 165-byte SPL token account stores its owner at offset 32. */
export const TOKEN_ACCOUNT_OWNER_OFFSET = 32;
export const TOKEN_ACCOUNT_DATA_SIZE = 165;
export { bs58 };

export interface VenueLayout {
  /** Pool account byte size (dataSize GPA filter). */
  poolAccountSize: number;
  /** Byte offset of token-A mint (32 bytes). */
  mintAOffset: number;
  /** Byte offset of token-B mint (32 bytes). */
  mintBOffset: number;
  /** Byte offset of token-A vault pubkey (32 bytes). */
  vaultAOffset: number;
  /** Byte offset of token-B vault pubkey (32 bytes). */
  vaultBOffset: number;
}

export interface Venue {
  /** Human label used in output/logs. */
  name: string;
  programId: string;
  layout: VenueLayout;
}

/**
 * Verified layouts (mint + vault offsets confirmed against live vault balances):
 * - pumpswap 301B: WOFI pool (vaultA 18.1M WOFI / vaultB 956 SOL)
 * - meteora-damm-v2 (program cpamdpZ…) 1112B: Gecko's "meteora-damm-v2" label —
 *   mints @168/200, vaults @232/264 verified on an ANB pool ($0.003/$8.5 live)
 * - meteora-damm (program LBUZKh…) 904B: 156K pools, Gecko's "meteora" label —
 *   mints @88/120, vaults @152/184 verified on SOL/USDC (23.9K SOL / 2.6M USDC)
 * - raydium CLMM 1544B: SOL/USDC (38.6K SOL / 3.3M USDC)
 * - orca whirlpool 653B: SOL/USDC (114K SOL / 14.1M USDC)
 *
 * Excluded: program Eo7WjKq… 944B (16K pools, mints @8/@40 verified but vaults
 * are PDA-derived, not at fixed offsets — needs off-chain PDA derivation, deferred).
 */
export const VENUES: Venue[] = [
  {
    name: "pumpswap",
    programId: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    layout: { poolAccountSize: 301, mintAOffset: 43, mintBOffset: 75, vaultAOffset: 139, vaultBOffset: 171 },
  },
  {
    name: "meteora-damm-v2",
    programId: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
    layout: { poolAccountSize: 1112, mintAOffset: 168, mintBOffset: 200, vaultAOffset: 232, vaultBOffset: 264 },
  },
  {
    name: "meteora-damm",
    programId: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    layout: { poolAccountSize: 904, mintAOffset: 88, mintBOffset: 120, vaultAOffset: 152, vaultBOffset: 184 },
  },
  {
    name: "raydium-clmm",
    programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    layout: { poolAccountSize: 1544, mintAOffset: 73, mintBOffset: 105, vaultAOffset: 137, vaultBOffset: 169 },
  },
  {
    name: "orca-whirlpool",
    programId: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    layout: { poolAccountSize: 653, mintAOffset: 101, mintBOffset: 181, vaultAOffset: 133, vaultBOffset: 213 },
  },
];

/** Fields extracted from a decoded pool account. */
export interface DecodedPool {
  venue: string;
  poolAddress: string;
  mintA: string;
  mintB: string;
  vaultA: string;
  vaultB: string;
}

const readPubkey = (buf: Buffer, offset: number): string => bs58.encode(buf.subarray(offset, offset + 32));

/**
 * Decodes a raw pool account into mints/vaults. Returns null when the buffer
 * does not match the venue layout size.
 */
export function decodePoolAccount(venue: Venue, poolAddress: string, data: Buffer): DecodedPool | null {
  if (data.length !== venue.layout.poolAccountSize) return null;
  const mintA = readPubkey(data, venue.layout.mintAOffset);
  const mintB = readPubkey(data, venue.layout.mintBOffset);
  if (mintA === mintB) return null;
  return {
    venue: venue.name,
    poolAddress,
    mintA,
    mintB,
    vaultA: readPubkey(data, venue.layout.vaultAOffset),
    vaultB: readPubkey(data, venue.layout.vaultBOffset),
  };
}

export function venueByName(name: string): Venue | undefined {
  return VENUES.find((venue) => venue.name === name);
}
