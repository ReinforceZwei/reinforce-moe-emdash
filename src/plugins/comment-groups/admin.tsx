import { type ReactNode, useEffect, useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Badge,
	type BadgeVariant,
	Banner,
	Button,
	Collapsible,
	Dialog,
	Empty,
	InputGroup,
	LayerCard,
	LinkButton,
	RefreshButton,
	SkeletonLine,
	Tabs,
	Text,
	useKumoToastManager,
} from "@cloudflare/kumo";
import {
	ArrowSquareOutIcon,
	CaretRightIcon,
	ChatCircleDotsIcon,
	CheckCircleIcon,
	ClockCounterClockwiseIcon,
	MagnifyingGlassIcon,
	ProhibitIcon,
	TrashIcon,
	TrashSimpleIcon,
} from "@phosphor-icons/react";

import {
	deleteComment,
	fetchComments,
	fetchEntries,
	fetchStatusCounts,
	setCommentStatus,
	type StatusCounts,
} from "./data.ts";
import {
	type Comment,
	type CommentGroup,
	type CommentStatus,
	distinctEntries,
	entryKey,
	groupComments,
	type StatusFilter,
} from "./shared.ts";
import "./admin.css";

const ROOT_KEY = ["comment-groups"] as const;
const countsKey = [...ROOT_KEY, "counts"] as const;
const commentsKey = (filter: StatusFilter, search: string) => [...ROOT_KEY, "comments", filter, search] as const;

const FILTERS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
	{ value: "pending", label: "Pending" },
	{ value: "approved", label: "Approved" },
	{ value: "spam", label: "Spam" },
	{ value: "trash", label: "Trash" },
	{ value: "all", label: "All" },
];

const STATUS_BADGE: Record<CommentStatus, { label: string; variant: BadgeVariant }> = {
	pending: { label: "Pending", variant: "warning" },
	approved: { label: "Approved", variant: "success" },
	spam: { label: "Spam", variant: "error" },
	trash: { label: "Trash", variant: "outline" },
};

const EMPTY_COPY: Record<StatusFilter, { title: string; description: string }> = {
	pending: { title: "Nothing to moderate", description: "No comments are waiting for review." },
	approved: { title: "No approved comments", description: "Comments appear here once they are approved." },
	spam: { title: "No spam", description: "Comments marked as spam are collected here." },
	trash: { title: "Trash is empty", description: "Trashed comments stay here until you delete them for good." },
	all: { title: "No comments yet", description: "Comments in every status are listed here." },
};

/** Relative time for scanning, with the exact timestamp in `title`. */
function formatRelative(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	const seconds = Math.round((date.getTime() - Date.now()) / 1000);
	const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
		["year", 31_536_000],
		["month", 2_592_000],
		["week", 604_800],
		["day", 86_400],
		["hour", 3_600],
		["minute", 60],
	];
	const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	for (const [unit, size] of steps) {
		if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
	}
	return "just now";
}

function formatAbsolute(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function messageOf(error: unknown): string {
	return error instanceof Error && error.message ? error.message : String(error);
}

/** Only the initial is shown — an email address is not an avatar source. */
function initialOf(comment: Comment): string {
	const source = comment.authorName.trim() || comment.authorEmail.trim();
	return source ? source.slice(0, 1).toLocaleUpperCase() : "?";
}

function displayName(comment: Comment): string {
	return comment.authorName.trim() || "Anonymous";
}

function useDebounced<T>(value: T, delay: number): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setDebounced(value), delay);
		return () => clearTimeout(timer);
	}, [value, delay]);
	return debounced;
}

/**
 * Apply a moderated row to every cached list without reloading pages.
 *
 * `setQueriesData` cannot see which key it is updating, and the decision depends on it: a comment
 * that is no longer `pending` has to leave the `pending` list, while the `all` list only needs its
 * status replaced. So walk the cache and read the filter out of each key.
 */
function applyModerationResult(
	queryClient: ReturnType<typeof useQueryClient>,
	commentId: string,
	updated: Comment | null,
): void {
	for (const query of queryClient.getQueryCache().findAll({ queryKey: [...ROOT_KEY, "comments"] })) {
		const filter = query.queryKey[2] as StatusFilter | undefined;
		queryClient.setQueryData<Comment[]>(query.queryKey, (list) => {
			if (!list) return list;
			if (updated === null) return list.filter((item) => item.id !== commentId);
			if (filter !== "all" && filter !== updated.status) return list.filter((item) => item.id !== commentId);
			return list.map((item) => (item.id === commentId ? updated : item));
		});
	}
}

