/**
 * Dispatch for the plugin's two Block Kit routes.
 *
 * The host posts `{ type: "page_load" | "block_action" | "form_submit", page }`
 * to `/_emdash/api/plugins/visitors/admin` and renders whatever comes back, so
 * this is the only place that decides which surface was asked for.
 *
 * `ctx.ui.surface` is host-attested (`admin-page` / `dashboard-widget`), which
 * is more trustworthy than the `page` string in the body. It is `undefined`
 * when the body carries no `page`, so the body is the fallback.
 *
 * Every branch is wrapped: a thrown handler becomes a 500 and an empty admin
 * page, while a `banner` block degrades to a readable error.
 */
import type { BlockInteraction, BlockResponse } from "@emdash-cms/blocks";
import type { RouteContext } from "emdash";

import { normalisePeriod, entryPanel, summary } from "../queries";
import { retentionDays } from "../store";
import { entryPanelBlocks, errorBlocks, overviewBlocks, widgetBlocks } from "./blocks";
import type { SortRequest } from "./blocks";

const WIDGET_PAGE_PREFIX = "widget:";

function asInteraction(input: unknown): BlockInteraction | null {
	if (typeof input !== "object" || input === null) return null;
	const candidate = input as { type?: unknown };
	if (candidate.type !== "page_load" && candidate.type !== "block_action" && candidate.type !== "form_submit") {
		return null;
	}
	return input as BlockInteraction;
}

function readSort(interaction: BlockInteraction | null): SortRequest {
	if (!interaction || interaction.type !== "block_action" || interaction.action_id !== "sort") return null;
	const value = interaction.value;
	if (typeof value !== "object" || value === null) return null;
	const sort = (value as { sort?: unknown }).sort;
	if (typeof sort !== "object" || sort === null) return null;
	const { key, dir } = sort as { key?: unknown; dir?: unknown };
	if (typeof key !== "string" || (dir !== "asc" && dir !== "desc")) return null;
	return { table: interaction.block_id, key, dir };
}

function readPeriod(interaction: BlockInteraction | null): unknown {
	if (!interaction || interaction.type !== "block_action" || interaction.action_id !== "period") return undefined;
	return interaction.value;
}

/** `/_emdash/api/plugins/visitors/admin` */
export async function adminInteraction(ctx: RouteContext): Promise<BlockResponse> {
	const interaction = asInteraction(ctx.input);
	const surface = ctx.ui?.surface;
	const page = interaction?.type === "page_load" ? interaction.page : undefined;
	const isWidget = surface === "dashboard-widget" || (surface === undefined && page?.startsWith(WIDGET_PAGE_PREFIX));

	try {
		if (isWidget) {
			// The card shows a fixed trio, so it always asks for the default period.
			const data = await summary(ctx, normalisePeriod(undefined));
			return { blocks: widgetBlocks(data) };
		}

		const period = normalisePeriod(readPeriod(interaction));
		const [data, retention] = await Promise.all([summary(ctx, period), retentionDays(ctx)]);
		return { blocks: overviewBlocks(data, readSort(interaction), retention) };
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		ctx.log.error("visitors: failed to render admin blocks", { message });
		return { blocks: errorBlocks(message) };
	}
}

/** `editor/views` — the saved-entry panel. */
export async function entryPanelInteraction(ctx: RouteContext): Promise<BlockResponse> {
	const entry = ctx.ui?.entry;
	if (!entry) {
		return {
			blocks: [
				{
					type: "banner",
					variant: "alert",
					title: "No entry selected",
					description: "Open this panel from the editor of a saved post or page.",
				},
			],
		};
	}

	try {
		const panel = await entryPanel(ctx, entry.collection, entry.id);
		return { blocks: entryPanelBlocks(panel) };
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		ctx.log.error("visitors: failed to render the entry panel", { message });
		return { blocks: errorBlocks(message) };
	}
}
