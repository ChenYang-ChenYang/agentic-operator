import { existsSync } from "node:fs";

// Next assigns NODE_ENV from the command only when the variable is absent.
// The shared repository env intentionally defaults the runtime stack to
// development, so establish the framework-required value before loading it.
const command = process.argv[2];
if (command === "dev") process.env.NODE_ENV = "development";
if (command === "build" || command === "start") {
  process.env.NODE_ENV = "production";
}

// Next only auto-loads app-local env files. The API deliberately loads the
// repository env last, so load the canonical root first and then let the
// app-local file fill only values the root does not define. Session JWTs are
// verified exclusively by the API; this wrapper still keeps API origins and
// the rest of the shared runtime configuration aligned.
for (const file of ["../../.env", ".env.local"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

await import("next/dist/bin/next");
