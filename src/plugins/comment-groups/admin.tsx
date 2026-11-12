import { useEffect, useRef, useState } from "react";
import { deleteComment, loadGroups, setCommentStatus, type Comment, type Group } from "./data.ts";
import "./admin.css";

type Status = Comment["status"];
type Filter = Status | "all";

const filters: { value: Filter; label: string }[] = [
	{ value: "pending", label: "Pending" },
	{ value: "approved", label: "Approved" },
	{ value: "spam", label: "Spam" },
	{ value: "trash", label: "Trash" },
	{ value: "all", label: "All" },
];

function errorMessage(error: unknown): string {
	return error instanceof Error && error.message ? error.message : "Please try again.";
}

// Content URLs come from the API. Never put an untrusted javascript: URL in href.
function safeUrl(url: string | null): string | null {
	if (!url) return null;
	try {
		const parsed = new URL(url, window.location.origin);
		return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password
			? parsed.href : null;
	} catch {
		return null;
	}
}

function formatDate(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function CommentGroupsPage() {
	const [filter, setFilter] = useState<Filter>("pending");
	const [groups, setGroups] = useState<Group[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [revision, setRevision] = useState(0);
	const [busyId, setBusyId] = useState<string | null>(null);
	const busy = useRef(false);

	useEffect(() => {
		let active = true;
		setLoading(true);
		setError(null);
		loadGroups(filter).then((result) => {
			if (active) setGroups(result);
		}).catch((cause: unknown) => {
			if (active) {
				setGroups([]);
				setError(`Could not load comments: ${errorMessage(cause)}`);
			}
		}).finally(() => {
			if (active) setLoading(false);
		});
		return () => { active = false; };
	}, [filter, revision]);

	async function moderate(comment: Comment, status: Status | "delete") {
		if (busy.current) return;
		if (status === "delete" && !window.confirm("Permanently delete this comment and its replies? This cannot be undone.")) return;
		busy.current = true;
		setBusyId(comment.id);
		setError(null);
		setNotice(null);
		try {
			if (status === "delete") await deleteComment(comment.id);
			else await setCommentStatus(comment.id, status);
			setNotice(status === "delete" ? "Comment permanently deleted." : `Comment moved to ${status}.`);
			// Reload the complete filtered dataset, rather than inventing counts or assuming
			// how the API applies moderation side effects.
			setRevision((value) => value + 1);
		} catch (cause) {
			setError(`Could not update comment: ${errorMessage(cause)}`);
		} finally {
			busy.current = false;
			setBusyId(null);
		}
	}

	return (
		<main className="comment-groups">
			<header className="comment-groups__header">
				<div>
					<h1>Comments by post</h1>
					<p>Review comments grouped by their content entry.</p>
				</div>
				<button type="button" disabled={loading || busyId !== null} onClick={() => { setNotice(null); setRevision((value) => value + 1); }}>Refresh</button>
			</header>
			<div className="comment-groups__controls">
				<label htmlFor="comment-groups-status">Status</label>
				<select id="comment-groups-status" value={filter} disabled={busyId !== null} onChange={(event) => { setNotice(null); setFilter(event.target.value as Filter); }}>
					{filters.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
				</select>
			</div>
			{notice && <p className="comment-groups__notice" role="status">{notice}</p>}
			{error && <p className="comment-groups__error" role="alert">{error}</p>}
			{loading ? <p role="status">Loading comments…</p> : !error && groups.length === 0 ? (
				<p>No comments match this status.</p>
			) : !loading && groups.length > 0 ? (
				<section aria-label="Comment groups" aria-busy={busyId !== null}>
					<p className="comment-groups__summary">{groups.length} {groups.length === 1 ? "entry" : "entries"} with comments matching this filter</p>
					{groups.map((group) => {
						const href = safeUrl(group.url);
						return (
							<details className="comment-groups__group" key={JSON.stringify([group.collection, group.contentId])}>
								<summary>
									<strong>{group.title}</strong>
									<span>{group.comments.length} {group.comments.length === 1 ? "comment" : "comments"}</span>
									<span className="comment-groups__meta">{group.collection} · {group.contentId}</span>
								</summary>
								<div className="comment-groups__group-content">
									{href ? <a href={href} target="_blank" rel="noopener noreferrer">View entry <span className="comment-groups__visually-hidden">{group.title} (opens in a new tab)</span></a> : <p className="comment-groups__meta">Entry link unavailable</p>}
									<ul className="comment-groups__list">
										{group.comments.map((comment) => (
											<li key={comment.id} className="comment-groups__comment">
												<div className="comment-groups__comment-header">
													<strong>{comment.authorName || "Anonymous"}</strong>
													<span className="comment-groups__badge">{comment.status}</span>
													<time dateTime={comment.createdAt}>{formatDate(comment.createdAt)}</time>
												</div>
												{comment.authorEmail && <p className="comment-groups__meta">{comment.authorEmail}</p>}
												{comment.parentId && <p className="comment-groups__meta">Reply to comment {comment.parentId}</p>}
												<p className="comment-groups__body">{comment.body}</p>
												<div className="comment-groups__actions" role="group" aria-label={`Actions for comment by ${comment.authorName || "Anonymous"}`}>
													{comment.status !== "approved" && <button type="button" disabled={busyId !== null} onClick={() => void moderate(comment, "approved")}>Approve</button>}
													{comment.status !== "pending" && <button type="button" disabled={busyId !== null} onClick={() => void moderate(comment, "pending")}>{comment.status === "trash" ? "Restore to pending" : "Mark pending"}</button>}
													{comment.status !== "spam" && comment.status !== "trash" && <button type="button" disabled={busyId !== null} onClick={() => void moderate(comment, "spam")}>Mark spam</button>}
													{comment.status !== "trash" ? <button type="button" disabled={busyId !== null} onClick={() => void moderate(comment, "trash")}>Move to trash</button> : <button type="button" disabled={busyId !== null} onClick={() => void moderate(comment, "delete")}>Delete permanently</button>}
													{busyId === comment.id && <span role="status">Updating…</span>}
												</div>
											</li>
										))}
									</ul>
								</div>
							</details>
						);
					})}
				</section>
			) : null}
		</main>
	);
}

// EmDash looks up the component by the declared page path.
export const pages = { "/comments": CommentGroupsPage };
