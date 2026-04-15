import Database from "better-sqlite3";
import path from "node:path";

export interface SessionRow {
  thread_id: string;
  session_id: string;
  channel_id: string;
  mode: "channel" | "forum";
  trigger: "mention" | "any";
  work_dir: string;
  created_at: number;
  last_active: number;
}

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), "data", "bot.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        thread_id    TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL,
        channel_id   TEXT NOT NULL,
        mode         TEXT NOT NULL,
        trigger      TEXT NOT NULL,
        work_dir     TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        last_active  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel_id);
    `);
  }
  return db;
}

export function insertSession(row: SessionRow): void {
  const stmt = getDb().prepare(`
    INSERT INTO sessions (thread_id, session_id, channel_id, mode, trigger, work_dir, created_at, last_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    row.thread_id,
    row.session_id,
    row.channel_id,
    row.mode,
    row.trigger,
    row.work_dir,
    row.created_at,
    row.last_active
  );
}

export function getSessionByThread(threadId: string): SessionRow | undefined {
  const stmt = getDb().prepare(`SELECT * FROM sessions WHERE thread_id = ?`);
  return stmt.get(threadId) as SessionRow | undefined;
}

export function deleteSessionByThread(threadId: string): void {
  const stmt = getDb().prepare(`DELETE FROM sessions WHERE thread_id = ?`);
  stmt.run(threadId);
}

export function updateLastActive(threadId: string, lastActive: number): void {
  const stmt = getDb().prepare(`UPDATE sessions SET last_active = ? WHERE thread_id = ?`);
  stmt.run(lastActive, threadId);
}

export function listAllSessions(): SessionRow[] {
  const stmt = getDb().prepare(`SELECT * FROM sessions`);
  return stmt.all() as SessionRow[];
}
