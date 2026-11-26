import { useState } from "react";
import { Button } from "@cloudflare/kumo";
import { slugify } from "@emdash-cms/admin/slugify";
import type {
	ContentEditorPanelContext,
	ContentEditorPanelExtension,
} from "@emdash-cms/admin";

/**
 * The slug the sidebar shows and the slug this panel writes are the same draft value.
 *
 * `slugify` comes from `@emdash-cms/admin/slugify` — the module the editor and the server both
 * import — so the generated slug cannot drift from a title-derived one. A local copy would.
 *
 * `patch()` writes into the form without saving, and behaves exactly like typing in the slug
 * input: the entry becomes unsaved (autosave carries it), the slug stops following the title,
 * and the first save keeps the previous draft in the revision history.
 */

const REFUSALS = {
	EDITOR_DRAFT_STALE:
		"The entry changed while this panel worked, so nothing was applied. Press again.",
	EDITOR_DRAFT_READ_ONLY: "The editor does not accept edits right now.",
	EDITOR_DRAFT_INVALID: "The editor refused the new slug.",
} as const;

type Note = { tone: "ok" | "warn"; text: string };

function titleOf(fields: Record<string, unknown>): string {
	return typeof fields.title === "string" ? fields.title : "";
}

function slugOf(fields: Record<string, unknown>): string {
	return typeof fields.slug === "string" ? fields.slug : "";
}

function SlugFromTitlePanel({ editorDraft }: ContentEditorPanelContext) {
	const [note, setNote] = useState<Note | null>(null);

	if (!editorDraft) {
		return (
			<p className="text-sm text-kumo-subtle">
				This panel needs EmDash 1.6.0 or later, which is what exposes the draft slug to a panel.
			</p>
		);
	}

	// Read on render for the display only. The press path reads again: `expectedRevision` has to
	// come from the values the patch is compared against, and any keystroke since this render
	// makes the one read here stale.
	const snapshot = editorDraft.get();
	const currentSlug = slugOf(snapshot.fields);

	const apply = () => {
		const draft = editorDraft.get();
		if (draft.readOnly) {
			setNote({ tone: "warn", text: REFUSALS.EDITOR_DRAFT_READ_ONLY });
			return;
		}
		const title = titleOf(draft.fields);
		if (!title.trim()) {
			setNote({ tone: "warn", text: "This entry has no title to build a slug from." });
			return;
		}
		const next = slugify(title);
		if (next === slugOf(draft.fields)) {
			setNote({ tone: "warn", text: `The slug already is “${next}”.` });
			return;
		}
		const result = editorDraft.patch([{ op: "set", field: "slug", value: next }], {
			expectedRevision: draft.revision,
		});
		setNote(
			result.ok
				? { tone: "ok", text: `Slug set to “${next}”. Save the entry to apply it.` }
				: { tone: "warn", text: REFUSALS[result.code] },
		);
	};

	return (
		<div className="flex flex-col gap-3">
			<p className="text-sm text-kumo-subtle">
				Slug: <code className="text-kumo-default">{currentSlug || "—"}</code>
			</p>
			<Button type="button" variant="secondary" size="sm" onClick={apply}>
				Use title as slug
			</Button>
			<p className="text-sm text-kumo-subtle">
				Sets the slug from the title in the editor, including unsaved changes. Afterwards the slug
				stops following the title, as if you had typed it.
			</p>
			{note ? (
				<p className={note.tone === "ok" ? "text-sm text-kumo-subtle" : "text-sm text-kumo-danger"}>
					{note.text}
				</p>
			) : null}
		</div>
	);
}

// Every collection can be asked: a slug exists for all of them, and a collection without a
// `title` field gets the hint from the press path instead of a panel that silently does nothing.
export const contentEditorPanels = [
	{
		id: "slug-from-title",
		title: "Slug from title",
		component: SlugFromTitlePanel,
		order: 30,
	},
] satisfies readonly ContentEditorPanelExtension[];
