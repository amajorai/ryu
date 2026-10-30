import type { IconSvgElement } from "@hugeicons/react";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { UIMessage } from "ai";
import { z } from "zod";
import type { BtwEntry } from "@/src/lib/api/btw.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { ArtifactView } from "@/src/lib/live-artifacts.ts";
import type { PlanArtifact } from "@/src/lib/plan-artifacts.ts";
import type { ContextSectionItem } from "./context-sections.tsx";
import type { SubagentSummary } from "./cowork-subagents.ts";

const toolPayloadSchema = z.record(z.string(), z.json());
export function readToolPayload<TValue>(value: TValue) {
	const parsed = toolPayloadSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

// ── Message-stream shapes (loose, mirroring the AI SDK parts we read) ──────────

export interface StreamPart {
	callProviderMetadata?: Extract<
		UIMessage["parts"][number],
		{ type: "dynamic-tool" }
	>["callProviderMetadata"];
	/** File-part fields used by user attachments. */
	contentType?: string;
	fileName?: string;
	filename?: string;
	input?: unknown;
	mediaType?: string;
	mimeType?: string;
	name?: string;
	output?: unknown;
	/** Present on tool parts. Nested (subagent) tools carry `<parentTaskId>:<id>`. */
	state?: string;
	toolCallId?: string;
	/** Present on `dynamic-tool` parts, where the name isn't in `type`. */
	toolName?: string;
	type?: string;
	url?: string;
}

export interface StreamMessage {
	experimental_attachments?: unknown[];
	parts?: StreamPart[];
	role?: string;
}

export interface CoworkPlanTodo {
	content: string;
	status: "pending" | "in_progress" | "completed";
}

export interface CoworkContextPanelProps {
	/** Live chat status from useChat, so the in-progress step can pulse. */
	chatStatus?: string;
	/**
	 * Extra accordion items rendered above the derived sections (Progress /
	 * Artifacts / …). The pinned-summary card injects its "Environment" section
	 * (pickers + git + commit & push) here so the whole panel is one accordion.
	 */
	leadingItems?: ContextSectionItem[];
	/** Cap each list-like section when this panel is used as a compact summary. */
	maxItemsPerSection?: number;
	/** The conversation's message stream (AI SDK UIMessages). */
	messages: StreamMessage[];
	/**
	 * Open a detected rendered/canvas artifact (html/svg/mermaid/large code block)
	 * in the right panel's ArtifactRenderer.
	 */
	onOpenArtifact?: (artifact: ArtifactView) => void;
	/** Reopen a persisted side chat (the host shows it in the btw overlay). */
	onOpenSideChat?: (entry: BtwEntry) => void;
	/** Open the complete Sources list in its own workspace tab. */
	onOpenSources?: () => void;
	/**
	 * Open a spawned subagent's transcript in the right panel. The host reads the
	 * subagent id and re-derives the live transcript from the message stream.
	 */
	onOpenSubagent?: (subagent: SubagentSummary) => void;
	/** Open the complete Subagents list in its own workspace tab. */
	onOpenSubagents?: () => void;
	/** Every plan snapshot saved (or being saved) to the Artifacts Space. */
	planArtifacts?: PlanArtifact[];
	/** The active conversation id (== worktree run id). Null on a fresh chat. */
	runId: string | null;
	/** Whether the owning Side Chats plugin is enabled on this node. */
	sideChatsEnabled?: boolean;
	/** Bumped by the host after a new `/btw` so the side-chats list refetches. */
	sideChatsRefreshKey?: number;
	/** Node target for the worktree-diff / git-status fetches. */
	target: ApiTarget;
	/** Connected rail styling used by the floating pinned summary. */
	variant?: "cards" | "summary";
}

// ── Derivations from the message stream ────────────────────────────────────────

export function isToolPart(part: StreamPart): boolean {
	return (
		part.type === "dynamic-tool" ||
		(isNativeText(part.type) && part.type.startsWith("tool-"))
	);
}

/** One thing a source was actually used ON — a file, a link, a command. */
export interface SourceItem {
	/** Secondary line: the full path, the URL, the search root. */
	detail?: string;
	/** Filename/path used to resolve the same colored icon as the Files tree. */
	filePath?: string;
	icon: IconSvgElement;
	/** Dedupe key within its group. */
	id: string;
	label: string;
	/** Set only for real links, which open in the OS browser. */
	url?: string;
}

export interface DerivedSource {
	icon: IconSvgElement;
	id: string;
	/** What the run touched through this source, first-seen order. */
	items: SourceItem[];
	label: string;
}
