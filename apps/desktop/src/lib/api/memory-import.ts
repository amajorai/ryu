// apps/desktop/src/lib/api/memory-import.ts
//
// Client for Core's `POST /api/memory/import`: add memories the user pasted
// from another AI assistant. Core parses the text, records each entry as a
// user-scope memory with import provenance, and skips entries it has already
// imported for this user.

import { z } from "zod";
import { type ApiTarget, request } from "./client.ts";

/** Assistants the import dialog offers. Core records anything else as `other`. */
export const PASTE_SOURCES = [
	"chatgpt",
	"claude",
	"gemini",
	"grok",
	"copilot",
	"perplexity",
	"other",
] as const;

export type PasteSource = (typeof PASTE_SOURCES)[number];

export const PASTE_SOURCE_LABELS = {
	chatgpt: "ChatGPT",
	claude: "Claude",
	gemini: "Gemini",
	grok: "Grok",
	copilot: "Copilot",
	perplexity: "Perplexity",
	other: "Another assistant",
} satisfies Record<PasteSource, string>;

const summarySchema = z.looseObject({
	already_present: z.number().optional(),
	found: z.number().optional(),
	imported: z.number().optional(),
	skipped_sensitive: z.number().optional(),
});

/** What one paste added. */
export interface PastedMemoryImport {
	alreadyPresent: number;
	found: number;
	imported: number;
	/** Entries held back because sensitive-topic memory is off. */
	skippedSensitive: number;
}

export async function importPastedMemories(
	target: ApiTarget,
	input: { source: PasteSource; text: string }
): Promise<PastedMemoryImport> {
	const json = await request(
		target,
		"/api/memory/import",
		{ method: "POST", body: { source: input.source, text: input.text } },
		summarySchema
	);
	return {
		alreadyPresent: json.already_present ?? 0,
		found: json.found ?? 0,
		imported: json.imported ?? 0,
		skippedSensitive: json.skipped_sensitive ?? 0,
	};
}
