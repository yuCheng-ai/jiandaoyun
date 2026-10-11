import { existsSync } from "node:fs";
import { resolve } from "node:path";
const env = resolve(__dirname, "../../../.env");
if (existsSync(env)) process.loadEnvFile(env);
export const config = {
  databaseUrl: process.env.DATABASE_URL || "",
  schema: process.env.DATABASE_SCHEMA || "public",
  port: Number(process.env.PORT || 3001),
  host: process.env.HOST || "127.0.0.1",
  origin: process.env.APP_ORIGIN || "http://127.0.0.1:5198",
  secureCookie: process.env.COOKIE_SECURE === "true",
};
