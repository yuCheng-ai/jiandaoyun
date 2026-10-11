import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const file = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(file)) {
  console.log("Existing .env preserved.");
} else {
  const secret = () => randomBytes(24).toString("base64url");
  const db = secret();
  writeFileSync(
    file,
    [
      `PLATFORM_DB_PASSWORD=${db}`,
      `DATABASE_URL=postgresql://platform:${db}@127.0.0.1:55432/platform`,
      `PLATFORM_ADMIN_PASSWORD=${secret()}`,
      `PLATFORM_EDITOR_PASSWORD=${secret()}`,
      `PLATFORM_REVIEWER_PASSWORD=${secret()}`,
      "PORT=3001",
      "HOST=127.0.0.1",
      "APP_ORIGIN=http://127.0.0.1:5198",
      "",
    ].join("\n"),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    "Local PostgreSQL and account credentials created in .env (not printed).",
  );
}
