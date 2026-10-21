import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { ORG_MIGRATIONS } from "./schema.js";

export type Row = Record<string, string | number | null>;
type Param = string | number | bigint | null;

/** Thin wrapper over node:sqlite. Amounts are stored as decimal strings of the smallest unit. */
export class Db {
  readonly raw: DatabaseSync;

  constructor(
    readonly path: string,
    migrations: readonly string[] = ORG_MIGRATIONS,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    // The CLI and the server may hold the same file; wait for the other rather than fail.
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate(migrations);
    this.raw.exec("PRAGMA foreign_keys = ON;");
  }

  private pragma(name: string): number {
    const row = this.raw.prepare(`PRAGMA ${name}`).get() as Record<string, number> | undefined;
    return Number(row?.[name] ?? 0);
  }

  private migrate(migrations: readonly string[]): void {
    const version = this.pragma("user_version");
    if (version > migrations.length) {
      throw new Error(`${this.path} is at schema ${version}; this build only knows ${migrations.length}`);
    }
    if (version === 0) {
      const existing = this.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number };
      if (Number(existing.n) > 0) {
        throw new Error(`${this.path} predates schema versioning and cannot be upgraded; move it aside`);
      }
    }
    // Table rebuilds need foreign keys off; the check before each commit keeps them honest.
    this.raw.exec("PRAGMA foreign_keys = OFF;");
    for (let i = version; i < migrations.length; i++) {
      this.raw.exec("BEGIN");
      try {
        this.raw.exec(migrations[i]!);
        if (this.raw.prepare("PRAGMA foreign_key_check").all().length > 0) {
          throw new Error(`migration ${i + 1} leaves dangling references`);
        }
        this.raw.exec(`PRAGMA user_version = ${i + 1}`);
        this.raw.exec("COMMIT");
      } catch (err) {
        try {
          this.raw.exec("ROLLBACK");
        } catch {
          // If the transaction auto-rolled back (e.g. statement error or manual COMMIT), ignore the rollback failure.
        }
        throw err;
      }
    }
  }

  /** Changes whenever another connection commits to this file. */
  dataVersion(): number {
    return this.pragma("data_version");
  }

  private readonly statements = new Map<string, StatementSync>();

  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.raw.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.prepare(sql).all(...params) as T[];
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined;
  }

  /** Returns the new row id. */
  run(sql: string, ...params: Param[]): number {
    return Number(this.prepare(sql).run(...params).lastInsertRowid);
  }

  /** Returns the number of rows written. */
  write(sql: string, ...params: Param[]): number {
    return Number(this.prepare(sql).run(...params).changes);
  }

  tx<T>(fn: () => T): T {
    this.raw.exec("BEGIN");
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        // If the transaction auto-rolled back or was rolled back, ignore the rollback failure.
      }
      throw err;
    }
  }

  close(): void {
    this.raw.close();
  }
}
