// front_page and newest_feed declare `limit: { type: "integer" }`. Number(true)
// is 1 and Number([5]) is 5, so a boolean or array limit used to be served as a
// one-row or five-row page with no error. The guard must fire before D1 is
// touched and name the JSON type it refused; numbers and decimal strings keep
// working (the compatibility the HTTP doors promise for limit spellings).

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

const call = async (env: Env, name: string, args: Record<string, unknown>) => {
  const r = await worker.fetch(
    new Request("https://1f916.ai/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    env,
  );
  const raw = await r.text();
  const j = JSON.parse(raw) as { result?: { content: { text: string }[]; isError?: boolean } };
  // A request that got past the guard trips the D1 getter, which surfaces as a
  // non-tool error with no `result`; keep its raw text so the tests can tell.
  if (!j.result) return { isError: true, reachedD1: true, text: raw };
  return { isError: j.result.isError ?? false, reachedD1: false, text: j.result.content[0].text };
};

const noD1 = () =>
  Object.defineProperty({}, "DB", {
    get() {
      throw new Error("a coercible-type limit reached D1");
    },
  }) as Env;

for (const tool of ["front_page", "newest_feed"]) {
  for (const [label, value, type] of [
    ["true", true, "boolean"],
    ["false", false, "boolean"],
    ["[5]", [5], "array"],
    ["{}", {}, "object"],
  ] as const) {
    test(`${tool} refuses limit=${label} by its JSON type before D1`, async () => {
      const out = await call(noD1(), tool, { limit: value });
      assert.equal(out.isError, true, `limit=${label} must not be read as a row count`);
      assert.match(out.text, /limit must be a positive integer/);
      assert.match(out.text, new RegExp(`sent a JSON ${type}`));
      assert.equal(out.reachedD1, false, "the refusal happens before D1 is touched");
    });
  }

  test(`${tool} still reads a number or decimal-string limit (guard passes them to D1)`, async () => {
    for (const value of [5, "5"]) {
      const out = await call(noD1(), tool, { limit: value });
      // Past the guard, the only thing left to fail is the D1 tripwire.
      assert.doesNotMatch(out.text, /sent a JSON/, `limit=${JSON.stringify(value)} is a valid spelling`);
      assert.equal(out.reachedD1, true, `limit=${JSON.stringify(value)} passes the guard and reaches D1`);
    }
  });
}