function StatusTabs({
	counts,
	value,
	onChange,
}: {
	counts: StatusCounts | undefined;
	value: StatusFilter;
	onChange: (next: StatusFilter) => void;
}) {
	const tabs = FILTERS.map((filter) => {
		const count = counts
			? filter.value === "all"
				? counts.pending + counts.approved + counts.spam + counts.trash
				: counts[filter.value]
			: undefined;
		return { value: filter.value, label: count === undefined ? filter.label : `${filter.label} · ${count}` };
	});
	return (
		<Tabs
			tabs={tabs}
			value={value}
			onValueChange={(next) => onChange(next as StatusFilter)}
			variant="segmented"
			size="sm"
		/>
	);
}

function CommentRow({
	comment,
	busy,
	onModerate,
}: {
	comment: Comment;
	busy: boolean;
	onModerate: (comment: Comment, action: CommentStatus | "delete") => void;
}) {
	const badge = STATUS_BADGE[comment.status];
	const secondaryAction = (status: CommentStatus, label: string, icon: ReactNode) => (
		<Button size="sm" variant="ghost" icon={icon} disabled={busy} onClick={() => onModerate(comment, status)}>
			{label}
		</Button>
	);

	return (
		<li className="cg-comment">
			<div className="cg-comment__head">
				<span className="cg-avatar" aria-hidden="true">
					{initialOf(comment)}
				</span>
				<span className="cg-comment__who">
					<Text variant="body" bold as="span" truncate>
						{displayName(comment)}
					</Text>
					{comment.authorEmail ? (
						<Text variant="secondary" size="xs" as="span" truncate>
							{comment.authorEmail}
						</Text>
					) : null}
				</span>
				<Badge variant={badge.variant}>{badge.label}</Badge>
				{comment.parentId ? <Badge variant="outline">Reply</Badge> : null}
				<span className="cg-comment__time">
					<Text variant="secondary" size="xs" as="span">
						<time dateTime={comment.createdAt} title={formatAbsolute(comment.createdAt)}>
							{formatRelative(comment.createdAt)}
						</time>
					</Text>
				</span>
			</div>

			<p className="cg-comment__body">{comment.body}</p>

			<div className="cg-comment__actions" role="group" aria-label={`Moderate the comment by ${displayName(comment)}`}>
				{comment.status !== "approved" ? (
					<Button
						size="sm"
						variant="secondary"
						icon={<CheckCircleIcon size={16} />}
						disabled={busy}
						onClick={() => onModerate(comment, "approved")}
					>
						Approve
					</Button>
				) : null}
				{comment.status !== "pending"
					? secondaryAction(
							"pending",
							comment.status === "trash" ? "Restore to pending" : "Mark pending",
							<ClockCounterClockwiseIcon size={16} />,
						)
					: null}
				{comment.status !== "spam" && comment.status !== "trash"
					? secondaryAction("spam", "Spam", <ProhibitIcon size={16} />)
					: null}
				{comment.status !== "trash" ? (
					secondaryAction("trash", "Trash", <TrashIcon size={16} />)
				) : (
					<Button
						size="sm"
						variant="secondary-destructive"
						icon={<TrashSimpleIcon size={16} />}
						disabled={busy}
						onClick={() => onModerate(comment, "delete")}
					>
						Delete permanently
					</Button>
				)}
			</div>
		</li>
	);
}

function GroupCard({
	group,
	filter,
	open,
	onToggle,
	busyId,
	onModerate,
}: {
	group: CommentGroup;
	filter: StatusFilter;
	open: boolean;
	onToggle: (open: boolean) => void;
	busyId: string | null;
	onModerate: (comment: Comment, action: CommentStatus | "delete") => void;
}) {
	const pending = group.comments.filter((comment) => comment.status === "pending").length;
	const total = group.comments.length;
	const url = group.entry?.url ?? null;
	const subtitle = group.entry?.exists
		? [group.collection, group.entry.slug ?? group.contentId].filter(Boolean).join(" · ")
		: `${group.collection} · entry missing or not readable`;

	return (
		<LayerCard className="cg-group">
			<div className="cg-group__head">
				<Collapsible.Root open={open} onOpenChange={onToggle} className="cg-group__disclosure">
					<Collapsible.Trigger className="cg-group__trigger">
						<span className={`cg-chevron${open ? " is-open" : ""}`} aria-hidden="true">
							<CaretRightIcon size={14} weight="bold" />
						</span>
						<span className="cg-group__title">
							<Text variant="body" bold as="span" truncate>
								{group.entry?.title || `${group.collection} / ${group.contentId}`}
							</Text>
							<Text variant="secondary" size="xs" as="span" truncate>
								{subtitle}
							</Text>
						</span>
						<Badge variant="secondary">
							{total} {total === 1 ? "comment" : "comments"}
						</Badge>
						{filter !== "pending" && pending > 0 ? <Badge variant="warning">{pending} pending</Badge> : null}
					</Collapsible.Trigger>
					<Collapsible.Panel>
						<ul className="cg-comments">
							{group.comments.map((comment) => (
								<CommentRow key={comment.id} comment={comment} busy={busyId !== null} onModerate={onModerate} />
							))}
						</ul>
					</Collapsible.Panel>
				</Collapsible.Root>
				<div className="cg-group__aside">
					{url ? (
						<LinkButton href={url} external variant="ghost" size="sm" icon={<ArrowSquareOutIcon size={16} />}>
							Open
						</LinkButton>
					) : (
						<Text variant="secondary" size="xs" as="span">
							No public link
						</Text>
					)}
				</div>
			</div>
		</LayerCard>
	);
}

