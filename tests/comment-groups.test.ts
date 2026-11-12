import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadGroups, setCommentStatus, deleteComment, type Comment } from "../src/plugins/comment-groups/data.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function comment(id: string, collection = "posts", contentId = "post-1", status: Comment["status"] = "pending"): Comment {
  return { id, collection, contentId, status, parentId: null, authorName: "Name", authorEmail: "a@example.com", body: "Hi", createdAt: "2026-01-01", updatedAt: "2026-01-01" };
}
function ok(data: unknown): Response { return Response.json({ success: true, data }); }
function failure(status: number, message = "failure"): Response {
  return Response.json({ success: false, error: { code: "ERROR", message } }, { status });
}
function item(title: string, slug: string, status = "published"): Response {
  return ok({ item: { data: { title }, slug, status } });
}

test("traverses pages and groups the same post once with the site's actual URL", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input); calls.push(path);
    assert.equal(init?.credentials, "same-origin");
    assert.equal(new Headers(init?.headers).get("X-EmDash-Request"), "1");
    const url = new URL(path, "https://example.test");
    if (url.pathname.endsWith("/admin/comments")) {
      assert.equal(url.searchParams.get("status"), "pending");
      assert.equal(url.searchParams.get("limit"), "100");
      return url.searchParams.has("cursor")
        ? ok({ items: [comment("2") ] })
        : ok({ items: [comment("1")], nextCursor: "a+b/=" });
    }
    assert.equal(url.pathname, "/_emdash/api/content/posts/post-1");
    return item("Post title", "繁體 post");
  };
  const groups = await loadGroups("pending");
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].comments.map(c => c.id), ["1", "2"]);
  assert.equal(groups[0].title, "Post title");
  assert.equal(groups[0].url, `/blog/${encodeURIComponent("繁體 post")}`);
  assert.equal(calls.length, 3);
  assert.equal(new URL(calls[1], "https://example.test").searchParams.get("cursor"), "a+b/=");
});

test("all explicitly requests all statuses and deduplicates comments", async () => {
  const seen: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://example.test");
    if (url.pathname.endsWith("/admin/comments")) {
      const status = url.searchParams.get("status") as Comment["status"];
      seen.push(status);
      return ok({ items: [comment(status, "posts", "post-1", status), ...(status === "approved" ? [comment("pending", "posts", "post-1", status)] : [])] });
    }
    return item("Title", "slug");
  };
  const groups = await loadGroups("all");
  assert.deepEqual(seen.sort(), ["approved", "pending", "spam", "trash"]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].comments.map(c => c.id).sort(), ["approved", "pending", "spam", "trash"]);
});

test("uses collision-safe keys and encodes path components", async () => {
  const contentRequests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://example.test");
    if (url.pathname.endsWith("/admin/comments")) return ok({ items: [
      comment("1", "a/b", "c?d"), comment("2", "a", "b/c?d"), comment("3", "pages", "p#1"),
    ] });
    contentRequests.push(url.pathname);
    return item("A title", "page #1");
  };
  const groups = await loadGroups("pending");
  assert.equal(groups.length, 3);
  assert.deepEqual(contentRequests.sort(), ["/_emdash/api/content/a%2Fb/c%3Fd", "/_emdash/api/content/a/b%2Fc%3Fd", "/_emdash/api/content/pages/p%231"].sort());
  assert.equal(groups.find(g => g.collection === "pages")?.url, "/page%20%231");
  assert.equal(groups.find(g => g.collection === "a/b")?.url, null);
});

test("missing and inaccessible content use fallback; drafts are not linked", async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://example.test");
    if (url.pathname.endsWith("/admin/comments")) return ok({ items: [comment("1", "posts", "gone"), comment("2", "posts", "secret"), comment("3", "posts", "draft")] });
    if (url.pathname.endsWith("/gone")) return failure(404);
    if (url.pathname.endsWith("/secret")) return failure(403);
    return item("Draft title", "draft-slug", "draft");
  };
  const groups = await loadGroups("pending");
  assert.deepEqual(groups.map(g => [g.title, g.url]), [["posts / gone", null], ["posts / secret", null], ["Draft title", null]]);
});

test("failed later pages, malformed pages and cursor loops reject instead of returning partial counts", async () => {
  for (const second of [failure(500, "database failed"), ok({ items: "bad" }), ok({ items: [comment("2")], nextCursor: "same" }), ok({ items: [], nextCursor: "new" })]) {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input), "https://example.test");
      assert.ok(url.pathname.endsWith("/admin/comments"));
      return url.searchParams.has("cursor") ? second : ok({ items: [comment("1")], nextCursor: "same" });
    };
    await assert.rejects(loadGroups("pending"));
  }
});

test("all rejects a failure in any status and content server errors are not hidden", async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://example.test");
    if (url.searchParams.get("status") === "spam") return failure(500, "inbox failed");
    return ok({ items: [] });
  };
  await assert.rejects(loadGroups("all"), /inbox failed/);
  globalThis.fetch = async (input) => String(input).includes("/admin/comments?") ? ok({ items: [comment("1")] }) : failure(500, "content failed");
  await assert.rejects(loadGroups("pending"), /content failed/);
});

test("individual status PUT and delete use session, CSRF, escaped IDs, and propagate errors", async () => {
  const calls: { path: string; init: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => { calls.push({ path: String(input), init: init! }); return ok({}); };
  for (const status of ["pending", "approved", "spam", "trash"] as const) await setCommentStatus("id/#?", status);
  await deleteComment("id/#?");
  for (const [index, call] of calls.entries()) {
    assert.equal(call.init.credentials, "same-origin");
    assert.equal(new Headers(call.init.headers).get("X-EmDash-Request"), "1");
    assert.equal(call.path, `/_emdash/api/admin/comments/id%2F%23%3F${index < 4 ? "/status" : ""}`);
    if (index < 4) {
      assert.equal(call.init.method, "PUT");
      assert.equal(new Headers(call.init.headers).get("Content-Type"), "application/json");
      assert.deepEqual(JSON.parse(String(call.init.body)), { status: ["pending", "approved", "spam", "trash"][index] });
    } else assert.equal(call.init.method, "DELETE");
  }
  globalThis.fetch = async () => failure(409, "conflict");
  await assert.rejects(setCommentStatus("1", "approved"), /conflict/);
  await assert.rejects(deleteComment("1"), /conflict/);
});

test("rejects unsuccessful envelopes, invalid JSON and unexpected comment status", async () => {
  globalThis.fetch = async () => Response.json({ success: false, error: { message: "not allowed" } });
  await assert.rejects(loadGroups("pending"), /not allowed/);
  globalThis.fetch = async () => new Response("not json", { status: 200 });
  await assert.rejects(loadGroups("pending"), /invalid JSON/);
  globalThis.fetch = async () => ok({ items: [comment("1", "posts", "1", "spam")] });
  await assert.rejects(loadGroups("pending"), /Invalid comment page/);
});
