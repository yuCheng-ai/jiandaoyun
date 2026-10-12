import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Pool, PoolClient, QueryResultRow } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { config } from "../config/config";

export type Transaction = PoolClient;
@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool: Pool;
  constructor() {
    if (!config.databaseUrl)
      throw new Error("DATABASE_URL is required; run npm run setup:local.");
    if (!/^[a-z][a-z0-9_]*$/.test(config.schema))
      throw new Error("Invalid database schema");
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 12,
      options: `-c search_path=${config.schema}`,
      connectionTimeoutMillis: 5000,
    });
  }
  async migrate() {
    const migrationCandidates = [
      resolve(__dirname, "../../../../migrations"),
      resolve(__dirname, "../../migrations"),
      resolve(process.cwd(), "migrations"),
      resolve(process.cwd(), "backend/migrations"),
    ];
    const directory = migrationCandidates.find((p) => existsSync(p)) || migrationCandidates[0];
    const files = (await readdir(directory))
      .filter((name) => /^\d{3}-[a-z0-9-]+\.sql$/.test(name))
      .sort();
    if (!files.length) throw new Error("No database migrations found");
    await this.transaction(async (tx) => {
      // Serialize startup per database/schema, including the first ledger creation.
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(current_database() || '/' || $1, 0))",
        [config.schema],
      );
      await tx.query(`CREATE SCHEMA IF NOT EXISTS "${config.schema}"`);
      await tx.query(`CREATE TABLE IF NOT EXISTS migration_history (
        name text PRIMARY KEY, checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const applied = new Map<string, string>(
        (await tx.query("SELECT name,checksum FROM migration_history")).rows.map(
          (row) => [row.name, row.checksum],
        ),
      );
      for (const name of applied.keys())
        if (!files.includes(name))
          throw new Error(`Applied migration is missing: ${name}`);
      for (const name of files) {
        const sql = await readFile(resolve(directory, name), "utf8");
        const checksum = createHash("sha256").update(sql).digest("hex");
        if (applied.has(name)) {
          if (applied.get(name) !== checksum)
            throw new Error(`Applied migration was changed: ${name}`);
          continue;
        }
        // 001 is idempotent, so existing M1 databases can acquire a ledger safely.
        await tx.query(sql);
        await tx.query(
          "INSERT INTO migration_history(name,checksum) VALUES($1,$2)",
          [name, checksum],
        );
      }
    });
  }
  query<T extends QueryResultRow = any>(sql: string, values?: unknown[]) {
    return this.pool.query<T>(sql, values);
  }
  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const tx = await this.pool.connect();
    try {
      await tx.query("BEGIN");
      const result = await fn(tx);
      await tx.query("COMMIT");
      return result;
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
  }
  async onModuleDestroy() {
    await this.pool.end();
  }
}
