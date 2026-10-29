import { z } from "zod";
// apps/desktop/src/lib/api/import.ts
//
// Client for importing agent *setup* from a scanned local folder (instructions,
// skills, MCP servers, plugins, agents, slash commands, and Claude project
// memories) — the setup-side
// companion to `agent-threads.ts`. Scan a folder Core can read, preview what it
// found, then import the selected items into Ryu's own stores.

import { type ApiTarget, authenticatedFetch } from "./client.ts";

/**
 * Every item kind Core's scanner emits (`import::kind::*` in
 * `apps/core/src/import/mod.rs`). The one list the {@link ImportItemKind} type
 * and the response codecs in this module and `agent-sync.ts` are derived from,
 * so a kind added here is accepted on every import response without a second
 * edit, and a kind missing here is rejected everywhere.
 */
export const IMPORT_ITEM_KINDS = [
	"instructions",
	"skill",
	"mcp_server",
	"plugin",
	"memory",
	"agent",
	"slash_command",
	"conversations",
] as const;

export type ImportItemKind = (typeof IMPORT_ITEM_KINDS)[number];

/** Zod codec for an {@link ImportItemKind} on the wire; fails closed on any other value. */
export const importItemKindSchema = z.enum(IMPORT_ITEM_KINDS);

export interface ScanItem {
	/** Cheap same-name/same-id hint; the import step is authoritative. */
	alreadyExists: boolean;
	/** Content revision supplied by current Core; absent on older nodes. */
	contentRevision?: string;
	detail?: string;
	/** Opaque, root-relative locator Core round-trips back to disk. */
	id: string;
	kind: ImportItemKind;
	title: string;
}

interface ScanItemWire {
	already_exists?: boolean;
	content_revision?: string;
	detail?: string;
	id: string;
	kind: ImportItemKind;
	title: string;
}

export interface ScanResult {
	items: ScanItem[];
	/** Canonicalized absolute path of the scanned folder. */
	root: string;
	/** Detected source framework (`openclaw`, `hermes`, `muse`, `mastra`,
	    `langchain`, `persona`); absent for a plain folder or an older node. */
	source?: string;
	warnings: string[];
}

interface ScanResultWire {
	items?: ScanItemWire[];
	root?: string;
	source?: string | null;
	warnings?: string[];
}

function toItem(i: ScanItemWire): ScanItem {
	return {
		contentRevision:
			typeof i.content_revision === "string" &&
			/^[0-9a-f]{64}$/.test(i.content_revision)
				? i.content_revision
				: undefined,
		kind: i.kind,
		id: i.id,
		title: i.title,
		detail: i.detail,
		alreadyExists: i.already_exists ?? false,
	};
}

/** Group the flat scan list by kind, preserving order. */
export function groupScanItems(items: ScanItem[]): {
	kind: ImportItemKind;
	label: string;
	items: ScanItem[];
}[] {
	const groups: { kind: ImportItemKind; label: string; items: ScanItem[] }[] =
		[];
	for (const item of items) {
		let group = groups.find((g) => g.kind === item.kind);
		if (!group) {
			group = {
				kind: item.kind,
				label: kindLabel(item.kind),
				items: [],
			};
			groups.push(group);
		}
		group.items.push(item);
	}
	return groups;
}

export function kindLabel(kind: ImportItemKind): string {
	switch (kind) {
		case "instructions":
			return "Instructions";
		case "skill":
			return "Skills";
		case "mcp_server":
			return "MCP servers";
		case "plugin":
			return "Plugins";
		case "memory":
			return "Memories";
		case "agent":
			return "Agents";
		case "slash_command":
			return "Slash commands";
		case "conversations":
			return "Chats and projects";
	}
}

/**
 * Scan a local folder for importable agent setup. Read-only; resolves to the
 * found items (possibly empty) rather than throwing when nothing matches.
 */
export async function scanImportFolder(
	target: ApiTarget,
	path: string
): Promise<ScanResult> {
	const resp = await authenticatedFetch(target, "/api/import/scan", {
		method: "POST",
		body: JSON.stringify({ path }),
	});
	if (!resp.ok) {
		throw new Error(`Failed to scan folder: ${resp.status}`);
	}
	// SAFETY: After the status check, native scan_import_handler serializes ScanResult root/items/warnings/source; every scanner ScanItem kind is one of the seven authored kind constants, and serde omits absent optional strings/false existence hints. This trusts that native route producer, not arbitrary JSON.
	const body = (await resp.json()) as ScanResultWire;
	return {
		root: body.root ?? path,
		items: (body.items ?? []).map(toItem),
		source: typeof body.source === "string" ? body.source : undefined,
		warnings: body.warnings ?? [],
	};
}

export type ImportStatus = "imported" | "skipped" | "failed";

export interface ImportOutcome {
	alreadyExists: boolean;
	/** Revision acknowledged from the exact bytes stored by Core. */
	contentRevision?: string;
	detail?: string;
	/** For `instructions` items: the containing folder to register as a project. */
	folderPath?: string;
	id: string;
	kind: ImportItemKind;
	status: ImportStatus;
	title: string;
}

export interface ImportSelection {
	id: string;
	kind: ImportItemKind;
}

export interface RunImportResult {
	results: ImportOutcome[];
	root: string;
}

/**
 * Import the selected scan items into Ryu's stores. Idempotent per item: things
 * already imported come back `skipped` with `alreadyExists: true`.
 */
export async function runImport(
	target: ApiTarget,
	path: string,
	items: ImportSelection[]
): Promise<RunImportResult> {
	const resp = await authenticatedFetch(target, "/api/import/run", {
		method: "POST",
		body: JSON.stringify({ path, items }),
	});
	if (!resp.ok) {
		throw new Error(`Failed to import: ${resp.status}`);
	}
	const body = z
		.object({
			root: z.string().optional(),
			results: z
				.array(
					z.object({
						already_exists: z.boolean().optional(),
						content_revision: z.string().optional(),
						detail: z.string().optional(),
						folder_path: z.string().optional(),
						id: z.string(),
						kind: importItemKindSchema,
						status: z.enum(["imported", "skipped", "failed"]),
						title: z.string(),
					})
				)
				.optional(),
		})
		.parse(await resp.json());
	return {
		root: body.root ?? path,
		results: (body.results ?? []).map((r) => ({
			contentRevision:
				typeof r.content_revision === "string" &&
				/^[0-9a-f]{64}$/.test(r.content_revision)
					? r.content_revision
					: undefined,
			kind: r.kind,
			id: r.id,
			title: r.title,
			status: r.status,
			alreadyExists: r.already_exists ?? false,
			detail: r.detail,
			folderPath: r.folder_path,
		})),
	};
}
