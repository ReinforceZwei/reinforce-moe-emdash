import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LABELS,
  commentItemHtml,
  commentListHtml,
  formatCommentDate,
  headingFor,
  linkifyBody,
  type CommentNode,
} from "../src/lib/comments/render.ts";

const labels = { member: "member", like: "like", reply: "reply" };

function comment(overrides: Partial<CommentNode> = {}): CommentNode {
  return {
    id: "c1",
    parentId: null,
    authorName: "Name",
    isRegisteredUser: false,
    body: "Hi",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("comment bodies are escaped and only http(s) URLs become links", () => {
  const html = linkifyBody('<img src=x onerror="alert(1)"> see https://example.com/a?b=1');
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1" rel="nofollow ugc noopener"/);
  // javascript: and bare protocol text stay inert
  assert.doesNotMatch(linkifyBody("javascript:alert(1)"), /<a /);
});

test("author names are escaped", () => {
  const html = commentItemHtml(comment({ authorName: "<script>x</script>" }), { labels });
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("dates are formatted with an explicit time zone so client and server agree", () => {
  const iso = "2026-01-01T00:30:00.000Z";
  const utc = formatCommentDate(iso, "en-US", "UTC");
  const taipei = formatCommentDate(iso, "en-US", "Asia/Taipei");
  assert.notEqual(utc, taipei);
  assert.match(utc, /January 1, 2026/);
  assert.equal(formatCommentDate("not a date", "en-US", "UTC"), "not a date");
});

test("heading text follows the two templates", () => {
  const shape = { headingZero: "no comments", headingMany: "{count} comments" };
  assert.equal(headingFor(shape, 0), "no comments");
  assert.equal(headingFor(shape, 1), "1 comments");
  assert.equal(headingFor(shape, 7), "7 comments");
  assert.equal(headingFor(DEFAULT_LABELS, 2), "2 Comments");
});

test("threaded replies render inside the parent's list", () => {
  const parent = comment({
    id: "root",
    replies: [comment({ id: "r1", parentId: "root", body: "reply body" })],
  });
  const html = commentItemHtml(parent, { labels });
  assert.match(html, /<ol class="ec-list ec-list--replies">/);
  assert.match(html, /id="comment-r1"/);
  assert.match(html, /data-parent-id="root"/);
  // the reply sits after the parent's own actions, inside the parent <li>
  assert.ok(html.indexOf('id="comment-r1"') > html.indexOf('id="comment-root"'));
});

test("only top-level comments offer a Reply button", () => {
  const parent = comment({
    id: "root",
    replies: [comment({ id: "r1", parentId: "root" })],
  });
  const html = commentItemHtml(parent, { labels });
  const replyButtons = html.match(/data-ec-reply/g) ?? [];
  assert.equal(replyButtons.length, 1);
  // and it belongs to the root, not the reply
  assert.match(html, /data-ec-reply[^>]*data-comment-id="root"/);
});

test("reaction counts and the member badge appear when enabled", () => {
  const html = commentItemHtml(
    comment({ isRegisteredUser: true, reactions: { like: 3 } }),
    { labels, reactions: true },
  );
  assert.match(html, /data-ec-like-count>3</);
  assert.match(html, /class="ec-badge"/);
});

test("likes are omitted when reactions are off", () => {
  const html = commentItemHtml(comment(), { labels, reactions: false });
  assert.doesNotMatch(html, /data-ec-like/);
  assert.match(html, /data-ec-reply/);
});

test("the just-created comment is flagged for the arrival animation", () => {
  const html = commentItemHtml(comment({ id: "new" }), { labels, newCommentId: "new" });
  assert.match(html, /class="ec-item ec-item--new"/);
  assert.doesNotMatch(commentItemHtml(comment({ id: "old" }), { labels, newCommentId: "new" }), /ec-item--new/);
});

test("an empty list renders nothing, so the section can create it later", () => {
  assert.equal(commentListHtml([], { labels }), "");
  const html = commentListHtml([comment(), comment({ id: "c2" })], { labels });
  assert.equal((html.match(/<li class="ec-item/g) ?? []).length, 2);
});

test("reply buttons disappear once the closing window has passed", () => {
  const html = commentItemHtml(comment({ id: "root" }), { labels, allowReply: false });
  assert.doesNotMatch(html, /data-ec-reply/);
  // likes are unaffected: closing replies must not remove the rest of the UI
  assert.match(commentItemHtml(comment(), { labels, reactions: true, allowReply: false }), /data-ec-like/);
});
