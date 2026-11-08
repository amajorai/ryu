import type { LiteralMessage } from "@ryu/i18n/react";
import type { HistorySource } from "@/src/lib/api/usage-history.ts";

// Display names for Usage > History sources, keyed by Core's stable source
// id. Core labels its metadata-export sources from the id (hyphens become
// spaces), and its own sources in English, so the desktop names them here.
// Local sources named after a product (Codex, Claude Code, …) keep Core's
// label. A source id Core adds later shows Core's label until it gets a row.

type SourceLabel = (tl: LiteralMessage) => string;

const SOURCE_LABELS: Readonly<Record<string, SourceLabel>> = {
	"openai-org-usage": (tl) => tl("OpenAI organization usage"),
	"openai-org-costs": (tl) => tl("OpenAI organization costs"),
	"anthropic-org-usage": (tl) => tl("Anthropic organization usage"),
	"anthropic-org-costs": (tl) => tl("Anthropic organization costs"),
	"claude-code-analytics": (tl) => tl("Claude Code analytics"),
	"cursor-account": (tl) => tl("Cursor account"),
	"usage-metadata": (tl) => tl("Usage metadata"),
	"ryu-sessions": (tl) => tl("Saved Ryu sessions"),
	"cursor-local": (tl) => tl("Cursor local history"),
	antigravity: (tl) => tl("Antigravity synced metadata"),
	zed: (tl) => tl("Zed hosted agent"),
};

/** Whether the desktop names this source id itself. */
export function hasUsageHistorySourceLabel(id: string): boolean {
	return Object.hasOwn(SOURCE_LABELS, id);
}

/** The display name of a history source in the UI language. */
export function usageHistorySourceLabel(
	source: Pick<HistorySource, "id" | "label">,
	tl: LiteralMessage
): string {
	const label = Object.hasOwn(SOURCE_LABELS, source.id)
		? SOURCE_LABELS[source.id]
		: undefined;
	return label ? label(tl) : source.label;
}

/** The display name of the source with this id in a report, else the id. */
export function historySourceName(
	report: { sources: readonly Pick<HistorySource, "id" | "label">[] },
	id: string,
	tl: LiteralMessage
): string {
	const source = report.sources.find((item) => item.id === id);
	return source ? usageHistorySourceLabel(source, tl) : id;
}
