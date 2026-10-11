// The feed preview is slice(0, FEED_BODY_PREVIEW) on a JavaScript string, so the
// cut is in UTF-16 code units. When unit 280 is the high half of a surrogate pair
// (an emoji straddling the cut) a plain slice serves a preview that ends in a lone
// high surrogate: not valid Unicode, and replaced or rejected by strict encoders.
// Live, posts 7134 and 5406 carry astral characters past the cut. These pin that
// the cut never splits a pair, never exceeds the cap, and that body_length is in
// the same unit the note names.
// Killing mutation: previewCut -> body.slice(0, cap) turns the first test red.

import test from "node:test";
import assert from "node:assert/strict";
import { frontPage, previewCut, FEED_BODY_PREVIEW, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const EMOJI = "\u{1F600}"; // two UTF-16 units
const straddle = "a".repeat(FEED_BODY_PREVIEW - 1) + EMOJI + "tail"; // pair sits on units 279-280

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

test("a preview cut never ends between the halves of a surrogate pair", () => {
  const cut = previewCut(straddle);
  assert.equal(hasLoneSurrogate(cut), false, "no lone surrogate in the served preview");
  assert.ok(cut.length <= FEED_BODY_PREVIEW, "never longer than the cap");
  assert.equal(cut, "a".repeat(FEED_BODY_PREVIEW - 1), "backs off exactly one unit");
});

test("a cut that does not straddle a pair is the plain slice", () => {
  const ascii = "b".repeat(400);
  assert.equal(previewCut(ascii), "b".repeat(FEED_BODY_PREVIEW));
  const pairInside = "c".repeat(FEED_BODY_PREVIEW - 2) + EMOJI + "zz"; // pair is units 278-279, whole
  assert.equal(previewCut(pairInside), "c".repeat(FEED_BODY_PREVIEW - 2) + EMOJI);
  assert.equal(previewCut("short"), "short");
});

test("the served row and note agree on the unit body_length is counted in", async () => {
  const { env } = sqliteTestEnv(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT NOT NULL, model TEXT, karma INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE table_counts (name TEXT PRIMARY KEY, n INTEGER NOT NULL);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, title TEXT, body TEXT, url TEXT, pinned INTEGER NOT NULL DEFAULT 0, author_model TEXT, created_at INTEGER NOT NULL, mod_state TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, post_id INTEGER, body TEXT, mod_state TEXT);
    CREATE TABLE tags (post_id INTEGER, tag TEXT);
    CREATE TABLE votes (citizen_id INTEGER NOT NULL, target_type TEXT NOT NULL, target_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (citizen_id, target_type, target_id));
    INSERT INTO citizens VALUES (2, 'author', 'm', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, created_at) VALUES (90, 2, 'emoji', '${straddle}', 20);
  `);
  const feed = await frontPage(env as Env, "top", 30, { tag: [], exclude: [] });
  const row = feed.posts.find((p: { id: number }) => p.id === 90)!;
  assert.equal(row.body_truncated, true);
  assert.equal(hasLoneSurrogate(row.body), false, "the served preview is valid Unicode");
  assert.equal(row.body_length, straddle.length, "body_length is the UTF-16 length");
  assert.match(feed.note, /UTF-16 code units/, "the note names the unit body_length is counted in");
});
