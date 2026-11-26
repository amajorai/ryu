// apps/desktop/src/lib/api/import-archive.ts
//
// Client for importing a bot export archive: the zip a migrator prompt builds
// inside Grok Bot (`src/lib/grok-bot-migrator.ts`). Core checks the zip,
// unpacks it into a staging folder on the node and answers with the scan of
// that folder plus a summary of what it holds. Nothing is imported until the
// scan's items go to `runImport` with the staged `root`.

import { z } from "zod";
import { type ApiTarget, authenticatedFetch } from "./client.ts";
import { parseApiErrorBody } from "./client-errors.ts";
import {
	type ScanResult,
	type ScanResultWire,
	scanResultFromWire,
} from "./import.ts";

const count = z.number().int().nonnegative().catch(0);

const archiveSchema = z.object({
	bots: z.array(
		z.object({
			conversations: count,
			description: z.string().catch(""),
			files: count,
			has_instructions: z.boolean().catch(false),
			key: z.string(),
			memories: count,
			name: z.string(),
			not_exported: z.array(z.string()).catch([]),
			routines: z.array(z.unknown()).catch([]),
			skills: count,
		})
	),
	exported_at: z.string().catch(""),
	ignored_entries: count,
	left_out_entries: count,
	source_app: z.string().catch(""),
});

/** One bot of an archive, with the counts of what Core unpacked for it. */
export interface ArchiveBot {
	conversations: number;
	description: string;
	files: number;
	hasInstructions: boolean;
	key: string;
	memories: number;
	name: string;
	/** Parts the migrator said it could not read, in its own words. */
	notExported: string[];
	/** Routines are listed for review. Ryu does not create them on import. */
	routines: number;
	skills: number;
}

export interface ArchiveSummary {
	bots: ArchiveBot[];
	exportedAt: string;
	/** Entries of the zip outside the export layout, which Core ignored. */
	ignoredEntries: number;
	/** Entries Core left out: sign-in files, names it cannot write, extras. */
	leftOutEntries: number;
	sourceApp: string;
}

export interface StagedArchive {
	archive: ArchiveSummary;
	/** The scan of the staging folder; `scan.root` is what `runImport` takes. */
	scan: ScanResult;
}

/**
 * Core refused the zip or could not check it. `reason` is Core's own English
 * sentence when it sent one; the caller supplies the localized fallback.
 */
export class ArchiveRefusedError extends Error {
	readonly reason: string | undefined;
	readonly status: number;

	constructor(status: number, reason: string | undefined) {
		super(reason ?? String(status));
		this.name = "ArchiveRefusedError";
		this.reason = reason;
		this.status = status;
	}
}

/**
 * Upload a zip for checking. Resolves to the preview of what it holds, or
 * throws {@link ArchiveRefusedError} when Core refuses it.
 */
export async function stageImportArchive(
	target: ApiTarget,
	file: Blob
): Promise<StagedArchive> {
	const resp = await authenticatedFetch(target, "/api/import/archive/stage", {
		method: "POST",
		body: file,
		headers: { "Content-Type": "application/zip" },
	});
	if (!resp.ok) {
		throw new ArchiveRefusedError(
			resp.status,
			parseApiErrorBody(await resp.text()).message
		);
	}
	// SAFETY: After the status check, native stage_import_archive_handler serializes the same root/items/warnings/source fields as scan_import_handler, plus `archive`, which is parsed by archiveSchema below instead of being trusted.
	const body = (await resp.json()) as ScanResultWire & { archive?: unknown };
	const archive = archiveSchema.parse(body.archive);
	return {
		archive: {
			bots: archive.bots.map((bot) => ({
				conversations: bot.conversations,
				description: bot.description,
				files: bot.files,
				hasInstructions: bot.has_instructions,
				key: bot.key,
				memories: bot.memories,
				name: bot.name,
				notExported: bot.not_exported,
				routines: bot.routines.length,
				skills: bot.skills,
			})),
			exportedAt: archive.exported_at,
			ignoredEntries: archive.ignored_entries,
			leftOutEntries: archive.left_out_entries,
			sourceApp: archive.source_app,
		},
		scan: scanResultFromWire(body, ""),
	};
}

/**
 * Remove a staging folder that {@link stageImportArchive} returned. Resolves
 * to whether Core removed it; a folder that is already gone is `false`.
 */
export async function discardImportArchive(
	target: ApiTarget,
	root: string
): Promise<boolean> {
	const resp = await authenticatedFetch(target, "/api/import/archive/discard", {
		method: "POST",
		body: JSON.stringify({ path: root }),
	});
	if (!resp.ok) {
		return false;
	}
	return z.object({ discarded: z.boolean() }).parse(await resp.json())
		.discarded;
}

/** What an archive holds in total, for the preview. */
export function archiveTotals(archive: ArchiveSummary): {
	bots: number;
	conversations: number;
	files: number;
	memories: number;
	skills: number;
} {
	const totals = {
		bots: archive.bots.length,
		conversations: 0,
		files: 0,
		memories: 0,
		skills: 0,
	};
	for (const bot of archive.bots) {
		totals.conversations += bot.conversations;
		totals.files += bot.files;
		totals.memories += bot.memories;
		totals.skills += bot.skills;
	}
	return totals;
}
