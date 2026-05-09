import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../../src/mitm/server.cjs", import.meta.url), "utf8");

function extractFunction(name: string) {
  const start = source.indexOf(`function ${name}()`);
  assert.notEqual(start, -1);

  const open = source.indexOf("{", start);
  assert.notEqual(open, -1);

  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }

  throw new Error(`Unable to extract ${name}`);
}

const getLocalPortSource = extractFunction("getLocalPort");

function resolveLocalPort(value?: string) {
  const env: Record<string, string> = {};
  if (value !== undefined) env.MITM_LOCAL_PORT = value;

  return vm.runInNewContext(`${getLocalPortSource}\ngetLocalPort();`, { process: { env } });
}

test("MITM local port reads process.env.MITM_LOCAL_PORT", () => {
  assert.match(source, /process\.env\.MITM_LOCAL_PORT/);
  assert.match(source, /const LOCAL_PORT = getLocalPort\(\);/);
});

test("MITM local port falls back to 443 when env is missing or empty", () => {
  assert.equal(resolveLocalPort(), 443);
  assert.equal(resolveLocalPort(""), 443);
  assert.equal(resolveLocalPort("   "), 443);
});

test("MITM local port accepts valid integer strings in range", () => {
  assert.equal(resolveLocalPort("1"), 1);
  assert.equal(resolveLocalPort("443"), 443);
  assert.equal(resolveLocalPort("20128"), 20128);
  assert.equal(resolveLocalPort("65535"), 65535);
  assert.equal(resolveLocalPort(" 8443 "), 8443);
});

test("MITM local port falls back for invalid, non-integer, and out-of-range values", () => {
  for (const value of ["0", "65536", "-1", "12.5", "1e2", "0x10", "abc", "NaN"]) {
    assert.equal(resolveLocalPort(value), 443);
  }
});
