/**
 * Client behaviour for the custom comment section.
 *
 * Replaces the old "re-fetch the whole page and splice one <li>" trick:
 *  - a reply is a normal submit with `parentId`,
 *  - after an approved submit the list is rebuilt from the public JSON API
 *    (`GET /_emdash/api/comments/:collection/:id?threaded=true`, a few hundred
 *    bytes) plus the reaction counts, using the same template the server used,
 *  - likes talk to EmDash's own reactions endpoint,
 *  - Turnstile (when a site key is configured) is read at submit time and reset
 *    after every attempt, because its token is single-use.
 *
 * Nothing here touches the page itself, so no navigation and no document
 * re-fetch is involved.
 */

import {
  commentListHtml,
  headingFor,
  type CommentLabels,
  type CommentNode,
} from "./render";

interface SectionConfig {
  collection: string;
  contentId: string;
  reactions: boolean;
  locale: string;
  timeZone?: string;
  labels: CommentLabels;
  endpoint: string;
  allowReply: boolean;
}

interface ApiSuccess<T> {
  success: true;
  data: T;
}

interface ApiFailure {
  success: false;
  error?: { code?: string; message?: string };
}

interface CommentListPayload {
  items: CommentNode[];
  total: number;
  nextCursor?: string;
}

interface ReactionPayload {
  reactions?: Record<string, Record<string, number>>;
  viewer?: Record<string, string[]>;
}

const SUBMIT_HEADERS = {
  "Content-Type": "application/json",
  "X-EmDash-Request": "1",
};

