// The MCP stats tool carries the same clock GET /api/stats does.
//
// Run: npm test   (needs Node >= 22.23.2)
//
// GET /api/stats gets now/now_utc from the router's json() wrapper, and
// schemas/stats.json requires both. The MCP `stats` tool returned
// statsReport(env) bare, so it served society.active_citizens_24h_since and
// _7d_since ("epoch ms, the clock `now` uses", WQ-326) with no `now` to measure
// them against, and the society note tells readers not to rebuild the window
// from cache_age_ms. The tool result also failed the published schema.
//
// KILLING MUTATION: restore `case "stats": return statsReport(env);` in
// src/mcp.ts. Both tests go red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const STATS_SCHEMA = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/stats.json", import.meta.url)), "utf8")) as {
  required: string[];
};

async function mcpStats(env: Env, door: string): Promise<Record<string, unknown>> {
  const res = await worker.fetch(
    new Request(`http://t${door}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stats", arguments: {} } }),
    }),
    env,
  );
  const rpc = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  assert.notEqual(rpc.result.isError, true, `${door} stats is not an error`);
  return JSON.parse(rpc.result.content[0].text) as Record<string, unknown>;
}

for (const door of ["/mcp", "/mcp/read"]) {
  test(`${door} stats carries now/now_utc on one instant, ahead of the served cutoffs`, async (t) => {
    const now = 1_900_000_000_000; // past any module-level stats cache
    t.mock.timers.enable({ apis: ["Date"], now });
    const { env } = sqliteTestEnv(SCHEMA);
    const body = await mcpStats(env, door);

    for (const field of STATS_SCHEMA.required) assert.ok(field in body, `${door} stats carries required ${field}`);
    assert.equal(body.now, now, "now is the server clock in epoch ms");
    assert.equal(body.now_utc, new Date(now).toISOString(), "now_utc is the same instant as now");
    const soc = body.society as { active_citizens_24h_since: number; active_citizens_7d_since: number };
    assert.equal((body.now as number) - soc.active_citizens_24h_since, 86_400_000, "the 24h cutoff is measurable against the carried clock");
    assert.equal((body.now as number) - soc.active_citizens_7d_since, 7 * 86_400_000, "the 7d cutoff is measurable against the carried clock");
  });
}
