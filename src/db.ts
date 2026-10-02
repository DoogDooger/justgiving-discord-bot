import { randomInt } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type ClaimSource = 'redirect' | 'claim';
export type ClaimStatus = 'granted' | 'revoked';

/** Whether the Discord role for a claim has been given yet. */
export type RoleState = 'pending' | 'added' | 'not_member';

export interface Claim {
  donationId: string;
  discordUserId: string;
  token: string;
  pageShortName: string;
  source: ClaimSource;
  status: ClaimStatus;
  roleState: RoleState;
  createdAt: number;
}

export interface AuditEntry {
  discordUserId?: string | null;
  donationId?: string | null;
  detail?: string | null;
}

/**
 * Thin data layer. Everything the app needs from storage goes through this
 * interface so SQLite could be swapped for Postgres without touching callers.
 */
export interface Store {
  getOrCreateToken(discordUserId: string): string;
  getTokenOwner(token: string): string | null;
  getClaim(donationId: string): Claim | null;
  /** Returns false if the donation has already been claimed. */
  insertClaim(claim: Omit<Claim, 'createdAt' | 'status' | 'roleState'>): boolean;
  setRoleState(donationId: string, state: RoleState): void;
  /** Granted claims still waiting for their role, oldest first (for the background role queue). */
  getPendingRoleClaims(createdAfter: number, limit: number): Claim[];
  getClaimsForUser(discordUserId: string): Claim[];
  /** Granted claims older than `createdBefore`, oldest first, for the refund re-check. */
  getGrantedClaims(createdBefore: number): Claim[];
  /** Marks a claim as revoked (refunded or cancelled on JustGiving). It stays claimed, so it can't be reused. */
  revokeClaim(donationId: string): void;
  /** Queues a role removal to retry after a refund. */
  queueRoleRemoval(discordUserId: string): void;
  /** Users whose role removal is still pending. */
  getPendingRoleRemovals(): string[];
  /** Clears a completed or cancelled role removal. */
  deletePendingRoleRemoval(discordUserId: string): void;
  /** Deletes everything stored about a user. Returns how many claims were removed. */
  forgetUser(discordUserId: string): number;
  /** Most recent granted claims from donors who haven't hidden themselves from the donor wall. */
  getRecentPublicClaims(limit: number): Claim[];
  /** Every granted claim from donors who haven't hidden themselves (for the top donors list). */
  getPublicClaimOwners(): { donationId: string; discordUserId: string }[];
  isHiddenFromWall(discordUserId: string): boolean;
  setHiddenFromWall(discordUserId: string, hidden: boolean): void;
  audit(event: string, entry?: AuditEntry): void;
  close(): void;
}

// SDI references must be alphanumeric and at most 8 characters.
// Ambiguous characters (0/O, 1/I/L) are left out so tokens are easy to read back.
const TOKEN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TOKEN_LENGTH = 8;

function generateToken(): string {
  let token = '';
  for (let i = 0; i < TOKEN_LENGTH; i++) token += TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)];
  return token;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users_tokens (
  token           TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL UNIQUE,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  donation_id     TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  token           TEXT NOT NULL,
  page_short_name TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('redirect', 'claim')),
  status          TEXT NOT NULL CHECK (status IN ('granted', 'revoked')),
  role_state      TEXT NOT NULL DEFAULT 'pending' CHECK (role_state IN ('pending', 'added', 'not_member')),
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS claims_user ON claims (discord_user_id);

