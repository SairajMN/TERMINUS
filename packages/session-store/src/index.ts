import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CompletionReport, TaskState } from "@terminus/shared";

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

export class SessionStore {
  private readonly db: Database;

  constructor(path?: string) {
    const file = path ?? join(homedir(), ".terminus", "terminus.db");
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
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

  close(): void {
    this.db.close();
  }
}
