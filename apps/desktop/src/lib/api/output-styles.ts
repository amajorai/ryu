import { z } from "zod";
// apps/desktop/src/lib/api/output-styles.ts
//
// Typed client for Core's output-styles API (`/api/output-styles/*`, served by the
// `ryu-output-styles` crate). An output style is a reusable personality profile that
// changes *how* an agent answers — role, tone, default response shape — by editing
// the system prompt for the turn; it never changes what the agent knows, which tools
// it has, or which model runs. The full contract is `docs/output-styles.md`.
//
// Field names are snake_case to match Core's serde shapes exactly, as in the sibling
// clients (meetings, skills). Two naming traps worth knowing before reading below:
//
//   - `source` on a style is its PROVENANCE (`"user"` / `"plugin"` / …), never the
//     file text. Core could not reuse `source` for raw markdown the way
//     `/api/skills/{id}/source` does, so the raw file is `raw` on every response
//     here — including the one served at `GET /api/output-styles/{id}/source`.
//   - `keep_coding_instructions` does NOT gate a Claude-Code-style engineering block
//     (Ryu has none). Per design §2 it binds to the agent's OWN base instructions:
//     `true` appends the style body after them, `false` (the default) replaces them.

import { type ApiTarget, request } from "./client.ts";

/**
 * Where a style came from, which also fixes its precedence in the merge and whether
 * it can be edited in place. Mirrors the Rust `OutputStyleSource`
 * (`#[serde(rename_all = "lowercase")]`). Only `"user"` is writable — saving an edit
 * to anything else FORKS it into the user root rather than mutating a signed package
 * or an administrator's managed file.
 */
export type OutputStyleSource =
	| "builtin"
	| "plugin"
	| "user"
	| "project"
	| "managed";

/** One row of `GET /api/output-styles` — enough to render a picker row or a store card. */
export interface OutputStyleSummary {
	/** Legacy node-level selection metadata (or a plugin force), not agent assignment. */
	active: boolean;
	description: string | null;
	/** False when saving an edit would fork this style into the user root. */
	editable: boolean;
	/** Whether a plugin's `force-for-plugin` is what makes it active — the picker uses
	 *  this to explain why the selection is not the user's own, and to refuse a change
	 *  that Core would immediately override. */
	forced: boolean;
	id: string;
	keep_coding_instructions: boolean;
	name: string;
	source: OutputStyleSource;
}

/** `GET /api/output-styles`. `selected`/`forced` are legacy node-level metadata kept
 * for older clients; agent assignment is read from the agent's persona record. */
export interface OutputStyleList {
	forced: string | null;
	selected: string | null;
	styles: OutputStyleSummary[];
}

/** A parsed style record (`GET /api/output-styles/{id}` → `style`). */
export interface OutputStyleRecord {
	/** Everything after the closing `---`: the prose appended to the system prompt. */
	body: string;
	description: string | null;
	/** Plugin styles only: applied automatically while the plugin is enabled. */
	force_for_plugin: boolean;
	id: string;
	keep_coding_instructions: boolean;
	name: string;
	/** The `.md` this was read from, or null for a plugin contribution (whose body
	 *  arrives inline in the manifest and has no path on this machine). */
	path: string | null;
	source: OutputStyleSource;
}

/** `GET /api/output-styles/{id}/source` — the whole editable file plus its decomposed
 *  fields, so an authoring surface opens in one round trip. */
export interface OutputStyleFile {
	body: string;
	description: string | null;
	/** False ⇒ saving forks this style into the user root (design §6). */
	editable: boolean;
	id: string;
	keep_coding_instructions: boolean;
	name: string;
	/** The raw markdown — frontmatter included. */
	raw: string;
	source: OutputStyleSource;
}

/** The subset of a style an editor exposes as form fields. Every other frontmatter key
 *  already in the file (`force-for-plugin`, anything a newer schema added) is preserved
 *  verbatim by Core on save, so editing the body never silently drops a field. */
export interface OutputStyleDraft {
	body: string;
	description?: string | null;
	keep_coding_instructions: boolean;
	name: string;
}

/** Result of a create/update write. `forked` is true when the edit targeted a
 *  plugin/project/managed style and therefore created the user's own copy instead of
 *  changing the shipped one — worth telling the user, since the original is untouched. */
export interface OutputStyleWriteResult {
	forked: boolean;
	id: string;
	path: string;
	raw: string;
}

/** The post-write view of which style is in force, as returned by
 *  `POST /api/output-styles/select`. */
export interface OutputStyleSelection {
	forced: string | null;
	selected: string | null;
}

/** `GET /api/output-styles` — every available style (plugin + user + project +
 *  managed, merged), with the active one flagged. */
export async function listOutputStyles(
	target: ApiTarget
): Promise<OutputStyleList> {
	const json = await request(
		target,
		"/api/output-styles",
		undefined,
		listOutputStylesResponseSchema
	);
	return {
		styles: json.styles ?? [],
		selected: json.selected ?? null,
		forced: json.forced ?? null,
	};
}

/** `GET /api/output-styles/{id}` — one parsed style record. */
export async function getOutputStyle(
	target: ApiTarget,
	id: string
): Promise<OutputStyleRecord> {
	const json = await request(
		target,
		`/api/output-styles/${encodeURIComponent(id)}`,
		undefined,
		getOutputStyleResponseSchema
	);
	return json.style;
}