function PageSkeleton() {
	return (
		<div className="cg-stack" aria-hidden="true">
			{[0, 1, 2].map((index) => (
				<LayerCard key={index} className="cg-skeleton">
					<SkeletonLine minWidth={12} maxWidth={28} blockHeight="1rem" />
					<SkeletonLine minWidth={6} maxWidth={16} blockHeight="0.75rem" />
				</LayerCard>
			))}
		</div>
	);
}

function CommentGroupsPage() {
	const queryClient = useQueryClient();
	const toast = useKumoToastManager();

	const [filter, setFilter] = useState<StatusFilter>("pending");
	const [searchText, setSearchText] = useState("");
	const search = useDebounced(searchText.trim(), 350);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
	const [pendingDelete, setPendingDelete] = useState<Comment | null>(null);

	const counts = useQuery({ queryKey: countsKey, queryFn: ({ signal }) => fetchStatusCounts(signal), staleTime: 30_000 });

	const comments = useQuery({
		queryKey: commentsKey(filter, search),
		queryFn: ({ signal }) => fetchComments(filter, { search, signal }),
		staleTime: 60_000,
		// Keep the current groups on screen while another filter loads instead of flashing a skeleton.
		placeholderData: keepPreviousData,
	});

	const entriesNeeded = useMemo(() => distinctEntries(comments.data ?? []), [comments.data]);
	const entries = useQuery({
		// Keyed by the exact entry set, so returning to a filter whose entries did not change reuses
		// the cached titles instead of asking again.
		queryKey: [...ROOT_KEY, "entries", entriesNeeded.map((entry) => entryKey(entry.collection, entry.contentId))],
		queryFn: ({ signal }) => fetchEntries(entriesNeeded, signal),
		enabled: entriesNeeded.length > 0,
		staleTime: 5 * 60_000,
		placeholderData: keepPreviousData,
	});

	const groups = useMemo(
		() => groupComments(comments.data ?? [], entries.data ?? new Map()),
		[comments.data, entries.data],
	);

	const moderate = useMutation({
		mutationFn: ({ comment, status }: { comment: Comment; status: CommentStatus }) => setCommentStatus(comment.id, status),
		onSuccess: (updated, { status }) => {
			// The endpoint returns the authoritative row, so a one-row change patches the cached
			// lists instead of reloading every comment page.
			applyModerationResult(queryClient, updated.id, updated);
			void queryClient.invalidateQueries({ queryKey: countsKey });
			toast.add({ title: `Comment moved to ${STATUS_BADGE[status].label.toLowerCase()}` });
		},
		onError: (error) => {
			toast.add({ variant: "error", title: "Could not moderate the comment", description: messageOf(error) });
			// The local lists may now disagree with the server; let it correct them.
			void queryClient.invalidateQueries({ queryKey: commentsKey(filter, search) });
		},
	});

	const remove = useMutation({
		mutationFn: (comment: Comment) => deleteComment(comment.id),
		onSuccess: (_result, comment) => {
			applyModerationResult(queryClient, comment.id, null);
			// Deleting a parent also deletes its replies, so reload instead of inferring which rows left.
			void queryClient.invalidateQueries({ queryKey: [...ROOT_KEY, "comments"] });
			void queryClient.invalidateQueries({ queryKey: countsKey });
			toast.add({ title: "Comment deleted" });
		},
		onError: (error) => {
			toast.add({ variant: "error", title: "Could not delete the comment", description: messageOf(error) });
		},
	});

	const busyId = moderate.isPending
		? (moderate.variables?.comment.id ?? null)
		: remove.isPending
			? (remove.variables?.id ?? null)
			: null;

	const onModerate = (comment: Comment, action: CommentStatus | "delete") => {
		if (busyId !== null) return;
		if (action === "delete") {
			setPendingDelete(comment);
			return;
		}
		moderate.mutate({ comment, status: action });
	};

	const refresh = () => {
		void queryClient.invalidateQueries({ queryKey: ROOT_KEY });
	};

	const isRefreshing = counts.isFetching || comments.isFetching || entries.isFetching;
	const error = comments.error ?? entries.error;
	// `placeholderData` keeps the previous list visible, so `isFetching` alone does not mean "empty".
	const isLoading = comments.isPending || (entriesNeeded.length > 0 && entries.isPending);
	const allExpanded = groups.length > 0 && groups.every((group) => expanded.has(group.key));
	const emptyCopy = search
		? { title: "No matching comments", description: `Nothing in this filter matched “${search}”.` }
		: EMPTY_COPY[filter];

	return (
		<section className="cg-page">
			<header className="cg-header">
				<div>
					<Text variant="heading1" as="h1">
						Comments by post
					</Text>
					<Text variant="secondary">Review and moderate comments grouped by the entry they belong to.</Text>
				</div>
				<div className="cg-header__actions">
					<RefreshButton loading={isRefreshing} onClick={refresh} aria-label="Reload comments" title="Reload" />
				</div>
			</header>

			<div className="cg-toolbar">
				<StatusTabs counts={counts.data} value={filter} onChange={setFilter} />
				<div className="cg-toolbar__right">
					<InputGroup size="sm" className="cg-search">
						<InputGroup.Addon>
							<MagnifyingGlassIcon size={16} />
						</InputGroup.Addon>
						<InputGroup.Input
							type="search"
							value={searchText}
							onChange={(event) => setSearchText(event.target.value)}
							placeholder="Author, email, or text"
							aria-label="Search comments"
						/>
					</InputGroup>
					<Button
						size="sm"
						variant="ghost"
						disabled={groups.length === 0}
						onClick={() => setExpanded(allExpanded ? new Set() : new Set(groups.map((group) => group.key)))}
					>
						{allExpanded ? "Collapse all" : "Expand all"}
					</Button>
				</div>
			</div>

			{error ? (
				<Banner
					variant="error"
					title="Could not load comments"
					description={messageOf(error)}
					action={
						<Button size="sm" variant="secondary" onClick={refresh}>
							Try again
						</Button>
					}
				/>
			) : null}

			{isLoading ? (
				<PageSkeleton />
			) : groups.length === 0 ? (
				<LayerCard>
					<Empty
						icon={<ChatCircleDotsIcon size={40} />}
						title={emptyCopy.title}
						description={emptyCopy.description}
						size="sm"
					/>
				</LayerCard>
			) : (
				<>
					<Text variant="secondary" size="sm" as="p">
						{groups.length} {groups.length === 1 ? "entry" : "entries"} ·{" "}
						{groups.reduce((sum, group) => sum + group.comments.length, 0)} comments
					</Text>
					<div className="cg-stack" aria-busy={isRefreshing || busyId !== null}>
						{groups.map((group) => (
							<GroupCard
								key={group.key}
								group={group}
								filter={filter}
								open={expanded.has(group.key)}
								onToggle={(open) =>
									setExpanded((current) => {
										const next = new Set(current);
										if (open) next.add(group.key);
										else next.delete(group.key);
										return next;
									})
								}
								busyId={busyId}
								onModerate={onModerate}
							/>
						))}
					</div>
				</>
			)}

			<Dialog.Root
				role="alertdialog"
				open={pendingDelete !== null}
				onOpenChange={(open) => (!open ? setPendingDelete(null) : undefined)}
			>
				<Dialog className="cg-dialog" size="sm">
					<Dialog.Title className="cg-dialog__title">Delete this comment for good?</Dialog.Title>
					<Dialog.Description className="cg-dialog__description">
						{pendingDelete
							? `The comment by ${displayName(pendingDelete)} and every reply to it are removed permanently. Moving it to trash instead keeps it recoverable.`
							: "This cannot be undone."}
					</Dialog.Description>
					<div className="cg-dialog__actions">
						<Dialog.Close render={(props) => <Button {...props} variant="secondary">Cancel</Button>} />
						<Button
							variant="destructive"
							loading={remove.isPending}
							onClick={() => {
								if (pendingDelete) remove.mutate(pendingDelete);
								setPendingDelete(null);
							}}
						>
							Delete permanently
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</section>
	);
}

// EmDash resolves the component by the page path declared in `admin.pages`.
export const pages = { "/comments": CommentGroupsPage };
