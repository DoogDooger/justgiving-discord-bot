import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../src/db.js';
import { processClaim } from '../src/donations.js';
import { USER_A, USER_B, deferred, setup } from './helpers.js';

const directories: string[] = [];
const stores: Store[] = [];
const databases: Database.Database[] = [];
function file() {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-store-'));
  directories.push(dir);
  return join(dir, 'donors.db');
}
function open(path: string) {
  const store = openStore(path);
  stores.push(store);
  return store;
}
function inspect(path: string) {
  const db = new Database(path);
  databases.push(db);
  return db;
}
const claim = (id: string, user = USER_A) => ({ donationId: id, discordUserId: user, token: null, pageShortName: 'page-one', source: 'claim' as const });
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('receipt failure audit', () => {
  it('records an unmatched receipt without retaining the receipt, and erases the audit on forget', async () => {
    const path = file();
    const { deps } = setup();
    stores.push(deps.store);
    deps.store = open(path);

    expect(await processClaim('123456789/1', USER_A, deps)).toEqual({ ok: false, reason: 'donation_not_found' });
    const db = inspect(path);
    expect(db.prepare('SELECT event, discord_user_id, donation_id, detail FROM audit_log').all()).toEqual([{
      event: 'verification_failed',
      discord_user_id: USER_A,
      donation_id: null,
      detail: 'claim: receipt reference not on our page',
    }]);

    deps.store.forgetUser(USER_A);
    expect(db.prepare('SELECT * FROM audit_log').all()).toEqual([]);
  });

  it('does not recreate a failure audit when forgotten during receipt lookup', async () => {
    const path = file();
    const { deps } = setup();
    stores.push(deps.store);
    deps.store = open(path);
    const result = deferred<string | null>();
    deps.receipts = { find: () => result.promise };

    const claiming = processClaim('123456789/1', USER_A, deps);
    deps.operations.forget(USER_A);
    deps.store.forgetUser(USER_A);
    result.resolve(null);

    expect(await claiming).toEqual({ ok: false, reason: 'claim_cancelled' });
    expect(inspect(path).prepare('SELECT * FROM audit_log').all()).toEqual([]);
  });
});

describe('durable redemption and migration', () => {
  it('persists null tokens and donation-only markers across forget/reopen, without affecting another user', () => {
    const path = file();
    const store = open(path);
    const token = store.getOrCreateToken(USER_A);
    store.setHiddenFromWall(USER_A, true);
    store.setHiddenFromWall(USER_B, true);
    store.queueRoleRemoval(USER_A);
    store.queueRoleRemoval(USER_B);
    store.audit('fixture', { discordUserId: USER_A, donationId: '100' });
    store.audit('fixture', { discordUserId: USER_B, donationId: '200' });
    expect(store.insertClaim(claim('00100'))).toBe(true);
    expect(store.insertClaim(claim('200', USER_B))).toBe(true);
    expect(store.getClaim('100')?.token).toBeNull();
    expect(store.forgetUser(USER_A)).toBe(1);
    expect(store.getTokenOwner(token)).toBeNull();
    expect(store.getClaimsForUser(USER_A)).toEqual([]);
    expect(store.isHiddenFromWall(USER_A)).toBe(false);
    expect(store.isHiddenFromWall(USER_B)).toBe(true);
    expect(store.getPendingRoleRemovals()).toEqual([USER_B]);
    const reopened = open(path);
    expect(reopened.hasRedeemedDonation('000100')).toBe(true);
    expect(reopened.insertClaim(claim('100'))).toBe(false);
    expect(reopened.insertClaim(claim('100', USER_B))).toBe(false);
    expect(reopened.insertClaim(claim('300'))).toBe(true);
    const db = inspect(path);
    expect(db.prepare('SELECT discord_user_id FROM audit_log').all()).toEqual([{ discord_user_id: USER_B }]);
    expect(db.prepare('SELECT name FROM pragma_table_info(?)').all('redeemed_donations')).toEqual([{ name: 'donation_id' }]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('rolls the marker back if inserting the claim fails', () => {
    const path = file();
    const store = open(path);
    const db = inspect(path);
    db.exec("CREATE TRIGGER reject_fixture BEFORE INSERT ON claims BEGIN SELECT RAISE(ABORT, 'fixture insert failed'); END");
    expect(() => store.insertClaim(claim('100'))).toThrow('fixture insert failed');
    expect(store.hasRedeemedDonation('100')).toBe(false);
    expect(store.getClaim('100')).toBeNull();
    db.exec('DROP TRIGGER reject_fixture');
    expect(store.insertClaim(claim('100'))).toBe(true);
  });

  it('migrates granted and revoked legacy claims, preserving preferences, audit, role state and times', () => {
    const path = file();
    const db = inspect(path);
    db.exec(readFileSync(new URL('./fixtures/legacy-claims.sql', import.meta.url), 'utf8'));
    db.prepare('INSERT INTO users_tokens VALUES (?, ?, 123)').run('ABCDEFGH', USER_A);
    db.prepare("INSERT INTO claims VALUES (?, ?, 'ABCDEFGH', 'page-one', 'redirect', ?, ?, 123)")
      .run('00100', USER_A, 'granted', 'added');
    db.prepare("INSERT INTO claims VALUES ('200', ?, 'ABCDEFGH', 'page-one', 'claim', 'revoked', 'not_member', 456)").run(USER_A);
    db.prepare('INSERT INTO donor_prefs VALUES (?, 1, 789)').run(USER_A);
    db.prepare('INSERT INTO pending_role_removals VALUES (?)').run(USER_A);
    db.prepare("INSERT INTO audit_log(event, discord_user_id, created_at) VALUES ('fixture', ?, 789)").run(USER_A);

    const store = open(path);
    expect(store.getClaim('100')).toMatchObject({ token: 'ABCDEFGH', status: 'granted', roleState: 'added', createdAt: 123 });
    expect(store.getClaim('200')).toMatchObject({ status: 'revoked', roleState: 'not_member', createdAt: 456 });
    expect(store.isHiddenFromWall(USER_A)).toBe(true);
    expect(store.getTokenOwner('ABCDEFGH')).toBe(USER_A);
    expect(store.getPendingRoleRemovals()).toEqual([USER_A]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM audit_log').get()).toEqual({ count: 1 });
    expect(store.hasRedeemedDonation('100')).toBe(true);
    expect(store.hasRedeemedDonation('200')).toBe(true);
    expect(store.insertClaim(claim('300'))).toBe(true);
    expect(open(path).getClaimsForUser(USER_A)).toHaveLength(3);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('fails migration atomically on existing conflicting canonical IDs, rather than selecting an owner', () => {
    const path = file();
    const db = inspect(path);
    db.exec(readFileSync(new URL('./fixtures/legacy-claims.sql', import.meta.url), 'utf8'));
    const insert = db.prepare("INSERT INTO claims VALUES (?, ?, 'ABCDEFGH', 'page-one', 'claim', 'granted', 'pending', 123)");
    insert.run('100', USER_A);
    insert.run('00100', USER_B);
    expect(() => openStore(path)).toThrow(/UNIQUE constraint/);
    expect(db.prepare('SELECT donation_id FROM claims ORDER BY donation_id').all()).toEqual([{ donation_id: '00100' }, { donation_id: '100' }]);
    expect(db.pragma('user_version', { simple: true })).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('redeemed_donations','claims_receipt_migration')").all()).toEqual([]);
  });
});