CREATE TABLE IF NOT EXISTS pending_role_removals (
  discord_user_id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS donor_prefs (
  discord_user_id TEXT PRIMARY KEY,
  hidden_from_wall INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event           TEXT NOT NULL,
  discord_user_id TEXT,
  donation_id     TEXT,
  detail          TEXT,
  created_at      INTEGER NOT NULL
);
`;

interface ClaimRow {
  donation_id: string;
  discord_user_id: string;
  token: string;
  page_short_name: string;
  source: ClaimSource;
  status: ClaimStatus;
  role_state: RoleState;
  created_at: number;
}

const toClaim = (row: ClaimRow): Claim => ({
  donationId: row.donation_id,
  discordUserId: row.discord_user_id,
  token: row.token,
  pageShortName: row.page_short_name,
  source: row.source,
  status: row.status,
  roleState: row.role_state,
  createdAt: row.created_at,
});

export function openStore(path: string): Store {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  const selectTokenForUser = db.prepare<[string], { token: string }>('SELECT token FROM users_tokens WHERE discord_user_id = ?');
  const selectTokenOwner = db.prepare<[string], { discord_user_id: string }>('SELECT discord_user_id FROM users_tokens WHERE token = ?');
  const insertToken = db.prepare('INSERT OR IGNORE INTO users_tokens (token, discord_user_id, created_at) VALUES (?, ?, ?)');
  const selectClaim = db.prepare<[string], ClaimRow>('SELECT * FROM claims WHERE donation_id = ?');
  const selectClaimsForUser = db.prepare<[string], ClaimRow>('SELECT * FROM claims WHERE discord_user_id = ? ORDER BY created_at');
  const insertClaimStmt = db.prepare(
    `INSERT OR IGNORE INTO claims (donation_id, discord_user_id, token, page_short_name, source, status, role_state, created_at)
     VALUES (@donationId, @discordUserId, @token, @pageShortName, @source, 'granted', 'pending', @createdAt)`,
  );
  const selectGranted = db.prepare<[number], ClaimRow>("SELECT * FROM claims WHERE status = 'granted' AND created_at < ? ORDER BY created_at");
  const revokeClaimStmt = db.prepare("UPDATE claims SET status = 'revoked' WHERE donation_id = ?");
  const insertPendingRemoval = db.prepare('INSERT OR IGNORE INTO pending_role_removals (discord_user_id) VALUES (?)');
  const selectPendingRemovals = db.prepare<[], { discord_user_id: string }>('SELECT discord_user_id FROM pending_role_removals');
  const deletePendingRemoval = db.prepare('DELETE FROM pending_role_removals WHERE discord_user_id = ?');
  const forgetUser = db.transaction((discordUserId: string): number => {
    const claims = db.prepare('DELETE FROM claims WHERE discord_user_id = ?').run(discordUserId).changes;
    db.prepare('DELETE FROM users_tokens WHERE discord_user_id = ?').run(discordUserId);
    db.prepare('DELETE FROM donor_prefs WHERE discord_user_id = ?').run(discordUserId);
    db.prepare('DELETE FROM pending_role_removals WHERE discord_user_id = ?').run(discordUserId);
    db.prepare('DELETE FROM audit_log WHERE discord_user_id = ?').run(discordUserId);
    return claims;
  });
  const updateRoleState = db.prepare('UPDATE claims SET role_state = ? WHERE donation_id = ?');
  const selectPendingRoles = db.prepare<[number, number], ClaimRow>(
    "SELECT * FROM claims WHERE status = 'granted' AND role_state = 'pending' AND created_at > ? ORDER BY created_at LIMIT ?",
  );
  const selectRecentPublic = db.prepare<[number], ClaimRow>(
    `SELECT c.* FROM claims c LEFT JOIN donor_prefs p ON p.discord_user_id = c.discord_user_id
     WHERE c.status = 'granted' AND COALESCE(p.hidden_from_wall, 0) = 0
     ORDER BY c.created_at DESC LIMIT ?`,
  );
  const selectPublicOwners = db.prepare<[], { donationId: string; discordUserId: string }>(
    `SELECT c.donation_id AS donationId, c.discord_user_id AS discordUserId
     FROM claims c LEFT JOIN donor_prefs p ON p.discord_user_id = c.discord_user_id
     WHERE c.status = 'granted' AND COALESCE(p.hidden_from_wall, 0) = 0`,
  );
  const selectHidden = db.prepare<[string], { hidden_from_wall: number }>('SELECT hidden_from_wall FROM donor_prefs WHERE discord_user_id = ?');
  const upsertHidden = db.prepare(
    `INSERT INTO donor_prefs (discord_user_id, hidden_from_wall, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (discord_user_id) DO UPDATE SET hidden_from_wall = excluded.hidden_from_wall, updated_at = excluded.updated_at`,
  );
  const insertAudit = db.prepare('INSERT INTO audit_log (event, discord_user_id, donation_id, detail, created_at) VALUES (?, ?, ?, ?, ?)');

  const getOrCreateToken = db.transaction((discordUserId: string): string => {
    const existing = selectTokenForUser.get(discordUserId);
    if (existing) return existing.token;
    for (let attempt = 0; attempt < 10; attempt++) {
      const token = generateToken();
      if (insertToken.run(token, discordUserId, Date.now()).changes === 1) return token;
    }
    throw new Error('Could not generate a unique token');
  });

  return {
    getOrCreateToken,
    getTokenOwner: (token) => selectTokenOwner.get(token)?.discord_user_id ?? null,
    getClaim: (donationId) => {
      const row = selectClaim.get(donationId);
      return row ? toClaim(row) : null;
    },
    insertClaim: (claim) => insertClaimStmt.run({ ...claim, createdAt: Date.now() }).changes === 1,
    setRoleState: (donationId, state) => {
      updateRoleState.run(state, donationId);
    },
    getPendingRoleClaims: (createdAfter, limit) => selectPendingRoles.all(createdAfter, limit).map(toClaim),
    getClaimsForUser: (discordUserId) => selectClaimsForUser.all(discordUserId).map(toClaim),
    getGrantedClaims: (createdBefore) => selectGranted.all(createdBefore).map(toClaim),
    revokeClaim: (donationId) => {
      revokeClaimStmt.run(donationId);
    },
    queueRoleRemoval: (discordUserId) => {
      insertPendingRemoval.run(discordUserId);
    },
    getPendingRoleRemovals: () => selectPendingRemovals.all().map((row) => row.discord_user_id),
    deletePendingRoleRemoval: (discordUserId) => {
      deletePendingRemoval.run(discordUserId);
    },
    forgetUser,
    getRecentPublicClaims: (limit) => selectRecentPublic.all(limit).map(toClaim),
    getPublicClaimOwners: () => selectPublicOwners.all(),
    isHiddenFromWall: (discordUserId) => (selectHidden.get(discordUserId)?.hidden_from_wall ?? 0) === 1,
    setHiddenFromWall: (discordUserId, hidden) => {
      upsertHidden.run(discordUserId, hidden ? 1 : 0, Date.now());
    },
    audit: (event, entry = {}) => {
      insertAudit.run(event, entry.discordUserId ?? null, entry.donationId ?? null, entry.detail ?? null, Date.now());
    },
    close: () => db.close(),
  };
}
