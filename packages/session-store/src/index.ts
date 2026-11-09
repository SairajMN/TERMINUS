import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CompletionReport, TaskState } from "@terminus/shared";

interface SqlStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown;
}

interface SqlDatabase {
  exec(sql: string): void;
  query(sql: string): SqlStatement;
  close(): void;
}

// Node >= 22.5 ships node:sqlite; Bun ships bun:sqlite. Prefer node's so the
// same code runs under both runtimes, fall back for Bun.
const openDatabase = (file: string): SqlDatabase => {
  const req = createRequire(import.meta.url);
  try {
    const { DatabaseSync } = req("node:sqlite") as {
      DatabaseSync: new (
        path: string,
      ) => {
        exec(sql: string): void;
        prepare(sql: string): SqlStatement;
        close(): void;
      };
    };
    const db = new DatabaseSync(file);
    return {
      exec: (sql) => db.exec(sql),
      query: (sql) => db.prepare(sql),
      close: () => db.close(),
    };
  } catch {
    const { Database } = req("bun:sqlite") as {
      Database: new (path: string) => SqlDatabase;
    };
    return new Database(file);
  }
};

export interface SessionRow {
  id: string;
  workspace: string;
  task: string;
  state: string;
  created_at: number;
  updated_at: number;
}

export interface EventRow {
  at: number;
  type: string;
  payload: string;
}

export interface PermissionAuditRow {
  id: number;
  at: number;
  session_id: string;
  origin: string;
  action_kind: string;
  target: string;
  tier: string;
  verdict: string;
  reason: string;
}

export class SessionStore {
  private readonly db: SqlDatabase;

  constructor(path?: string) {
    const file = path ?? join(homedir(), ".terminus", "terminus.db");
    mkdirSync(dirname(file), { recursive: true });
    this.db = openDatabase(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        task TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS permission_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        origin TEXT NOT NULL,
        action_kind TEXT NOT NULL,
        target TEXT NOT NULL,
        tier TEXT NOT NULL,
        verdict TEXT NOT NULL,
        reason TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspace_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  createSession(workspace: string, task: string): string {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .query(
        "INSERT INTO sessions (id, workspace, task, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, workspace, task, "queued", now, now);
    return id;
  }

  setState(id: string, state: TaskState): void {
    this.db
      .query("UPDATE sessions SET state = ?, updated_at = ? WHERE id = ?")
      .run(state, Date.now(), id);
  }

  logEvent(sessionId: string, type: string, payload: unknown): void {
    this.db
      .query("INSERT INTO events (session_id, at, type, payload) VALUES (?, ?, ?, ?)")
      .run(sessionId, Date.now(), type, JSON.stringify(payload));
  }

  logReport(sessionId: string, report: CompletionReport): void {
    this.logEvent(sessionId, "report", report);
  }

  recentSessions(workspace: string, limit = 5): SessionRow[] {
    return this.db
      .query("SELECT * FROM sessions WHERE workspace = ? ORDER BY created_at DESC LIMIT ?")
      .all(workspace, limit) as SessionRow[];
  }

  sessionById(id: string): SessionRow | undefined {
    const exact = this.db.query("SELECT * FROM sessions WHERE id = ?").get(id) as
      | SessionRow
      | undefined;
    if (exact) return exact;
    return this.db.query("SELECT * FROM sessions WHERE id LIKE ? LIMIT 1").get(`${id}%`) as
      | SessionRow
      | undefined;
  }

  eventsOf(sessionId: string): EventRow[] {
    return this.db
      .query("SELECT at, type, payload FROM events WHERE session_id = ? ORDER BY id")
      .all(sessionId) as EventRow[];
  }

  allSessions(limit = 50): SessionRow[] {
    return this.db
      .query("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as SessionRow[];
  }

  logPermissionAudit(entry: Omit<PermissionAuditRow, "id" | "at">): void {
    this.db
      .query(
        "INSERT INTO permission_audit_log (at, session_id, origin, action_kind, target, tier, verdict, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        Date.now(),
        entry.session_id,
        entry.origin,
        entry.action_kind,
        entry.target,
        entry.tier,
        entry.verdict,
        entry.reason,
      );
  }

  listPermissionAudit(limit = 100): PermissionAuditRow[] {
    return this.db
      .query("SELECT * FROM permission_audit_log ORDER BY id DESC LIMIT ?")
      .all(limit) as PermissionAuditRow[];
  }

  saveSetting(key: string, value: unknown): void {
    const now = Date.now();
    this.db
      .query(
        "INSERT INTO workspace_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(key, JSON.stringify(value), now);
  }

  getSetting<T = unknown>(key: string): T | undefined {
    const row = this.db.query("SELECT value FROM workspace_settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return undefined;
    }
  }

  close(): void {
    this.db.close();
  }
}
