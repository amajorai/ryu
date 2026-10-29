// apps/desktop/src/lib/catalog/downloadBadge.ts
//
// What a download row's type badge says. Pure and framework-free (rendered by
// DownloadTypeBadge), so the vocabulary is unit-testable and shared by the tray
// and the full page.
//
// Why a badge and not more label text: the download center mixes engines,
// weights, adapters, tool binaries and unpack steps, and the only thing that used
// to distinguish them was a parenthetical some call sites bothered to append —
// "nomic-embed-text-v1.5 (embedding model)" got one, "whisper.cpp" and
// "OuteTTS" got nothing, and Kokoro sent the same string for two different files.
// Core now tags every task with a structured `role`; this maps that to one short
// word so the *type* reads at a glance and the label is free to be just the name.
//
// `role` is authoritative. The `kind` fallback only covers tasks written by an
// older Core (which deserialize as `other`) and the label heuristic only refines
// a generic model into a draft/vision companion, which the catalog install path
// cannot know before it reads the filename.

import type { DownloadKind, DownloadRole } from "@/src/lib/api/downloads.ts";
import { ggufFileRole } from "./friendly.ts";

/** Visual tone for a badge — the same vocabulary the catalog tokens use. */
export type BadgeTone =
	| "neutral"
	| "blue"
	| "violet"
	| "amber"
	| "rose"
	| "emerald";

/** A rendered type badge. */
export interface DownloadBadge {
	label: string;
	tone: BadgeTone;
	/** Hover explanation — what this artifact actually does. */
	tooltip: string;
}

const ROLE_BADGE = {
	engine: {
		label: "Engine",
		tooltip: "The program that runs models locally on this machine.",
		tone: "violet",
	},
	chat_model: {
		label: "Chat model",
		tooltip: "Weights the assistant thinks and replies with.",
		tone: "blue",
	},
	embedding_model: {
		label: "Embedding",
		tooltip:
			"Turns text into vectors so your files and notes can be searched by meaning.",
		tone: "emerald",
	},
	reranker_model: {
		label: "Reranker",
		tooltip: "Re-orders search results so the most relevant ones come first.",
		tone: "emerald",
	},
	classifier_model: {
		label: "Classifier",
		tooltip:
			"A small, fast model used for safety checks and routing decisions.",
		tone: "amber",
	},
	vision_adapter: {
		label: "Vision add-on",
		tooltip:
			"Lets the paired chat model understand images. Not a standalone model.",
		tone: "blue",
	},
	draft_model: {
		label: "Speed add-on",
		tooltip:
			"A small companion that helps a larger model generate faster. Not a standalone model.",
		tone: "violet",
	},
	speech_model: {
		label: "Speech model",
		tooltip: "Turns spoken audio into text (speech recognition).",
		tone: "amber",
	},
	voice_model: {
		label: "Voice model",
		tooltip: "Turns text into spoken audio.",
		tone: "amber",
	},
	image_model: {
		label: "Image model",
		tooltip: "Generates images from a prompt.",
		tone: "rose",
	},
	video_model: {
		label: "Video model",
		tooltip: "Generates video from a prompt.",
		tone: "rose",
	},
	agent: {
		label: "Agent",
		tooltip: "A coding agent Ryu can run.",
		tone: "violet",
	},
	tool: {
		label: "Tool",
		tooltip: "A helper program agents can call.",
		tone: "neutral",
	},
	skill: {
		label: "Skill",
		tooltip: "A reusable instruction bundle agents can load.",
		tone: "neutral",
	},
	plugin: {
		label: "App",
		tooltip: "An app or plugin and the files it needs to run.",
		tone: "neutral",
	},
	plugin_model: {
		label: "Local model",
		tooltip: "A model checkpoint installed for a local plugin.",
		tone: "blue",
	},
	mcp_server: {
		label: "MCP",
		tooltip: "A tool server agents can connect to.",
		tone: "blue",
	},
	extract: {
		label: "Unpacking",
		tooltip:
			"Unpacking an already-downloaded archive. No network transfer, so it has no size or speed.",
		tone: "neutral",
	},
	other: null,
} satisfies Record<DownloadRole, DownloadBadge | null>;

/** Last-resort mapping for tasks from an older Core, which have no role. */
const KIND_BADGE = {
	engine: ROLE_BADGE.engine,
	agent: ROLE_BADGE.agent,
	tool: ROLE_BADGE.tool,
	skill: ROLE_BADGE.skill,
	mcp: ROLE_BADGE.mcp_server,
	embedding: ROLE_BADGE.embedding_model,
	voice: ROLE_BADGE.voice_model,
	media: ROLE_BADGE.image_model,
	model: ROLE_BADGE.chat_model,
	other: null,
} satisfies Record<DownloadKind, DownloadBadge | null>;

/**
 * The type badge for a download, or `null` when nothing useful can be said.
 *
 * A generic model role is refined by the filename when it names a companion
 * artifact (`mmproj` → vision add-on, `MTP`/`draft` → speed add-on): the catalog
 * install path fetches those through the same chat-model spec, so the filename is
 * the only place that distinction exists.
 */
export function downloadBadge(
	role: DownloadRole | undefined,
	kind: DownloadKind,
	label: string
): DownloadBadge | null {
	const refined = refineFromLabel(role, label);
	if (refined) {
		return refined;
	}
	const byRole = role ? ROLE_BADGE[role] : null;
	if (byRole) {
		return byRole;
	}
	return KIND_BADGE[kind] ?? null;
}

/** Companion-artifact refinement for a model download, from its filename. */
function refineFromLabel(
	role: DownloadRole | undefined,
	label: string
): DownloadBadge | null {
	if (role !== "chat_model" && role !== "other") {
		return null;
	}
	const file = ggufFileRole(label);
	if (!file) {
		return null;
	}
	if (file.label === "Vision adapter") {
		return ROLE_BADGE.vision_adapter;
	}
	return ROLE_BADGE.draft_model;
}

// The role parentheticals Core appends to a label. Now that the badge carries the
// type, repeating it in the name reads as a stutter ("Nomic Embed Text V1.5 ·
// embedding model" next to an "Embedding" badge), so it is stripped for display
// only — the raw label is still what the row's hover shows.
const ROLE_SUFFIX_RE =
	/\s*\((chat|embedding|reranker|classifier|vision adapter|speech|voice)\s*(model|adapter)?\)\s*$/i;

/** The label with a redundant role parenthetical removed. */
export function stripRoleSuffix(label: string): string {
	const stripped = label.replace(ROLE_SUFFIX_RE, "").trim();
	return stripped.length > 0 ? stripped : label;
}