export function initCommentSection(): void {
  const root = document.querySelector<HTMLElement>("[data-ec-comments]");
  if (!root || root.dataset.ecReady === "1") return;
  root.dataset.ecReady = "1";

  const form = root.querySelector<HTMLFormElement>("[data-ec-form]");
  const listSlot = root.querySelector<HTMLElement>("[data-ec-list]");
  const heading = root.querySelector<HTMLElement>("[data-ec-heading]");
  if (!listSlot) return;

  // Non-null bindings for the closures below (TS does not keep the guard's
  // narrowing alive inside functions defined after it).
  const section: HTMLElement = root;
  const list: HTMLElement = listSlot;

  const config: SectionConfig = {
    collection: root.dataset.collection ?? "",
    contentId: root.dataset.contentId ?? "",
    reactions: root.dataset.reactions === "true",
    locale: root.dataset.locale ?? "en-US",
    timeZone: root.dataset.timeZone || undefined,
    labels: JSON.parse(root.dataset.labels ?? "{}") as CommentLabels,
    allowReply: root.dataset.allowReply !== "false",
    endpoint:
      root.dataset.endpoint ??
      `/_emdash/api/comments/${encodeURIComponent(root.dataset.collection ?? "")}/${encodeURIComponent(root.dataset.contentId ?? "")}`,
  };
  const { labels } = config;

  const reactionsUrl = `${config.endpoint}/reactions`;
  const listUrl = `${config.endpoint}?threaded=true`;

  const statusEl = form?.querySelector<HTMLElement>("[data-ec-status]") ?? null;
  const textarea = form?.querySelector<HTMLTextAreaElement>("textarea[name='body']") ?? null;
  const parentInput = form?.querySelector<HTMLInputElement>("[data-ec-parent-id]") ?? null;
  const replyNote = form?.querySelector<HTMLElement>("[data-ec-reply-note]") ?? null;
  const replyTarget = form?.querySelector<HTMLElement>("[data-ec-reply-target]") ?? null;
  const submitBtn = form?.querySelector<HTMLButtonElement>("[data-ec-submit]") ?? null;

  let busy = false;
  let total = Number(root.dataset.total ?? 0);

  function setStatus(message: string, kind: "ok" | "error" | "info"): void {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.className = "ec-status";
    if (message) statusEl.classList.add(`ec-status--${kind}`);
  }

  function setHeading(): void {
    if (heading) heading.textContent = headingFor(labels, total);
  }

  function render(items: CommentNode[], newCommentId: string | null): void {
    list.innerHTML = commentListHtml(items, {
      labels,
      reactions: config.reactions,
      locale: config.locale,
      timeZone: config.timeZone,
      newCommentId,
      allowReply: config.allowReply,
    });
  }

  function highlight(commentId: string): void {
    const el = list.querySelector<HTMLElement>(`#comment-${CSS.escape(commentId)}`);
    if (!el) return;
    el.classList.add("ec-item--new");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function setLikes(counts: Record<string, Record<string, number>> | undefined): void {
    if (!counts) return;
    for (const [commentId, value] of Object.entries(counts)) {
      const btn = list.querySelector<HTMLElement>(
        `[data-ec-like][data-comment-id="${CSS.escape(commentId)}"]`,
      );
      if (!btn) continue;
      const countEl = btn.querySelector<HTMLElement>("[data-ec-like-count]");
      if (countEl) countEl.textContent = String(value.like ?? 0);
    }
  }

  function setViewer(viewer: Record<string, string[]> | undefined): void {
    if (!viewer) return;
    for (const [commentId, reactions] of Object.entries(viewer)) {
      const btn = list.querySelector<HTMLElement>(
        `[data-ec-like][data-comment-id="${CSS.escape(commentId)}"]`,
      );
      if (!btn) continue;
      btn.setAttribute("aria-pressed", reactions.includes("like") ? "true" : "false");
    }
  }

  async function loadReactions(): Promise<void> {
    if (!config.reactions) return;
    try {
      const res = await fetch(reactionsUrl, { headers: { "X-EmDash-Request": "1" } });
      if (!res.ok) return;
      const payload = (await res.json()) as ApiSuccess<ReactionPayload>;
      const data = payload.data ?? {};
      setLikes(data.reactions);
      setViewer(data.viewer);
    } catch {
      // Likes are decorative; a failure here must not break the comment list.
    }
  }

  async function refresh(newCommentId: string | null): Promise<void> {
    const response = await fetch(listUrl, {
      headers: { "X-EmDash-Request": "1" },
      cache: "no-store",
    });
    if (!response.ok) return;
    const payload = (await response.json()) as ApiSuccess<CommentListPayload> | ApiFailure;
    if (!payload.success) return;
    total = payload.data.total;
    render(payload.data.items, newCommentId);
    setHeading();
    await loadReactions();
    if (newCommentId) highlight(newCommentId);
  }

  function cancelReply(): void {
    if (parentInput) parentInput.value = "";
    if (replyNote) replyNote.hidden = true;
    section.querySelector(".ec-item--target")?.classList.remove("ec-item--target");
    if (submitBtn) submitBtn.textContent = labels.submit;
  }

  function startReply(commentId: string, authorName: string): void {
    if (!config.allowReply || !form || !parentInput || !textarea) return;
    cancelReply();
    parentInput.value = commentId;
    if (replyTarget) {
      replyTarget.textContent = labels.replyTo.replace("{name}", authorName);
    }
    if (replyNote) replyNote.hidden = false;
    if (submitBtn) submitBtn.textContent = labels.reply;
    list
      .querySelector<HTMLElement>(`#comment-${CSS.escape(commentId)}`)
      ?.classList.add("ec-item--target");
    form.scrollIntoView({ behavior: "smooth", block: "center" });
    textarea.focus({ preventScroll: true });
  }

  function readTurnstileToken(): string | undefined {
    const input = form?.querySelector<HTMLInputElement>(
      "input[name='cf-turnstile-response']",
    );
    return input?.value || undefined;
  }

  function resetTurnstile(): void {
    const turnstile = (window as unknown as { turnstile?: { reset: () => void } }).turnstile;
    try {
      turnstile?.reset();
    } catch {
      // A widget that failed to render has nothing to reset.
    }
  }

  function errorMessage(code: string | undefined, fallback: string | undefined): string {
    if (code && labels.errors?.[code]) return labels.errors[code];
    return fallback || labels.error;
  }

  async function submitForm(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!form || busy) return;
    busy = true;

    const body: Record<string, string> = { body: textarea?.value.trim() ?? "" };
    for (const name of ["authorName", "authorEmail", "website_url"]) {
      const input = form.querySelector<HTMLInputElement>(`input[name='${name}']`);
      if (input?.value) body[name] = input.value;
    }
    // Signed-in visitors: EmDash trusts locals.user, so the dataset wins.
    if (form.dataset.userName) body.authorName = form.dataset.userName;
    if (form.dataset.userEmail) body.authorEmail = form.dataset.userEmail;
    if (parentInput?.value) body.parentId = parentInput.value;
    const token = readTurnstileToken();
    if (token) body.turnstileToken = token;

    if (!body.body) {
      setStatus(labels.error, "error");
      busy = false;
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = labels.submitting;
    }
    setStatus("", "info");

    try {
      const response = await fetch(config.endpoint, {
        method: "POST",
        headers: SUBMIT_HEADERS,
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as
        | ApiSuccess<{ id?: string; status?: string }>
        | ApiFailure;

      if (!response.ok || !payload.success) {
        const failure = payload as ApiFailure;
        setStatus(errorMessage(failure.error?.code, failure.error?.message), "error");
        return;
      }

      const { id, status } = payload.data;
      if (textarea) textarea.value = "";

      if (status === "approved" && id) {
        cancelReply();
        setStatus(labels.published, "ok");
        await refresh(id);
      } else {
        // Held for moderation, or silently accepted by the honeypot.
        cancelReply();
        setStatus(labels.pending, "info");
      }
    } catch {
      setStatus(labels.networkError, "error");
    } finally {
      resetTurnstile();
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = parentInput?.value ? labels.reply : labels.submit;
      }
      busy = false;
    }
  }

  if (form) {
    form.addEventListener("submit", submitForm);
  }

  root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const replyBtn = target.closest<HTMLElement>("[data-ec-reply]");
    if (replyBtn) {
      startReply(
        replyBtn.dataset.commentId ?? "",
        replyBtn.dataset.authorName ?? "",
      );
      return;
    }

    if (target.closest("[data-ec-cancel-reply]")) {
      cancelReply();
      if (textarea) textarea.focus();
      return;
    }

    const likeBtn = target.closest<HTMLElement>("[data-ec-like]");
    if (likeBtn) {
      void toggleLike(likeBtn);
    }
  });

  async function toggleLike(btn: HTMLElement): Promise<void> {
    if (btn.dataset.busy === "1") return;
    btn.dataset.busy = "1";
    try {
      const response = await fetch(reactionsUrl, {
        method: "POST",
        headers: SUBMIT_HEADERS,
        body: JSON.stringify({
          commentId: btn.dataset.commentId,
          reaction: "like",
        }),
      });
      if (!response.ok) return;
      const payload = (await response.json()) as ApiSuccess<{
        reacted: boolean;
        counts: Record<string, number>;
      }>;
      if (!payload.success) return;
      btn.setAttribute("aria-pressed", payload.data.reacted ? "true" : "false");
      const countEl = btn.querySelector<HTMLElement>("[data-ec-like-count]");
      if (countEl) countEl.textContent = String(payload.data.counts?.like ?? 0);
    } catch {
      // Ignore: the button simply keeps its previous state.
    } finally {
      delete btn.dataset.busy;
    }
  }

  // Initial paint: the server already rendered the list and its counts, so only
  // the viewer's own reaction state has to be fetched.
  setHeading();
  if (config.reactions) void loadReactions();
}