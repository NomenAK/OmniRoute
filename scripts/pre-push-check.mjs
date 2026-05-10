import { execFileSync } from "node:child_process";

const env = {
  ...process.env,
  DISABLE_SQLITE_AUTO_BACKUP: "true",
};

function run(label, command, args) {
  process.stdout.write(`\n[pre-push] ${label}\n`);
  execFileSync(command, args, { stdio: "inherit", env });
}

run("PR test policy", "node", ["scripts/check-pr-test-policy.mjs"]);
run("migration, Claude wire-image, and fallback unit smoke", "node", [
  "--import",
  "tsx/esm",
  "--test",
  "--test-concurrency=1",
  "tests/unit/db-migration-runner.test.ts",
  "tests/unit/cc-compatible-provider.test.ts",
  "tests/unit/account-fallback-service.test.ts",
]);
run("SSE auth fallback unit smoke", "node", [
  "--import",
  "tsx/esm",
  "--test",
  "--test-concurrency=1",
  "--test-name-pattern=markAccountUnavailable",
  "tests/unit/sse-auth.test.ts",
]);

process.stdout.write(
  "\n[pre-push] PASS - fast hook checks completed. Full unit suite remains npm run test:unit for CI.\n"
);