/** `GET /api/output-styles/{id}/source` — the raw markdown plus its parsed fields. */
export function getOutputStyleSource(
	target: ApiTarget,
	id: string
): Promise<OutputStyleFile> {
	return request(
		target,
		`/api/output-styles/${encodeURIComponent(id)}/source`,
		undefined,
		outputStyleFileResponseSchema
	);
}

/** `POST /api/output-styles` — create a new style in the user root. 409 when a style
 *  of that name already exists there. */
export async function createOutputStyle(
	target: ApiTarget,
	draft: OutputStyleDraft
): Promise<OutputStyleWriteResult> {
	const json = await request(
		target,
		"/api/output-styles",
		{ method: "POST", body: draft },
		omitResponseSchema
	);
	// A create has nothing to fork FROM; normalized here so callers can treat both
	// write paths as one shape.
	return { ...json, forked: false };
}

/** `PUT /api/output-styles/{id}` — save an edited style. Writes to the user root
 *  either way: editing a plugin/project/managed style forks it, and the returned
 *  `forked` says so. */
export async function updateOutputStyle(
	target: ApiTarget,
	id: string,
	draft: OutputStyleDraft
): Promise<OutputStyleWriteResult> {
	const json = await request(
		target,
		`/api/output-styles/${encodeURIComponent(id)}`,
		{ method: "PUT", body: draft },
		partialResponseSchema
	);
	return {
		id: json.id ?? id,
		path: json.path ?? "",
		raw: json.raw ?? "",
		forked: json.forked ?? false,
	};
}

/** `DELETE /api/output-styles/{id}` — remove a user-authored style. Only the user root
 *  is touched, so `false` genuinely means "there was no file of mine to remove" (and
 *  deleting a fork simply un-shadows the plugin original), never "failed". */
export async function deleteOutputStyle(
	target: ApiTarget,
	id: string
): Promise<boolean> {
	const json = await request(
		target,
		`/api/output-styles/${encodeURIComponent(id)}`,
		{ method: "DELETE" },
		deleteOutputStyleResponseSchema
	);
	return json.deleted ?? false;
}

/**
 * `POST /api/output-styles/select` — set the legacy node-default style, or clear it
 * back to "no style" with `null`. New callers should assign a profile through the
 * agent API.
 *
 * This helper remains for older clients while the node selection file is migrated.
 * Core rejects an unknown id with a 404 rather than persisting it.
 */
export async function selectOutputStyle(
	target: ApiTarget,
	styleId: string | null
): Promise<OutputStyleSelection> {
	const json = await request(
		target,
		"/api/output-styles/select",
		{
			method: "POST",
			body: { style_id: styleId },
		},
		selectOutputStyleResponseSchema
	);
	return { selected: json.selected ?? null, forced: json.forced ?? null };
}

const outputStyleSummaryResponseSchema = z
	.object({
		active: z.boolean(),
		description: z.union([z.null(), z.string()]),
		editable: z.boolean(),
		forced: z.boolean(),
		id: z.string(),
		keep_coding_instructions: z.boolean(),
		name: z.string(),
		source: z.union([
			z.literal("user"),
			z.literal("builtin"),
			z.literal("plugin"),
			z.literal("project"),
			z.literal("managed"),
		]),
	})
	.passthrough();

const listOutputStylesResponseSchema = z
	.object({
		forced: z.union([z.null(), z.string()]).optional(),
		selected: z.union([z.null(), z.string()]).optional(),
		styles: z.array(outputStyleSummaryResponseSchema).optional(),
	})
	.passthrough();

const outputStyleRecordResponseSchema = z
	.object({
		body: z.string(),
		description: z.union([z.null(), z.string()]),
		force_for_plugin: z.boolean(),
		id: z.string(),
		keep_coding_instructions: z.boolean(),
		name: z.string(),
		path: z.union([z.null(), z.string()]),
		source: z.union([
			z.literal("user"),
			z.literal("builtin"),
			z.literal("plugin"),
			z.literal("project"),
			z.literal("managed"),
		]),
	})
	.passthrough();

const getOutputStyleResponseSchema = z
	.object({ style: outputStyleRecordResponseSchema })
	.passthrough();

const outputStyleFileResponseSchema = z
	.object({
		body: z.string(),
		description: z.union([z.null(), z.string()]),
		editable: z.boolean(),
		id: z.string(),
		keep_coding_instructions: z.boolean(),
		name: z.string(),
		raw: z.string(),
		source: z.union([
			z.literal("user"),
			z.literal("builtin"),
			z.literal("plugin"),
			z.literal("project"),
			z.literal("managed"),
		]),
	})
	.passthrough();

const omitResponseSchema = z
	.object({ path: z.string(), id: z.string(), raw: z.string() })
	.passthrough();

const partialResponseSchema = z
	.object({
		forked: z.boolean().optional(),
		id: z.string().optional(),
		path: z.string().optional(),
		raw: z.string().optional(),
	})
	.passthrough();

const deleteOutputStyleResponseSchema = z
	.object({ deleted: z.boolean().optional() })
	.passthrough();

const selectOutputStyleResponseSchema = z
	.object({
		forced: z.union([z.null(), z.string()]).optional(),
		selected: z.union([z.null(), z.string()]).optional(),
	})
	.passthrough();
