import { describe, expect, it } from 'vitest';
import { beaconDepositWalletAddress, checkFunder, proxyWalletAddress, safeWalletAddress, uupsDepositWalletAddress } from '../src/wallets.js';

// the vectors of Polymarket's own client (packages/client/src/wallet.test.ts), signer 0x…01
const SIGNER = '0x0000000000000000000000000000000000000001';

describe('account wallet derivation (Polymarket vectors)', () => {
  it.each([
    ['beacon Deposit Wallet', beaconDepositWalletAddress, '0x94bf330955a0b957662feaf878de77bf25f76cd9'],
    ['UUPS Deposit Wallet', uupsDepositWalletAddress, '0x57ffbc34de23124faeb8387fcd689d314e57accd'],
    ['Proxy Wallet', proxyWalletAddress, '0x7754536ecd85c00b2e0cf9c1aa679340d8550756'],
    ['Safe Wallet', safeWalletAddress, '0x766b6851a199bf91ae3fa13b1cfac5187355118f'],
  ] as const)('%s', (_, derive, expected) => {
    expect(derive(SIGNER).toLowerCase()).toBe(expected);
  });
});

describe('checkFunder', () => {
  it('accepts the funder that the key controls as that type, case-insensitively', () => {
    expect(checkFunder(SIGNER, '0x94BF330955A0B957662FEAF878DE77BF25F76CD9', 3).ok).toBe(true);
    expect(checkFunder(SIGNER, '0x57ffbc34de23124faeb8387fcd689d314e57accd', 3).ok).toBe(true);
    expect(checkFunder(SIGNER, '0x766b6851a199bf91ae3fa13b1cfac5187355118f', 2).ok).toBe(true);
    expect(checkFunder(SIGNER, undefined, 0).ok).toBe(true);
  });
  it('rejects a funder of another type and says which type it is', () => {
    expect(checkFunder(SIGNER, '0x766b6851a199bf91ae3fa13b1cfac5187355118f', 3)).toMatchObject({ ok: false, actualType: 2 });
  });
  it('rejects a funder the key does not control at all', () => {
    const r = checkFunder(SIGNER, '0x0000000000000000000000000000000000000002', 3);
    expect(r).toMatchObject({ ok: false, actualType: null });
    expect(r.expected.map((a) => a.toLowerCase())).toContain('0x94bf330955a0b957662feaf878de77bf25f76cd9');
  });
});
