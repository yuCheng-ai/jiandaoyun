import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Pool, PoolClient, QueryResultRow } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { config } from "../config/config";

/** 数据库事务客户端类型别名 */
export type Transaction = PoolClient;

/** PostgreSQL 数据库连接池、自动迁移与事务封装服务 */
@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool: Pool;

  constructor() {
    if (!config.databaseUrl) {
      throw new Error("DATABASE_URL is required; run npm run setup:local.");
    }
    if (!/^[a-z][a-z0-9_]*$/.test(config.schema)) {
      throw new Error("Invalid database schema");
    }

    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 12,
      options: `-c search_path=${config.schema}`,
      connectionTimeoutMillis: 5000,
    });
  }

  /**
   * 按文件名顺序执行 SQL 迁移脚本：
   * - 使用事务级咨询锁（pg_advisory_xact_lock）串行化并发启动；
   * - 校验已执行迁移脚本的 SHA-256 摘要，防止历史迁移被篡改。
   */
  async migrate() {
    const migrationCandidates = [
      resolve(__dirname, "../../../../migrations"),
      resolve(__dirname, "../../migrations"),
      resolve(process.cwd(), "migrations"),
      resolve(process.cwd(), "backend/migrations"),
    ];
    const directory = migrationCandidates.find((p) => existsSync(p)) || migrationCandidates[0];
    const allFiles = await readdir(directory);
    const files = allFiles.filter((name) => /^\d{3}-[a-z0-9-]+\.sql$/.test(name)).sort();
    if (!files.length) {
      throw new Error("No database migrations found");
    }

    await this.transaction(async (tx) => {
      // 按数据库与 Schema 加事务级咨询锁，保证多实例启动时迁移串行执行
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(current_database() || '/' || $1, 0))",
        [config.schema],
      );
      await tx.query(`CREATE SCHEMA IF NOT EXISTS "${config.schema}"`);
      await tx.query(`
        CREATE TABLE IF NOT EXISTS migration_history (
          name text PRIMARY KEY,
          checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      const { rows } = await tx.query("SELECT name, checksum FROM migration_history");
      const applied = new Map<string, string>(rows.map((row) => [row.name, row.checksum]));

      for (const name of applied.keys()) {
        if (!files.includes(name)) {
          throw new Error(`Applied migration is missing: ${name}`);
        }
      }

      for (const name of files) {
        const sql = await readFile(resolve(directory, name), "utf8");
        const checksum = createHash("sha256").update(sql).digest("hex");

        if (applied.has(name)) {
          if (applied.get(name) !== checksum) {
            throw new Error(`Applied migration was changed: ${name}`);
          }
          continue;
        }

        // 001 脚本具备幂等性，支持存量数据库安全补齐迁移台账
        await tx.query(sql);
        await tx.query(
          "INSERT INTO migration_history (name, checksum) VALUES ($1, $2)",
          [name, checksum],
        );
      }
    });
  }

  /** 执行单条参数化 SQL 查询 */
  query<T extends QueryResultRow = any>(sql: string, values?: unknown[]) {
    return this.pool.query<T>(sql, values);
  }

  /** 在同一个数据库事务中执行回调，成功则提交，异常则自动回滚并释放连接 */
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

  /** 模块销毁时优雅关闭连接池 */
  async onModuleDestroy() {
    await this.pool.end();
  }
}
