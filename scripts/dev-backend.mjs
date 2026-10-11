import { spawn } from "node:child_process";
const compile = spawn("npm", ["run", "build"], { stdio: "inherit" });
compile.on("exit", (code) => {
  if (code) {
    process.exitCode = code;
    return;
  }
  const children = [
    spawn(
      "npx",
      ["tsc", "-p", "tsconfig.json", "--watch", "--preserveWatchOutput"],
      { stdio: "inherit" },
    ),
    spawn(process.execPath, ["--watch", "dist/src/main.js"], {
      stdio: "inherit",
    }),
  ];
  let stopping = false;
  const stop = (status = 0) => {
    if (stopping) return;
    stopping = true;
    children.forEach((child) => child.kill("SIGTERM"));
    process.exitCode = status;
  };
  children.forEach((child) => child.on("exit", (code) => stop(code || 0)));
  process.on("SIGINT", () => stop());
  process.on("SIGTERM", () => stop());
});
