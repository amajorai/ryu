import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";

/**
 * Localized copy for the Context panel's rows. Core sends each segment with an
 * English `label`/`detail` plus stable `labelKey`, `detailKey` and `counts`
 * (`apps/core/src/sidecar/adapters/context_breakdown/segment.rs`); this module
 * turns the keys into whole `tl()` sentences with ICU plurals. A key this build
 * does not know (a newer Core) falls back to Core's English text.
 */

/** Translator shape: `useLiteralMessages()` in React, English by default. */
export type ContextLiteral = (
	source: string,
	values?: MessageValuesInput
) => string;

/** English-only formatter for callers outside a translated tree (tests, SSR). */
export const englishContextLiteral: ContextLiteral = (source, values = {}) =>
	formatMessage(source, values, "en");

/** The numbers behind a segment's detail. Mirrors Core's `SegmentCounts`. */
export interface ContextSegmentCounts {
	images?: number;
	messages?: number;
	servers?: number;
	skills?: number;
	tools?: number;
}

/** The fields of a segment the copy depends on. */
export interface ContextSegmentCopy {
	counts?: ContextSegmentCounts;
	detail?: string;
	detailKey?: string;
	label: string;
	labelKey?: string;
}

/** `labelKey` → translated label. Each entry is a literal so extraction sees it. */
function segmentLabelFor(key: string, tl: ContextLiteral): string | undefined {
	switch (key) {
		case "agent_instructions":
			return tl("Agent instructions");
		case "attached_documents":
			return tl("Attached documents");
		case "auto_recall":
			return tl("Auto-recall");
		case "brief_replies":
			return tl("Brief replies");
		case "compacted_summary":
			return tl("Compacted summary");
		case "conversation_history":
			return tl("Conversation history");
		case "generative_ui_screen":
			return tl("Generative UI screen");
		case "goals":
			return tl("Goals");
		case "handoff_summary":
			return tl("Handoff summary");
		case "images":
			return tl("Images");
		case "long_term_memory":
			return tl("Long-term memory");
		case "memory":
			return tl("Memory");
		case "organization_managed_instructions":
			return tl("Organization-managed instructions");
		case "output_style":
			return tl("Output style");
		case "persona":
			return tl("Persona");
		case "project_instructions":
			return tl("Project instructions");
		case "referenced_chats":
			return tl("Referenced chats");
		case "ryu_docs":
			return tl("Ryu docs");
		case "ryu_everyday_setup_guide":
			return tl("Ryu everyday setup guide");
		case "skills":
			return tl("Skills");
		case "tool_definitions":
			return tl("Tool definitions");
		case "working_memory":
			return tl("Working memory");
		default:
			return;
	}
}

function isCount(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** `detailKey` + `counts` → translated detail, or `undefined` when unknown. */
function segmentDetailFor(
	key: string,
	counts: ContextSegmentCounts,
	tl: ContextLiteral
): string | undefined {
	switch (key) {
		case "images":
			return isCount(counts.images)
				? tl("{count, plural, one {# image} other {# images}}", {
						count: counts.images,
					})
				: undefined;
		case "messages":
			return isCount(counts.messages)
				? tl("{count, plural, one {# message} other {# messages}}", {
						count: counts.messages,
					})
				: undefined;
		case "replayed_turns":
			return tl("replayed turns");
		case "skills":
			return isCount(counts.skills)
				? tl("{count, plural, one {# enabled} other {# enabled}}", {
						count: counts.skills,
					})
				: undefined;
		case "tools":
			return isCount(counts.tools) && isCount(counts.servers)
				? tl(
						"{tools, plural, one {# tool} other {# tools}} across {servers, plural, one {# server} other {# servers}}",
						{ servers: counts.servers, tools: counts.tools }
					)
				: undefined;
		default:
			return;
	}
}

/** The row label to show: translated by key, else Core's English label. */
export function contextSegmentLabel(
	segment: ContextSegmentCopy,
	tl: ContextLiteral = englishContextLiteral
): string {
	const key = segment.labelKey;
	return (key ? segmentLabelFor(key, tl) : undefined) ?? segment.label;
}

/** The row detail to show: translated by key, else Core's English detail. */
export function contextSegmentDetail(
	segment: ContextSegmentCopy,
	tl: ContextLiteral = englishContextLiteral
): string | undefined {
	const key = segment.detailKey;
	if (!key) {
		return segment.detail;
	}
	return segmentDetailFor(key, segment.counts ?? {}, tl) ?? segment.detail;
}
