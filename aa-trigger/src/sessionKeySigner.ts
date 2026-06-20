import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak256, toHex, hexToBytes, type Address, type Hex } from "viem";
import { execFileSync } from "node:child_process";

/**
 * Copy-Trading session-key signer (PRD-06 / KAN-149, increment C1).
 *
 * 🔑 Auth ≠ Custody: this signs with a BACKEND-held, *scoped + capped + revocable* Smart-Session key —
 * NEVER the user's main/owner key (which never leaves the device). A leak is bounded to the on-chain cap
 * (ADR-0024 harm-reduction), not a drain.
 *
 * The interface is the whole point: a software+Keychain impl now, a YubiHSM 2 drop-in later (same contract,
 * no caller change). `sign` returns a 65-byte `r‖s‖v` secp256k1 signature with **EIP-2 low-S enforced** —
 * enforced HERE (not delegated to the underlying signer), because an HSM may emit a high-S signature and a
 * high-S signature is rejected on-chain.
 *
 * `sign` is digest-agnostic: the caller passes the exact 32-byte digest. WHICH digest the OwnableValidator
 * session-path expects (raw userOpHash vs EIP-191) is locked down in increment C3 against permissionless on
 * Base Sepolia (the money-path gate) — exactly like the DCA DIGEST-LOCK.
 */
export interface SessionKeySigner {
  /** The session key's address (= the `owners[0]` pinned into the Smart-Session OwnableValidator initData). */
  publicKeyAddress(): Address;
  /** Sign a 32-byte digest → 65-byte `r‖s‖v` (v = recId+27), EIP-2 low-S normalized. */
  sign(digest: Hex): Promise<Hex>;
}

const N = secp256k1.CURVE.n;
const HALF_N = N / 2n;

/**
 * EIP-2 low-S normalization, signer-agnostic. If `s > n/2`, replace it with `n − s` and flip the recovery
 * bit's parity (the flipped signature is the canonical low-S form of the same signature, and recovers to the
 * same key). Idempotent for an already-low-S input. This is the guard that makes the HSM drop-in safe.
 */
export function normalizeToLowS(r: bigint, s: bigint, recovery: number): { r: bigint; s: bigint; recovery: number } {
  if (s > HALF_N) return { r, s: N - s, recovery: recovery ^ 1 };
  return { r, s, recovery };
}

/** Encode (r, s, recovery) → 65-byte `0x` signature: r(32) ‖ s(32) ‖ v(1, v = recovery + 27). */
export function encodeSignature65(r: bigint, s: bigint, recovery: number): Hex {
  const rHex = toHex(r, { size: 32 }).slice(2);
  const sHex = toHex(s, { size: 32 }).slice(2);
  const v = (recovery + 27).toString(16).padStart(2, "0");
  return `0x${rHex}${sHex}${v}` as Hex;
}

/**
 * Core: raw secp256k1 sign of a 32-byte digest with a key in BYTES (so it can be zeroized), low-S enforced.
 * Uses RFC-6979 deterministic nonces (reproducible) and returns the 65-byte signature.
 */
export function signDigestLowS(privateKey: Uint8Array, digest: Uint8Array): Hex {
  const sig = secp256k1.sign(digest, privateKey); // noble: deterministic, low-S by default — we re-assert below
  const { r, s, recovery } = normalizeToLowS(sig.r, sig.s, sig.recovery);
  return encodeSignature65(r, s, recovery);
}

/** Derive the Ethereum address from a secp256k1 private key (bytes). */
export function addressFromPrivateKey(privateKey: Uint8Array): Address {
  const pub = secp256k1.getPublicKey(privateKey, false); // 65-byte uncompressed (0x04 ‖ X ‖ Y)
  const hash = keccak256(pub.slice(1)); // keccak over X‖Y
  return `0x${hash.slice(-40)}` as Address;
}

/**
 * In-memory / dev signer — holds the key in a byte buffer. Same crypto path as the Keychain/HSM impls; used
 * for tests and local dev. The key bytes are zeroized after each sign (a fresh copy is signed with).
 */
export class InMemorySessionKeySigner implements SessionKeySigner {
  private readonly key: Uint8Array;
  private readonly address: Address;
  constructor(privateKey: Hex) {
    this.key = hexToBytes(privateKey);
    this.address = addressFromPrivateKey(this.key);
  }
  publicKeyAddress(): Address {
    return this.address;
  }
  async sign(digest: Hex): Promise<Hex> {
    const copy = Uint8Array.from(this.key);
    try {
      return signDigestLowS(copy, hexToBytes(digest));
    } finally {
      copy.fill(0);
    }
  }
}

/**
 * macOS-Keychain-backed signer: the secp256k1 key is stored as a Keychain generic-password item (encrypted
 * at-rest, Secure-Enclave-wrapped on modern Macs; the SE itself can't sign secp256k1 — it only wraps).
 * The key is read in only at sign-time and the byte copy is zeroized immediately after.
 *
 * Honest limitation: the `security` CLI returns the secret as a process string that JS can't memset; only the
 * byte copy is zeroized. The YubiHSM 2 drop-in removes in-process key material entirely — that is the stronger
 * posture (this software tier is the harm-reduction interim, ADR-0024 / ph2-decision-package).
 */
export class KeychainSessionKeySigner implements SessionKeySigner {
  constructor(
    private readonly service: string,
    private readonly account: string,
    private readonly address: Address,
  ) {}

  publicKeyAddress(): Address {
    return this.address;
  }

  async sign(digest: Hex): Promise<Hex> {
    const keyHex = execFileSync("security", ["find-generic-password", "-s", this.service, "-a", this.account, "-w"])
      .toString()
      .trim();
    const keyBytes = hexToBytes((keyHex.startsWith("0x") ? keyHex : `0x${keyHex}`) as Hex);
    try {
      return signDigestLowS(keyBytes, hexToBytes(digest));
    } finally {
      keyBytes.fill(0);
    }
  }

  /**
   * Provision: generate a fresh secp256k1 session keypair, store the private key in the Keychain, and return
   * the signer (+ the public address the app pins into the Smart-Session enable). The private key never leaves
   * this process except into the Keychain item.
   */
  static provision(service: string, account: string): { signer: KeychainSessionKeySigner; address: Address } {
    const priv = secp256k1.utils.randomPrivateKey();
    const address = addressFromPrivateKey(priv);
    const keyHex = toHex(priv);
    try {
      execFileSync("security", ["add-generic-password", "-s", service, "-a", account, "-w", keyHex, "-U"]);
    } finally {
      priv.fill(0);
    }
    return { signer: new KeychainSessionKeySigner(service, account, address), address };
  }

  static delete(service: string, account: string): void {
    try {
      execFileSync("security", ["delete-generic-password", "-s", service, "-a", account]);
    } catch {
      /* not present — idempotent */
    }
  }
}
