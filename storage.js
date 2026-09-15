const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

// Vercel and Netlify deployed filesystems are read-only. Their temporary directory is
// writable for the lifetime of a serverless instance; local development keeps
// using the checked-out data directory.
const DATA_DIR = process.env.VERCEL || process.env.NETLIFY
  ? path.join("/tmp", "foodwise")
  : path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "foodwise.db"));
db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS documents (collection TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT, PRIMARY KEY(collection,id));
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id));
  CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT, details TEXT, created_at TEXT NOT NULL);
`);

const now = () => new Date().toISOString();
const parseRows = rows => rows.map(row => JSON.parse(row.payload));

function list(collection) {
  return parseRows(db.prepare("SELECT payload FROM documents WHERE collection=? ORDER BY created_at DESC").all(collection));
}

function replace(collection, items) {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM documents WHERE collection=?").run(collection);
    const insert = db.prepare("INSERT INTO documents(collection,id,payload,created_at,updated_at) VALUES(?,?,?,?,?)");
    for (const item of items) insert.run(collection, item.id || crypto.randomUUID(), JSON.stringify(item), item.createdAt || now(), item.updatedAt || null);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function upsert(collection, item) {
  const value = { ...item, id: item.id || crypto.randomUUID(), createdAt: item.createdAt || now(), updatedAt: now() };
  db.prepare("INSERT INTO documents(collection,id,payload,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at").run(collection, value.id, JSON.stringify(value), value.createdAt, value.updatedAt);
  return value;
}

function remove(collection, id) {
  return db.prepare("DELETE FROM documents WHERE collection=? AND id=?").run(collection, id).changes > 0;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function userCount() {
  return Number(db.prepare("SELECT COUNT(*) count FROM users").get().count);
}

function createUser({ name, username, password, role }) {
  const salt = crypto.randomBytes(16).toString("hex");
  const user = { id: crypto.randomUUID(), name, username: username.toLowerCase(), role, createdAt: now() };
  db.prepare("INSERT INTO users(id,name,username,password_hash,salt,role,created_at) VALUES(?,?,?,?,?,?,?)").run(user.id, user.name, user.username, hashPassword(password, salt), salt, user.role, user.createdAt);
  return user;
}

function listUsers() {
  return db.prepare("SELECT id,name,username,role,created_at createdAt FROM users ORDER BY created_at").all();
}

function userNameExists(name, role) {
  return Boolean(db.prepare("SELECT 1 FROM users WHERE lower(name)=? AND role=? LIMIT 1").get(String(name).trim().toLowerCase(), role));
}

function deleteUsersByRole(role) {
  const users = db.prepare("SELECT id FROM users WHERE role=?").all(role);
  db.exec("BEGIN");
  try {
    const deleteSessions = db.prepare("DELETE FROM sessions WHERE user_id=?");
    for (const user of users) deleteSessions.run(user.id);
    const changes = db.prepare("DELETE FROM users WHERE role=?").run(role).changes;
    db.exec("COMMIT");
    return changes;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function authenticate(identifier, password, role) {
  const login = String(identifier || "").trim().toLowerCase();
  const selectedRole = String(role || "").trim().toLowerCase();
  const row = selectedRole
    ? db.prepare("SELECT * FROM users WHERE (lower(username)=? OR lower(name)=?) AND role=? ORDER BY created_at LIMIT 1").get(login, login, selectedRole)
    : db.prepare("SELECT * FROM users WHERE lower(username)=? OR lower(name)=? ORDER BY created_at LIMIT 1").get(login, login);
  if (!row) return null;
  const actual = Buffer.from(hashPassword(password, row.salt), "hex");
  const expected = Buffer.from(row.password_hash, "hex");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  return { id: row.id, name: row.name, username: row.username, role: row.role };
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)").run(tokenHash, user.id, expiresAt);
  return { token, expiresAt };
}

function getSession(token) {
  if (!token) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const row = db.prepare("SELECT u.id,u.name,u.username,u.role,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?").get(tokenHash);
  if (!row || row.expires_at < now()) return null;
  return { id: row.id, name: row.name, username: row.username, role: row.role };
}

function endSession(token) {
  if (!token) return;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash);
}

function audit(user, action, entity, entityId, details = {}) {
  db.prepare("INSERT INTO audit_log(id,user_id,action,entity,entity_id,details,created_at) VALUES(?,?,?,?,?,?,?)").run(crypto.randomUUID(), user?.id || null, action, entity, entityId || null, JSON.stringify(details), now());
}

function auditList(limit = 100) {
  return db.prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?").all(limit).map(row => ({ ...row, details: JSON.parse(row.details || "{}") }));
}

module.exports = { db, list, replace, upsert, remove, userCount, createUser, listUsers, userNameExists, deleteUsersByRole, authenticate, createSession, getSession, endSession, audit, auditList };
