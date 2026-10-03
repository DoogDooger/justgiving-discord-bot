-- Pre-receipt schema (user_version 0); migration must preserve these user tables.
CREATE TABLE users_tokens (token TEXT PRIMARY KEY, discord_user_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE claims (
  donation_id TEXT PRIMARY KEY, discord_user_id TEXT NOT NULL, token TEXT NOT NULL,
  page_short_name TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('redirect','claim')),
  status TEXT NOT NULL CHECK(status IN ('granted','revoked')),
  role_state TEXT NOT NULL DEFAULT 'pending' CHECK(role_state IN ('pending','added','not_member')),
  created_at INTEGER NOT NULL
);
CREATE INDEX claims_user ON claims(discord_user_id);
CREATE TABLE pending_role_removals (discord_user_id TEXT PRIMARY KEY);
CREATE TABLE donor_prefs (discord_user_id TEXT PRIMARY KEY, hidden_from_wall INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, discord_user_id TEXT, donation_id TEXT, detail TEXT, created_at INTEGER NOT NULL);
