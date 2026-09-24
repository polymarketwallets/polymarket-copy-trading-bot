/**
 * Which Polymarket account wallet a signing key controls, for each account type.
 *
 * Polymarket account wallets are CREATE2 contracts whose address follows from the owner's address, so
 * the funder address in the config can be checked against the private key without any network call.
 * Ported from Polymarket's official client (`@polymarket/client`, packages/client/src/wallet.ts) and
 * tested against the same vectors.
 */
import { concat, encodeAbiParameters, getAddress, getCreate2Address, keccak256, numberToHex, type Hex } from 'viem';

export const WALLET_DERIVATION = {
  depositWalletFactory: '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07',
  depositWalletBeacon: '0x7A18EDfe055488A3128f01F563e5B479D92ffc3a',
  depositWalletImplementation: '0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB',
  proxyFactory: '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052',
  proxyImplementation: '0x44e999d5c2F66Ef0861317f9A4805AC2e90aEB4f',
  safeFactory: '0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b',
  safeInitCodeHash: '0x2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf',
} as const;

const PROXY_BYTECODE_TEMPLATE =
  '3d3d606380380380913d393d73%s5af4602a57600080fd5b602d8060366000396000f3363d3d373d3d3d363d73%s5af43d82803e903d91602b57fd5bf352e831dd00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000';
const ERC1967_CONST1 = '0xcc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3';
const ERC1967_CONST2 = '0x5155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076';
const ERC1967_PREFIX = 0x61003d3d8160233d3973n;
const BEACON_CONST1 = '0xb3582b35133d50545afa5036515af43d6000803e604d573d6000fd5b3d6000f3';
const BEACON_CONST2 = '0x1b60e01b36527fa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6c';
const BEACON_CONST3 = '0x60195155f3363d3d373d3d363d602036600436635c60da';
const BEACON_PREFIX = 0x6100523d8160233d3973n;

type Addr = `0x${string}`;
const lower = (a: string) => a.toLowerCase();

export function proxyWalletAddress(signer: Addr): Addr {
  const c = WALLET_DERIVATION;
  const bytecode = PROXY_BYTECODE_TEMPLATE.replace('%s', lower(c.proxyFactory).slice(2)).replace('%s', lower(c.proxyImplementation).slice(2));
  return getCreate2Address({ from: c.proxyFactory, salt: keccak256(signer), bytecodeHash: keccak256(`0x${bytecode}`) });
}

export function safeWalletAddress(signer: Addr): Addr {
  const c = WALLET_DERIVATION;
  return getCreate2Address({ from: c.safeFactory, salt: keccak256(encodeAbiParameters([{ type: 'address' }], [signer])), bytecodeHash: c.safeInitCodeHash });
}

function depositArgs(signer: Addr): Hex {
  const walletId = `0x${signer.slice(2).padStart(64, '0')}` as Hex;
  return encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [WALLET_DERIVATION.depositWalletFactory, walletId]);
}

function initCodeHash(prefixBase: bigint, target: string, middle: Hex[], args: Hex): Hex {
  const argsLen = BigInt((args.length - 2) / 2);
  return keccak256(concat([numberToHex(prefixBase + (argsLen << 56n), { size: 10 }), target as Hex, ...middle, args]));
}

/** the Deposit Wallet a signer owns (current beacon factory) */
export function beaconDepositWalletAddress(signer: Addr): Addr {
  const args = depositArgs(signer);
  const hash = initCodeHash(BEACON_PREFIX, WALLET_DERIVATION.depositWalletBeacon, [BEACON_CONST3, BEACON_CONST2, BEACON_CONST1], args);
  return getCreate2Address({ from: WALLET_DERIVATION.depositWalletFactory, salt: keccak256(args), bytecodeHash: hash });
}

/** the Deposit Wallet a signer owns (earlier UUPS factory) */
export function uupsDepositWalletAddress(signer: Addr): Addr {
  const args = depositArgs(signer);
  const hash = initCodeHash(ERC1967_PREFIX, WALLET_DERIVATION.depositWalletImplementation, ['0x6009', ERC1967_CONST2, ERC1967_CONST1], args);
  return getCreate2Address({ from: WALLET_DERIVATION.depositWalletFactory, salt: keccak256(args), bytecodeHash: hash });
}

/** every account wallet a signer controls, by signatureType */
export function walletsOf(signer: Addr): Record<0 | 1 | 2 | 3, Addr[]> {
  const s = getAddress(signer);
  return { 0: [s], 1: [proxyWalletAddress(s)], 2: [safeWalletAddress(s)], 3: [beaconDepositWalletAddress(s), uupsDepositWalletAddress(s)] };
}

/**
 * Does `funder` belong to `signer` as an account of `signatureType`? When it does not, `expected` is the
 * address that would, and `actualType` is the type the funder does belong to, if any.
 */
export function checkFunder(signer: Addr, funder: string | undefined, signatureType: number): { ok: boolean; expected: Addr[]; actualType: number | null } {
  const all = walletsOf(signer);
  const f = lower(funder ?? signer);
  const expected = all[signatureType as 0 | 1 | 2 | 3] ?? [];
  const ok = expected.some((a) => lower(a) === f);
  const hit = (Object.entries(all) as [string, Addr[]][]).find(([, list]) => list.some((a) => lower(a) === f));
  return { ok, expected, actualType: hit ? Number(hit[0]) : null };
}
