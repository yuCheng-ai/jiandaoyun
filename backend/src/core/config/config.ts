import { existsSync } from "node:fs";
import { resolve } from "node:path";

// 按优先级向上查找并加载本地 .env 环境变量文件
const envCandidates = [
  resolve(__dirname, "../../../../../.env"),
  resolve(__dirname, "../../../../.env"),
  resolve(__dirname, "../../../.env"),
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../.env"),
];

const envFile = envCandidates.find((path) => existsSync(path));
if (envFile) {
  process.loadEnvFile(envFile);
}

/** 服务端运行期核心配置项 */
export const config = {
  databaseUrl: process.env.DATABASE_URL || "",
  schema: process.env.DATABASE_SCHEMA || "public",
  port: Number(process.env.PORT || 3001),
  host: process.env.HOST || "127.0.0.1",
  origin: process.env.APP_ORIGIN || "http://127.0.0.1:5198",
  secureCookie: process.env.COOKIE_SECURE === "true",
};
