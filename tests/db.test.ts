import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore } from '../src/db.js';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('store on disk', () => {
  it('creates the database, and keeps its data when reopened', () => {
    dir = mkdtempSync(join(tmpdir(), 'donor-bot-'));
    const path = join(dir, 'nested', 'donors.db');

    const first = openStore(path);
    const token = first.getOrCreateToken('111111111111111111');
    expect(first.insertClaim({ donationId: '100', discordUserId: '111111111111111111', token, pageShortName: 'page/x', source: 'redirect' })).toBe(true);
    // The same donation can't be claimed twice.
    expect(first.insertClaim({ donationId: '100', discordUserId: '222222222222222222', token, pageShortName: 'page/x', source: 'claim' })).toBe(false);
    first.close();

    const second = openStore(path);
    expect(second.getClaim('100')).toMatchObject({ discordUserId: '111111111111111111', status: 'granted', roleState: 'pending' });
    expect(second.getTokenOwner(token)).toBe('111111111111111111');
    expect(second.getOrCreateToken('111111111111111111')).toBe(token);
    second.close();
  });
});
