import { spaceDatabaseQueryResultSchema } from "@ryu/app-host/rpc";
import { asGlyphValue } from "@ryu/ui/components/glyph.ts";
import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
import {
	databaseQueryColumnSchema,
	databaseQueryEnvelopeSchema,
	retrievalModeCancelWireSchema,
	retrievalModeChangeWireSchema,
	retrievalModeJobWireSchema,
	retrievalModeStateSchema,
	retrievalModeStatusWireSchema,
	spaceFileUploadWireSchema,
	spaceUploadErrorSchema,
} from "./spaces-wire-contracts.ts";
// apps/desktop/src/lib/api/spaces.ts
//
// Typed client for Core's Spaces / RAG endpoints (`/api/spaces`). A Space is a
// named document collection backed by a sqlite-vec vector store; documents are
// ingested (chunked + embedded) and searched by whichever retrieval algorithm the
// Space is set to — vector KNN or entity-graph traversal — after which hits are
// link-expanded and neurally reranked — see {@link searchSpace}, which carries
// the detail and the caveats. This header named only the vector branch for one
// round after that function's own doc was corrected, which is why the test file
// pins both. Consumed by the spaces page through the `useSpaces` hook. Wire
// shapes mirror the Core handlers in
// `apps/core/src/server/{mod,spaces}.rs` (snake_case on the wire).

import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import {
	type ResourceVisibility,
	toResourceVisibility,
} from "@/src/lib/resource-visibility.ts";
import { type ApiTarget, apiUrl, request, requestHeaders } from "./client.ts";
import { encodePathId } from "./path-id.ts";

/**
 * Which retrieval algorithm a Space uses.
 *
 * These two spellings are the ONE wire form, produced by `RetrievalMode::as_str`
 * in `crates/core/spaces/src/lib.rs`. Core parses an inbound value with the
 * **strict** `RetrievalMode::parse` (unknown → 400), so a third spelling invented
 * here would be rejected rather than silently degraded — see `spaces.test.ts`,
 * which pins these literals to the Rust so the pair cannot drift apart.
 */
export type RetrievalMode = "graph" | "vector";

/**
 * Coerce a `retrieval_mode` value read back **off the wire** to a known mode.
 *
 * Deliberately lenient, and deliberately the twin of the crate's private
 * `RetrievalMode::from_str` (not its strict `parse`): the value here has already
 * been through Core's write-side validation, so the only way an unknown spelling
 * arrives is a newer Core that added a third mode. Degrading that to `"vector"`
 * keeps the Space listed and usable; throwing would blank the whole Spaces list
 * over one row. Never throws, and is case-sensitive exactly like the Rust.
 */
export function toRetrievalMode(
	value: string | null | undefined
): RetrievalMode {
	return value === "graph" ? "graph" : "vector";
}

/** A named document collection. `documentCount` is computed by Core. */
export interface Space {
	/** Unix milliseconds. */
	createdAt: number;
	description: string | null;
	documentCount: number;
	/** Notion-style glyph from the shared GlyphPicker; null = surface fallback. */
	icon: GlyphValue;
	id: string;
	name: string;
	/**
	 * The retrieval algorithm Core uses whenever this Space is searched — vector
	 * KNN or entity-graph traversal.
	 *
	 * The column is still read in exactly ONE place, `SpaceStore::search_ext` →
	 * `space_mode()` (`crates/core/spaces/src/lib.rs`); what changed is how many
	 * paths reach that function. Two do:
	 *
	 * - a **direct** search — {@link searchSpace} / `POST /api/spaces/:id/search`,
	 *   which the Spaces search boxes and the `ryu_search_space` MCP tool hit;
	 * - the **automatic recall** an agent performs on a normal chat turn.
	 *   `RetrievalStore::retrieve` (`crates/core/rag/src/store/retrieve.rs`) delegates the
	 *   Spaces half of a recall back to `search_ext` through its `SpaceRecall` hook
	 *   (implemented in `apps/core/src/rag_host.rs`), so an agent's Space allowlist
	 *   is answered under each Space's own mode. It used to scan `retrieval.db`
	 *   instead — where a Space's documents are never indexed — so this setting
	 *   reached nothing on a chat turn and the copy had to say so.
	 *
	 * Both links are pinned in `spaces.test.ts`; the UI copy that states this is
	 * `RETRIEVAL_MODE_SCOPE` in `packages/blocks/src/desktop/spaces.tsx`.
	 *
	 * What the mode does NOT change: chunks a graph traversal returns carry no
	 * distance, so a chat turn that draws on several Spaces merges them by rank —
	 * see {@link SpaceMatch.distance}.
	 */
	retrievalMode: RetrievalMode;
	/**
	 * True for a Ryu-owned system Space (Artifacts, Meetings, Canvas, Uploads…) —
	 * a node singleton that Core creates on demand and **refuses to delete**.
	 *
	 * `SpaceStore::delete_space` (`crates/core/spaces/src/lib.rs`) reads the
	 * `system` column first and `bail!`s on `system = 1`, which `DELETE
	 * /api/spaces/:id` turns into a 500 — so a delete offered on one of these can
	 * only ever fail. On an org-bound node it fails earlier and differently (the
	 * `require_resource_write` gate 403s an owner-less row), which is exactly why
	 * the UI reads this flag rather than trying to predict the status code.
	 *
	 * Defaults to `false` when an older Core omits the field: the delete then
	 * stays enabled and errors as it always did, which is strictly better than
	 * greying out every Space against a node that cannot say.
	 */
	system: boolean;
	teamId?: string | null;
	/** Unix milliseconds. */
	updatedAt: number;
	/** Owner-only, organization-wide, or named-team visibility. */
	visibility?: ResourceVisibility;
}

/** Whether a document is a markdown page, a data-grid database, or an
 * Excalidraw whiteboard (its `source` is an Excalidraw scene JSON). */
export type DocumentKind = "page" | "database" | "whiteboard";

/**
 * The RAW `kind` discriminator Core writes for a binary file document.
 *
 * `SpaceStore::create_file` (`crates/core/spaces/src/lib.rs`) inserts
 * `kind = 'file'`; {@link toDocumentKind} then coerces it to `'page'` because a
 * file has no editor route of its own. So {@link SpaceDocument.kind} cannot tell a
 * file from a page and {@link SpaceDocument.rawKind} is the only seam that can —
 * which is why {@link isFileDocument} reads the raw value. Mirrored in
 * `spaces.test.ts` against the Rust insert.
 */
export const FILE_DOCUMENT_KIND = "file";

/** A document inside a Space, with its chunk count. */
export interface SpaceDocument {
	/**
	 * Byte size of the stored blob for a file document; `null` for everything else
	 * (Core omits the field). Additive over `Document.byte_size`, which Core has
	 * always serialized and this client used to discard.
	 */
	byteSize: number | null;
	chunkCount: number;
	/** Unix milliseconds. */
	createdAt: number;
	/** Notion-style glyph; null = kind default icon. */
	icon: GlyphValue;
	id: string;
	/**
	 * Human-readable detail behind {@link indexState}, from Core's
	 * `FileIndexRecord.message`. `null` when absent. Never the document's contents —
	 * Core's own field doc says so, which is why this is safe to render.
	 */
	indexMessage: string | null;
	/**
	 * What happened to this file's **contents**, or `null` when the wire did not say.
	 *
	 * Filled straight off the list response: `GET /api/spaces/:id/documents` now
	 * joins Core's per-document extraction record onto every `kind = 'file'` row (see
	 * {@link DocumentWire}), so one request renders the whole list's badges.
	 *
	 * `null` therefore means one of exactly two things, and both are "say nothing":
	 * the row is **not a file** (a page/database/whiteboard is re-chunked from its
	 * own source on every save, so Core deliberately omits `index` for it), or the
	 * node is an **older Core** that does not send the field. Neither is a claim
	 * about searchability, which is why the view renders `null` as the plain chunk
	 * count rather than as a warning.
	 *
	 * ## Why this is not derived client-side
	 *
	 * Two derivations look available and both are wrong:
	 *
	 * - **`rawKind === 'file'` ⇒ not searchable.** True only before Core wired
	 *   extraction in. It now runs `document_parse::builtin_parse` inline for the
	 *   builtin floor (`.txt`, `.md`, `.csv`, …), so those files are `indexed` by the
	 *   time the upload returns and the rule would libel them.
	 * - **`chunkCount === 1` ⇒ descriptor only.** Coincidence. A short extracted
	 *   document also yields one chunk, so this degrades into a silent lie instead of
	 *   a failing test.
	 *
	 * The state is a fact about the `document.parse` capability — which provider was
	 * bound, whether it could read the format, whether it finished — and only Core
	 * holds it (`FileIndexStore`, `~/.ryu/space-file-index.db`). It has to come over
	 * the wire.
	 */
	indexState: SpaceFileIndexState | null;
	/**
	 * Non-fatal notes from the extraction (a lossy decode, a missing OCR tool, a
	 * truncated result). Empty when there are none or the wire did not say.
	 */
	indexWarnings: string[];
	/** `'page'` (markdown) or `'database'` (data grid). */
	kind: DocumentKind;
	/**
	 * MIME type of a file document (`application/pdf`, …); `null` for everything
	 * else. Same provenance as {@link byteSize} — read off `Document.mime`, not
	 * inferred from the title.
	 */
	mime: string | null;
	/** The RAW kind discriminator (`kind` above coerces unknown kinds to `'page'`).
	 *  App-owned documents carry `app:<pluginId>` here so the list can route them to
	 *  their owning Companion app. Empty string when the wire omits it. */
	rawKind: string;
	spaceId: string;
	title: string;
	/** Unix milliseconds. */
	updatedAt: number;
}

/** Whether a listed document is a stored binary file rather than an editable doc. */
export function isFileDocument(doc: Pick<SpaceDocument, "rawKind">): boolean {
	return doc.rawKind === FILE_DOCUMENT_KIND;
}

/**
 * What happened to a file document's **contents**, as opposed to its descriptor.
 *
 * The four stored states are `IndexState::as_str` in
 * `apps/core/src/space_file_index.rs` — whose doc says in as many words *"The stable
 * wire string. Clients branch on this."* The fifth, `unattempted`, has no stored
 * variant: it is what `unknown_json` synthesises for a document with **no status
 * row**, and Core's comment is explicit that this is *"deliberately not `skipped` —
 * nobody looked, as opposed to nobody could read it."*
 *
 * The distinction between the last three is the whole point of this type: they are
 * three different things for the user to do (nothing / install a reader / retry), and
 * collapsing them into one "not searchable" would put us back where we started.
 *
 * | state | what it means | what the user can do |
 * |---|---|---|
 * | `pending` | a reader is working on it now | wait |
 * | `indexed` | its text is chunked and searchable | nothing |
 * | `skipped` | nothing on this node can read the format | install a document reader |
 * | `failed` | a reader tried and could not finish | read the message; upload again |
 * | `unattempted` | nobody has looked — every file stored before extraction shipped | upload again, or paste the text |
 */
export type SpaceFileIndexState =
	| "failed"
	| "indexed"
	| "pending"
	| "skipped"
	| "unattempted";

/**
 * Coerce a `state` read **off the wire** to a known index state, or `null`.
 *
 * `null` — not a recognised state, or the field is absent — deliberately means "say
 * nothing", never "not searchable". A newer Core that adds a sixth state must make
 * this UI go quiet, not make it accuse an indexed file of being unsearchable. Same
 * lenient-read doctrine as {@link toRetrievalMode}, and the opposite default:
 * `toRetrievalMode` degrades to a usable mode because a Space must still render,
 * whereas a *claim about searchability* has no safe default and so is withheld.
 */
export function toFileIndexState(
	value: string | null | undefined
): SpaceFileIndexState | null {
	switch (value) {
		case "failed":
		case "indexed":
		case "pending":
		case "skipped":
		case "unattempted":
			return value;
		default:
			return null;
	}
}

/**
 * The states in which a file is stored and openable but a content search cannot
 * reach what is inside it.
 *
 * `pending` is NOT one of them: the text is on its way, and telling a user their
 * file is unsearchable while a reader is mid-parse would be wrong within seconds.
 * `indexed` is not one either, obviously — and that is the case a `rawKind === 'file'`
 * rule got wrong, because a `.txt`/`.md`/`.csv` is read by Core's in-process floor
 * and is `indexed` before the upload response is even written.
 */
export const NOT_CONTENT_SEARCHABLE_STATES: readonly SpaceFileIndexState[] = [
	"failed",
	"skipped",
	"unattempted",
];

/** A single ranked chunk returned from a Space search. */
export interface SpaceMatch {
	chunkId: string;
	content: string;
	/**
	 * **Do not rank on this field, and do not read magnitudes off it.** It used to
	 * be documented as "squared L2 distance from the query vector", which is only
	 * ever true of one of the three ways a chunk can end up in this array:
	 *
	 * - a vector-mode KNN hit carries its real `vec0` distance (smaller is closer);
	 * - a graph-mode traversal hit is assigned the constant `0.0`;
	 * - a chunk pulled in by `[[page]]`-link expansion (which runs in **both**
	 *   modes) is assigned the constant `1.0`.
	 *
	 * The last two are placeholders, not measurements. On top of that Core's bge
	 * reranker re-orders the survivors **without rewriting `distance`**, so array
	 * order — not this number — is the ranking. Sorting by `distance` un-does the
	 * rerank; averaging or thresholding it mixes a metric with two constants.
	 */
	distance: number;
	documentId: string;
}

export type SpaceDatabaseQueryValue =
	| null
	| boolean
	| number
	| string
	| SpaceDatabaseQueryValue[]
	| { [key: string]: SpaceDatabaseQueryValue };

export interface SpaceDatabaseQuerySchemaColumn {
	id: string;
	label: string;
	name: string;
}

export interface SpaceDatabaseQueryResult {
	columns: string[];
	rows: SpaceDatabaseQueryValue[][];
	schema: SpaceDatabaseQuerySchemaColumn[];
	truncated: boolean;
}

interface SpaceWire {
	created_at: number;
	description?: string | null;
	document_count: number;
	icon?: GlyphValue;
	id: string;
	name: string;
	/** Optional only for tolerance against an older Core; current Core always
	 *  serializes it (`spaces::Space.retrieval_mode`, no `skip_serializing_if`). */
	retrieval_mode?: string;
	/** `spaces::Space.system` — `#[serde(default)]` on the Rust side, so treat an
	 *  absent field as "not a system space". See {@link Space.system}. */
	system?: boolean;
	team_id?: string | null;
	updated_at: number;
	visibility?: string;
}

/**
 * The `documents[]` element of `GET /api/spaces/:id/documents`, mirroring
 * `spaces::Document` (`crates/core/spaces/src/lib.rs`).
 *
 * `mime` / `byte_size` are `skip_serializing_if = "Option::is_none"` on the Rust
 * side — present for `kind = 'file'` rows and absent otherwise, which is why both
 * are optional here rather than nullable.
 *
 * ## `index` — joined onto file rows by Core, one read for the whole list
 *
 * Core records per-document extraction state (`FileIndexRecord` in
 * `apps/core/src/space_file_index.rs`) and serialises it under the key `index` —
 * the same key, holding the same object, on all three responses that carry it:
 * `POST /api/spaces/:id/files`, `POST /api/uploads`, and now this list. That is why
 * {@link toFileIndex} is the single reader for all of them.
 *
 * It arrives on `kind = 'file'` rows **only**, and the omission elsewhere is
 * deliberate rather than incidental: a page, database or whiteboard is re-chunked
 * from its own source on every save, so "was its text extracted" is not a question
 * about it. Core stamping `unattempted` on those rows would make this client badge
 * every page in the Space "Name only".
 *
 * The join is Core-side because it has to be — the rows come from `ryu-spaces`
 * (which has no dependency on `apps/core` and must keep none) while the state lives
 * in Core's own `space-file-index.db`. This client used to close the gap by fanning
 * out one `…/documents/:doc_id/index` request per file row, eight at a time, against
 * a Space (Uploads) whose length is bounded by nothing. That fan-out is gone.
 *
 * If Core ever re-spells the key or flattens the object, THIS is the single place to
 * re-point — {@link toDocument} is its only reader.
 */
interface DocumentWire {
	byte_size?: number | null;
	chunk_count: number;
	created_at: number;
	icon?: GlyphValue;
	id: string;
	/** `FileIndexRecord::to_json()` on file rows; absent on every other kind. Only
	 *  `state`, `message` and `warnings` are read; the rest is provenance for a
	 *  future re-index. */
	index?: FileIndexWire | null;
	kind?: string;
	mime?: string | null;
	space_id: string;
	title: string;
	updated_at?: number;
}

/** A literal global page hit returned by `GET /api/spaces/search`. */
export interface SpaceLexicalHit {
	createdAt: number;
	documentId: string;
	snippet: string;
	spaceId: string;
	spaceName: string;
	title: string;
	updatedAt: number;
}

interface SpaceLexicalHitWire {
	created_at: number;
	document_id: string;
	snippet: string;
	space_id: string;
	space_name: string;
	title: string;
	updated_at: number;
}

interface MatchWire {
	chunk_id: string;
	content: string;
	distance: number;
	document_id: string;
}

function toSpace(s: SpaceWire): Space {
	return {
		id: s.id,
		name: s.name,
		description: s.description ?? null,
		createdAt: s.created_at,
		updatedAt: s.updated_at,
		documentCount: s.document_count,
		icon: s.icon ?? null,
		retrievalMode: toRetrievalMode(s.retrieval_mode),
		system: s.system ?? false,
		teamId: s.team_id ?? null,
		visibility: toResourceVisibility(s.visibility),
	};
}

function toDocumentKind(kind?: string): DocumentKind {
	if (kind === "database") {
		return "database";
	}
	if (kind === "whiteboard") {
		return "whiteboard";
	}
	return "page";
}

function toDocument(d: DocumentWire): SpaceDocument {
	return {
		id: d.id,
		spaceId: d.space_id,
		title: d.title,
		createdAt: d.created_at,
		updatedAt: d.updated_at ?? d.created_at,
		chunkCount: d.chunk_count,
		kind: toDocumentKind(d.kind),
		rawKind: d.kind ?? "",
		mime: d.mime ?? null,
		byteSize: d.byte_size ?? null,
		// Read defensively at every hop. Core sends `index` on file rows and omits it
		// everywhere else (see `DocumentWire`), and an older node sends it nowhere, so
		// every branch here must survive `undefined` without throwing and without
		// inventing a state.
		...withFileIndex(toFileIndex(d.index)),
		icon: d.icon ?? null,
	};
}

/** The three document fields a {@link SpaceFileIndex} populates, so the list reader
 *  and the per-document fetch cannot fill them differently. */
export function withFileIndex(
	index: SpaceFileIndex
): Pick<SpaceDocument, "indexMessage" | "indexState" | "indexWarnings"> {
	return {
		indexState: index.state,
		indexMessage: index.message,
		indexWarnings: index.warnings,
	};
}

function toMatch(m: MatchWire): SpaceMatch {
	return {
		chunkId: m.chunk_id,
		documentId: m.document_id,
		content: m.content,
		distance: m.distance,
	};
}

/**
 * The ceiling **every upload from this app actually hits**, in bytes.
 *
 * Mirrors `MAX_UPLOAD_BYTES` in `apps/core/src/server/uploads.rs` (= `MAX_MEDIA_BYTES`,
 * 32 MiB). Chat attachments, editor pastes and the plugin host's `ui.uploadFile` all
 * `POST /api/uploads`, so this — not {@link SPACE_UPLOAD_MAX_BYTES} — is the number a
 * limits panel may print, and it is the one the node will keep. `/api/uploads` layers
 * the limit explicitly on the route, which is what makes the handler's own check the
 * one that answers (pinned by `a_route_without_an_explicit_limit_caps_at_axums_default`
 * in `uploads.rs`).
 *
 * Equal to `MAX_PARSE_BYTES` in `src/lib/composer/attachments.ts` by construction, not
 * by coincidence: Core defines `document_parse::MAX_PARSE_BYTES = MAX_UPLOAD_BYTES` so
 * "a file the user could attach is a file the parser will look at".
 */
export const NODE_UPLOAD_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The ceiling `POST /api/spaces/:id/files` declares **and now reaches** — 32 MiB.
 *
 * Mirrors `MAX_FILE_BYTES` in `apps/core/src/server/mod.rs`, which is *defined as*
 * `uploads::MAX_UPLOAD_BYTES` rather than a second literal, so the two cannot drift.
 * Pinned to the Rust in `spaces.test.ts`.
 *
 * ## It used to be 200 MiB, and that was three wrong numbers at once
 *
 * 1. The panel printed 200 MB as "Maximum file in a Space", so a 100 MB PDF was
 *    refused by a node that had just said it would take it.
 * 2. Every upload this app performs goes to `/api/uploads` and stopped at
 *    {@link NODE_UPLOAD_MAX_BYTES} — 32 MiB.
 * 3. The route could not honour 200 MiB anyway: registered with no `DefaultBodyLimit`,
 *    axum's implicit 2 MiB body limit rejected the request before the handler's check
 *    could run — and the body is base64, so the real ceiling was **~1.5 MiB of file**,
 *    roughly 133x below what was advertised. Proved, not inferred, by
 *    `a_route_without_an_explicit_limit_caps_at_axums_default` and
 *    `the_unlayered_json_route_capped_at_just_under_1_5_mib_of_file` in
 *    `apps/core/src/server/uploads.rs`.
 *
 * Core now layers `SPACE_FILE_BODY_LIMIT` on the route so the handler's check is the
 * one that answers, and the declared ceiling equals the enforced one. Raising this
 * means raising all three together — the constant, the body limit, and whatever the
 * limits panel prints — or the discrepancy comes back in a new place.
 *
 * Equal to {@link NODE_UPLOAD_MAX_BYTES} by construction. Kept as a distinct export
 * because the two describe different routes, and a future divergence should be a
 * deliberate edit here rather than a silent alias.
 */
export const SPACE_UPLOAD_MAX_BYTES = NODE_UPLOAD_MAX_BYTES;

/** Byte counts as a person reads them (`200 MB`, `1.5 GB`). Binary units, one
 *  decimal only where it carries information. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return "0 B";
	}
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const rounded =
		value >= 10 || Number.isInteger(value) ? Math.round(value) : value;
	return `${Number(rounded.toFixed(1))} ${units[unit]}`;
}

/** List all Spaces, most-recently-updated first. */
export async function fetchSpaces(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<Space[]> {
	const json = await request<{ spaces?: SpaceWire[] }>(
		target,
		"/api/spaces",
		{
			signal,
		},
		listSpacesResponseCodec
	);
	return (json.spaces ?? []).map(toSpace);
}

/** What Core actually created, including the mode it resolved. */
export interface CreatedSpace {
	id: string;
	/**
	 * The mode the new Space was stamped with — echoed by Core, NOT assumed here.
	 * When `retrievalMode` was omitted at the call site this is the node-wide
	 * `rag_strategy` default, which an operator can set to `"graph"`. Reading it
	 * back is the only way a caller learns that without a follow-up GET.
	 */
	retrievalMode: RetrievalMode;
}

/**
 * Create a new Space.
 *
 * `retrievalMode` is **optional on purpose**. Core resolves an omitted field
 * through the node-wide `rag_strategy` (`RYU_RAG_STRATEGY` / `registry.json`),
 * which then falls through to `"vector"`. Always sending a value — even the value
 * the UI happens to be showing — would make that operator setting unreachable from
 * the desktop, i.e. a setting that cannot take effect. So callers pass a mode only
 * when the user actually picked one, and read {@link CreatedSpace.retrievalMode}
 * to learn what they got.
 */
export async function createSpace(
	target: ApiTarget,
	name: string,
	description: string | null,
	retrievalMode?: RetrievalMode,
	visibility?: ResourceVisibility
): Promise<CreatedSpace> {
	const body: CreateSpaceWireRequest = { name, description };
	if (retrievalMode !== undefined) {
		body.retrieval_mode = retrievalMode;
	}
	if (visibility !== undefined) {
		body.visibility = visibility;
	}
	const json = await request<{ id: string; retrieval_mode?: string }>(
		target,
		"/api/spaces",
		{ method: "POST", body },
		responseCodec1
	);
	return { id: json.id, retrievalMode: toRetrievalMode(json.retrieval_mode) };
}

/** Change a Space's sharing scope without touching its pages or retrieval index. */
export async function setSpaceVisibility(
	target: ApiTarget,
	id: string,
	visibility: ResourceVisibility,
	teamId?: string | null
): Promise<void> {
	const body: SpaceVisibilityWireRequest = { visibility };
	if (visibility === "team" && teamId) {
		body.team_id = teamId;
	}
	await request(
		target,
		`/api/spaces/${encodeURIComponent(id)}/visibility`,
		{
			method: "POST",
			body,
		},
		responseCodec2
	);
}

/** Rename a user-created Space without touching its documents or retrieval index. */
export async function renameSpace(
	target: ApiTarget,
	id: string,
	name: string
): Promise<void> {
	await request(
		target,
		`/api/spaces/${id}/name`,
		{
			method: "POST",
			body: { name },
		},
		responseCodec3
	);
}

/**
 * What a {@link setSpaceRetrievalMode} call actually did — the client mirror of
 * Core's `RetrievalModeChange`.
 *
 * Every field exists so the UI can *state the consequence*. A mode switch is not a
 * metadata edit: Core rebuilds the Space's entity graph from the chunks already on
 * disk (switching to graph) or drops it (switching to vector), inside the same
 * transaction as the column write. `chunksScanned` / `graphNodes` / `graphEdges`
 * are what that rebuild covered.
 *
 * That rebuild is **not** fast. Measured on-disk in `crates/core/spaces/src/lib.rs`
 * (`build_graph_for_chunks`, which carries the table and the reproduction command):
 * a 1,566-chunk Space writes ~5.1M edge rows and takes 46–87 s, and the per-chunk
 * cost *rises* with size. The call also holds the single SQLite connection for the
 * whole transaction, so every other Space is blocked meanwhile. Anything rendering
 * this type should treat the call as slow, not instant.
 */
export interface RetrievalModeChange {
	/** False when the Space was already in `mode`. Re-asserting **`"graph"`** on a
	 *  graph Space still rebuilds the graph — see `graphRebuilt` — because a full
	 *  rebuild is the *only* repair path for a Space whose graph was dropped or
	 *  never built; there is no incremental top-up. (Re-asserting `"vector"` on a
	 *  vector Space rebuilds nothing: `graphRebuilt` is false and there is no graph
	 *  to repair. The repair story is graph-only.)
	 *
	 *  So `changed: false` does NOT mean "nothing happened". It costs exactly what a
	 *  first build costs. This previously read "the cheap repair path", mirroring a
	 *  Rust doc that has since been corrected against real measurements.
	 *
	 *  **That repair is API-only — this desktop cannot produce `changed: false`.**
	 *  `handleRetrievalModeChange` in `src/pages/SpacesPage.tsx` returns early when
	 *  `selected.retrievalMode === mode`, so every call the UI makes is a real
	 *  switch. The guard is deliberate and stays: a rebuild is an expensive
	 *  background job, and a picker whose current value re-fires that is a second
	 *  graph rebuild one stray click away. An operator repairs a graph by POSTing
	 *  `/api/spaces/:id/retrieval-mode` directly. Read
	 *  the fields below as documenting the endpoint, not a state this UI reaches. */
	changed: boolean;
	/** Chunks the rebuild walked. `0` when switching to vector, and also `0` for an
	 *  empty Space — which is a correct outcome, not a failure. */
	chunksScanned: number;
	graphEdges: number;
	graphNodes: number;
	/** True whenever the new mode is `"graph"`; false when switching to vector,
	 *  which *drops* the now-unmaintained graph instead. */
	graphRebuilt: boolean;
	mode: RetrievalMode;
	/** Core's own plain-language summary of what was and was not touched. */
	note: string;
	previous: RetrievalMode;
}

/** Live state reported while Core rebuilds a Space's retrieval graph. */
export interface RetrievalModeProgress {
	jobId: string;
	processedChunks: number;
	state: "running" | "cancelling" | "completed" | "cancelled" | "failed";
	totalChunks: number;
}

/** `1 entity` / `2 entities`, without pulling in an i18n dependency. */
function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

/**
 * Plain-language summary of what a retrieval-mode switch did, for display next to
 * the control that caused it.
 *
 * Core also returns a prose `note`; this says the same thing plus the counts, so
 * the user learns whether the rebuild actually found anything. The empty-Space
 * case is called out separately on purpose: "mapped 0 entities across 0 chunks"
 * reads as a failure when it is the correct outcome for a Space with no documents.
 */
export function describeRetrievalModeChange(
	change: RetrievalModeChange
): string {
	if (!change.graphRebuilt) {
		return "Vector retrieval is on. The entity graph was discarded — switching back to Graph rebuilds it. Nothing was re-embedded.";
	}
	if (change.chunksScanned === 0) {
		return "Graph retrieval is on. This space has no documents yet, so there was nothing to map — documents will be mapped as you add them.";
	}
	return `Graph retrieval is on. Mapped ${plural(change.graphNodes, "entity", "entities")} and ${plural(change.graphEdges, "connection", "connections")} across ${plural(change.chunksScanned, "chunk", "chunks")} already in this space. Nothing was re-embedded.`;
}

interface RetrievalModeChangeWire {
	changed?: boolean;
	chunks_scanned?: number;
	graph_edges?: number;
	graph_nodes?: number;
	graph_rebuilt?: boolean;
	job_id?: string;
	mode?: string;
	note?: string;
	previous?: string;
	previous_retrieval_mode?: string;
	retrieval_mode?: string;
}

interface RetrievalModeStatusWire {
	change?: RetrievalModeChangeWire | null;
	error?: string | null;
	job_id: string;
	processed_chunks?: number;
	requested_mode?: string;
	space_id: string;
	state: RetrievalModeProgress["state"];
	total_chunks?: number;
}

const RETRIEVAL_MODE_MAX_POLLS = 7200;

class RetrievalModePollingTimeout extends Error {}

function isRetrievalModeWire(
	value: string | undefined
): value is RetrievalMode {
	return value === "vector" || value === "graph";
}

function isLegacyRetrievalModeChange(json: RetrievalModeChangeWire): boolean {
	return (
		isRetrievalModeWire(json.retrieval_mode ?? json.mode) &&
		isRetrievalModeWire(json.previous_retrieval_mode ?? json.previous) &&
		json.changed !== undefined &&
		json.graph_rebuilt !== undefined
	);
}

export interface SetRetrievalModeOptions {
	onProgress?: (progress: RetrievalModeProgress) => void;
	signal?: AbortSignal;
}

function toRetrievalModeChange(
	json: RetrievalModeChangeWire
): RetrievalModeChange {
	return {
		mode: toRetrievalMode(json.retrieval_mode ?? json.mode),
		previous: toRetrievalMode(json.previous_retrieval_mode ?? json.previous),
		changed: json.changed ?? false,
		graphRebuilt: json.graph_rebuilt ?? false,
		chunksScanned: json.chunks_scanned ?? 0,
		graphNodes: json.graph_nodes ?? 0,
		graphEdges: json.graph_edges ?? 0,
		note: json.note ?? "",
	};
}

function toRetrievalModeProgress(
	status: RetrievalModeStatusWire
): RetrievalModeProgress {
	return {
		jobId: status.job_id,
		state: status.state,
		processedChunks: status.processed_chunks ?? 0,
		totalChunks: status.total_chunks ?? 0,
	};
}

function waitForRetrievalModePoll(signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout>;
		const abort = () => {
			clearTimeout(timer);
			cleanup();
			reject(
				new DOMException(
					"The retrieval-mode rebuild was cancelled.",
					"AbortError"
				)
			);
		};
		const cleanup = () => signal?.removeEventListener("abort", abort);
		const complete = () => {
			cleanup();
			resolve();
		};
		if (signal?.aborted) {
			abort();
			return;
		}
		timer = setTimeout(complete, 250);
		signal?.addEventListener("abort", abort, { once: true });
	});
}

/**
 * Change an existing Space's retrieval mode.
 *
 * This is a real re-index of the entity graph, not a flag flip. Core accepts it as
 * a background job and returns HTTP 202; this client polls until the job commits or
 * is cancelled. Callers should keep the control disabled while polling rather than
 * letting a second click queue a second full rebuild.
 *
 * Two consequences worth stating because they are not the usual HTTP intuitions:
 *
 * - **Aborting requests cancellation.** Once the job id is known, an aborted
 *   `AbortSignal` posts to the cancel endpoint; Core rolls back the staged swap
 *   and the previous mode remains active.
 * - **Progress is authoritative.** The local mode is patched only after a
 *   completed status includes the committed change; running and cancelled states
 *   never make an optimistic mode update.
 *
 * The mode this writes governs every search of the Space — {@link searchSpace} and
 * the automatic recall an agent does on a chat turn, which delegates to the same
 * Core function. See {@link Space.retrievalMode} for the two paths and where they
 * meet.
 */
export async function setSpaceRetrievalMode(
	target: ApiTarget,
	id: string,
	mode: RetrievalMode,
	options: SetRetrievalModeOptions = {}
): Promise<RetrievalModeChange> {
	const encodedSpaceId = encodeURIComponent(id);
	const json = retrievalModeChangeWireSchema.parse(
		await request(
			target,
			`/api/spaces/${encodedSpaceId}/retrieval-mode`,
			{
				method: "POST",
				body: { retrieval_mode: mode },
				// Core accepts this POST before it returns the job id. Do not let Stop
				// interrupt that small handoff: an aborted fetch can otherwise leave an
				// accepted rebuild running with no id for the cancellation path below.
			},
			retrievalModeChangeWireSchema
		)
	);
	// Keep accepting a completed response for older Core nodes, but the current
	// contract is 202 + a job id. The local Space mode is updated only after the
	// status endpoint reports `completed` and includes the committed change.
	if (json.job_id === undefined) {
		if (!isLegacyRetrievalModeChange(json)) {
			throw new Error("Core returned an invalid retrieval-mode response.");
		}
		return toRetrievalModeChange(json);
	}
	const parsedJob = retrievalModeJobWireSchema.safeParse(json);
	if (
		!parsedJob.success ||
		parsedJob.data.job_id.trim() === "" ||
		parsedJob.data.space_id !== id
	) {
		throw new Error("Core returned a retrieval-mode job for the wrong Space.");
	}
	const job = parsedJob.data;
	const statusPath = `/api/spaces/${encodedSpaceId}/retrieval-mode/status?job_id=${encodeURIComponent(job.job_id)}`;
	const cancelPath = `/api/spaces/${encodedSpaceId}/retrieval-mode/cancel`;
	const poll = async (signal?: AbortSignal): Promise<RetrievalModeChange> => {
		for (let attempt = 0; attempt < RETRIEVAL_MODE_MAX_POLLS; attempt += 1) {
			const status = retrievalModeStatusWireSchema.parse(
				await request(
					target,
					statusPath,
					{
						signal,
					},
					retrievalModeStatusWireSchema
				)
			);
			if (status.job_id !== job.job_id || status.space_id !== id) {
				throw new Error(
					"Core returned status for the wrong retrieval-mode job."
				);
			}
			const progressState = retrievalModeStateSchema.safeParse(status.state);
			if (!progressState.success) {
				throw new Error("Core returned an unknown retrieval-mode job state.");
			}
			options.onProgress?.(
				toRetrievalModeProgress({ ...status, state: progressState.data })
			);
			if (status.state === "completed") {
				if (!status.change) {
					throw new Error(
						"Core reported a completed retrieval-mode job without its committed change."
					);
				}
				return toRetrievalModeChange(status.change);
			}
			if (status.state === "cancelled") {
				throw new DOMException(
					"The retrieval-mode rebuild was cancelled.",
					"AbortError"
				);
			}
			if (status.state === "failed") {
				throw new Error(status.error ?? "The retrieval-mode rebuild failed.");
			}
			if (status.state !== "running" && status.state !== "cancelling") {
				throw new Error("Core returned an unknown retrieval-mode job state.");
			}
			await waitForRetrievalModePoll(signal);
		}
		throw new RetrievalModePollingTimeout(
			"Timed out waiting for the retrieval-mode rebuild."
		);
	};
	try {
		return await poll(options.signal);
	} catch (error) {
		const abortedByCaller =
			error instanceof DOMException &&
			error.name === "AbortError" &&
			options.signal?.aborted;
		if (abortedByCaller || error instanceof RetrievalModePollingTimeout) {
			const cancellation = retrievalModeCancelWireSchema.parse(
				await request(
					target,
					cancelPath,
					{
						method: "POST",
						body: { job_id: job.job_id },
					},
					retrievalModeCancelWireSchema
				)
			);
			// An accepted cancellation is asynchronous too: Core may acknowledge the
			// request before the worker reaches its terminal state. Keep observing the
			// job so the UI does not report cancellation while the rebuild is still
			// committing or rolling back.
			if (
				cancellation.cancelled === true ||
				cancellation.cancelled === false ||
				cancellation.finalizing === true
			) {
				return await poll();
			}
		}
		throw error;
	}
}

/** Delete a Space and everything in it. Returns whether a row was removed. */
export async function deleteSpace(
	target: ApiTarget,
	id: string
): Promise<boolean> {
	const json = await request<{ removed?: boolean }>(
		target,
		`/api/spaces/${id}`,
		{
			method: "DELETE",
		},
		responseCodec4
	);
	return json?.removed ?? false;
}

/** Set or clear a Space's Notion-style glyph. */
export async function setSpaceIcon(
	target: ApiTarget,
	id: string,
	icon: GlyphValue
): Promise<void> {
	await request(
		target,
		`/api/spaces/${id}/icon`,
		{
			method: "POST",
			body: { icon },
		},
		responseCodec5
	);
}

/** Set or clear a document's glyph without re-embedding the page. */
export async function setDocumentIcon(
	target: ApiTarget,
	spaceId: string,
	documentId: string,
	icon: GlyphValue
): Promise<void> {
	await request(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}/icon`,
		{
			method: "POST",
			body: { icon },
		},
		responseCodec6
	);
}

/** List the documents in a Space. */
export async function fetchDocuments(
	target: ApiTarget,
	spaceId: string,
	signal?: AbortSignal
): Promise<SpaceDocument[]> {
	const json = await request<{ documents?: DocumentWire[] }>(
		target,
		`/api/spaces/${spaceId}/documents`,
		{ signal },
		listDocumentsResponseCodec
	);
	return (json.documents ?? []).map(toDocument);
}

/** Search visible Space metadata and document text with literal lexical matching. */
export async function searchSpaceDocuments(
	target: ApiTarget,
	query: string,
	limit = 8,
	signal?: AbortSignal
): Promise<SpaceLexicalHit[] | null> {
	try {
		const params = new URLSearchParams({
			limit: String(limit),
			q: query,
		});
		const json = await request<{ hits?: SpaceLexicalHitWire[] }>(
			target,
			`/api/spaces/search?${params.toString()}`,
			{ signal },
			responseCodec7
		);
		return (json.hits ?? []).map((hit) => ({
			createdAt: hit.created_at,
			documentId: hit.document_id,
			spaceId: hit.space_id,
			spaceName: hit.space_name,
			snippet: hit.snippet,
			title: hit.title,
			updatedAt: hit.updated_at || hit.created_at,
		}));
	} catch {
		return null;
	}
}

/**
 * One document's content-index status — Core's `FileIndexRecord::to_json`, as it
 * arrives under `index` on a file row of `GET /api/spaces/:id/documents`.
 *
 * Only the three fields a user-facing surface can act on are read here;
 * `reason_code`, `backend_id`, `backend_version`, `chunk_count` and `updated_at` are
 * provenance for a future re-index and are deliberately left on the wire rather than
 * mirrored into a type nothing renders.
 */
export interface SpaceFileIndex {
	/** Human-readable detail behind {@link state}. Core guarantees this is never
	 *  the document's contents, which is what makes it safe to render. */
	message: string | null;
	/** `null` when Core answered with a state this build does not know. */
	state: SpaceFileIndexState | null;
	/** Non-fatal notes from a parse that DID work (lossy decode, missing OCR tool,
	 *  truncated result). Empty when there are none. */
	warnings: string[];
}

interface FileIndexWire {
	message?: string | null;
	state?: string | null;
	warnings?: string[] | null;
}

function toFileIndex(w: FileIndexWire | null | undefined): SpaceFileIndex {
	return {
		state: toFileIndexState(w?.state),
		message: w?.message ?? null,
		warnings: w?.warnings ?? [],
	};
}

// There is no `fetchDocumentIndexStatus` here any more, and its absence is the
// point. `GET /api/spaces/:id/documents/:doc_id/index` is still mounted in Core (it
// is a documented single-document read, and the create responses are not the only
// way to ask), but this client has no reason to call it: the list route joins the
// same record onto every file row, so a surface that fanned out over N files to
// render N badges was paying N HTTP round trips for something one response already
// contains. Keeping the helper alongside the joined field would leave two ways to
// fill the same three document fields, which is how they drift apart.

/** Ingest a document into a Space. Returns the new document id. */
export async function ingestDocument(
	target: ApiTarget,
	spaceId: string,
	title: string,
	content: string
): Promise<string> {
	const json = await request<{ document_id: string }>(
		target,
		`/api/spaces/${spaceId}/documents`,
		{
			method: "POST",
			body: { title, content },
		},
		responseCodec8
	);
	return json.document_id;
}

/** Full editable content of a document (Notion-like page). */
export interface SpaceDocumentContent {
	chunkCount: number;
	/** Unix milliseconds. */
	createdAt: number;
	/** Notion-style glyph; null = kind default. */
	icon: GlyphValue;
	id: string;
	/** `'page'` (markdown) or `'database'` (data grid; `source` is grid JSON). */
	kind: DocumentKind;
	/** Canonical markdown source of the page. */
	source: string;
	spaceId: string;
	title: string;
	/** Unix milliseconds. */
	updatedAt: number;
}

interface DocumentContentWire {
	chunk_count: number;
	created_at: number;
	icon?: GlyphValue;
	id: string;
	kind?: string;
	source: string;
	space_id: string;
	title: string;
	updated_at: number;
}

function toDocumentContent(d: DocumentContentWire): SpaceDocumentContent {
	return {
		id: d.id,
		spaceId: d.space_id,
		title: d.title,
		source: d.source,
		createdAt: d.created_at,
		updatedAt: d.updated_at,
		chunkCount: d.chunk_count,
		kind: toDocumentKind(d.kind),
		icon: d.icon ?? null,
	};
}

/**
 * Create a new blank markdown page in a Space. Returns the new document id.
 * Pass `parentId` (a database document id) to create a hidden "row page" — the
 * body of a database row, which embeds like a page but is excluded from the
 * Space's top-level document list.
 */
export async function createPage(
	target: ApiTarget,
	spaceId: string,
	title: string,
	parentId?: string
): Promise<string> {
	const json = await request<{ id: string }>(
		target,
		`/api/spaces/${spaceId}/pages`,
		{ method: "POST", body: { title, parent_id: parentId } },
		responseCodec9
	);
	return json.id;
}

/**
 * Create a new blank database (data grid) in a Space. Returns the new document
 * id. The grid editor saves its `{columns, rows}` JSON via {@link updateDocument}.
 */
export async function createDatabase(
	target: ApiTarget,
	spaceId: string,
	title: string
): Promise<string> {
	const json = await request<{ id: string }>(
		target,
		`/api/spaces/${spaceId}/databases`,
		{ method: "POST", body: { title } },
		responseCodec10
	);
	return json.id;
}

/**
 * Create a new blank whiteboard (Excalidraw) in a Space. Returns the new
 * document id. The board editor saves its Excalidraw scene JSON via
 * {@link updateDocument}; Core embeds the flattened element text for search.
 */
export async function createWhiteboard(
	target: ApiTarget,
	spaceId: string,
	title: string
): Promise<string> {
	const json = await request<{ id: string }>(
		target,
		`/api/spaces/${spaceId}/whiteboards`,
		{ method: "POST", body: { title } },
		responseCodec11
	);
	return json.id;
}

/**
 * What `POST /api/spaces/:id/files` answers with — the stored document, plus what
 * happened when Core tried to read its **contents**.
 *
 * {@link index} is the part callers must not skip. A 200 means the bytes are
 * stored; it does NOT mean the file is searchable. Core runs extraction on the
 * same call and reports the outcome here, and `skipped` / `failed` are three
 * different things for the user to do — see {@link SpaceFileIndex} and the table
 * on {@link SpaceFileIndexState}. A surface that renders "Uploaded ✓" off the
 * status code alone tells a user their unreadable PDF is searchable.
 */
export interface UploadedSpaceFile {
	byteSize: number;
	documentId: string;
	/** Extraction outcome, read through the same {@link toFileIndex} every other
	 *  carrier of this object uses. */
	index: SpaceFileIndex;
	mime: string;
}

/** Strip the `data:<mime>;base64,` prefix `FileReader` prepends. Core decodes the
 *  field with a plain `STANDARD.decode`, so the prefix is a `400 invalid base64`. */
function base64Payload(dataUrl: string): string {
	const comma = dataUrl.indexOf(",");
	return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

function readAsBase64(blob: Blob, label = "file"): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(base64Payload(String(reader.result ?? "")));
		reader.onerror = () =>
			reject(reader.error ?? new Error(`Couldn't read ${label}`));
		reader.readAsDataURL(blob);
	});
}

/**
 * Store `file` as a first-class file document in a Space
 * (`POST /api/spaces/:id/files`).
 *
 * ## Why `XMLHttpRequest` and not the shared {@link request}
 *
 * `fetch` reports no upload progress — there is no `onprogress` for a request
 * body — so a percentage rendered next to a `fetch` upload can only be a timer
 * pretending. This is 32 MiB of base64 over a possibly-remote node, which is
 * exactly the case where the number has to be real. Auth headers still come from
 * {@link requestHeaders}, so this path cannot drift from every other call.
 *
 * `onProgress` reports the **upload** fraction only, and is not called at all
 * while the file is being read into base64 locally: a caller should show an
 * indeterminate state until the first callback rather than animate the read.
 */
export async function uploadSpaceFile(
	target: ApiTarget,
	spaceId: string,
	file: File,
	opts?: { onProgress?: (fraction: number) => void; signal?: AbortSignal }
): Promise<UploadedSpaceFile> {
	// Refuse locally at the same ceiling the handler enforces, so a too-large file
	// costs neither the base64 expansion nor the round trip it would be rejected on.
	if (file.size > SPACE_UPLOAD_MAX_BYTES) {
		throw new Error(
			`${file.name} is ${formatBytes(file.size)} — the limit is ${formatBytes(SPACE_UPLOAD_MAX_BYTES)}.`
		);
	}
	const dataBase64 = await readAsBase64(file, file.name);
	const headers = await requestHeaders(target, {
		"content-type": "application/json",
	});
	const body = JSON.stringify({
		title: file.name || "Untitled",
		mime: file.type || "application/octet-stream",
		data_base64: dataBase64,
	});
	const wire = await new Promise<{
		byte_size?: number;
		id: string;
		index?: FileIndexWire | null;
		mime?: string;
	}>((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("POST", apiUrl(target, `/api/spaces/${spaceId}/files`));
		for (const [key, value] of Object.entries(headers)) {
			xhr.setRequestHeader(key, value);
		}
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable && e.total > 0) {
				opts?.onProgress?.(e.loaded / e.total);
			}
		};
		xhr.onerror = () =>
			reject(new Error("Upload failed — the node is unreachable."));
		xhr.onabort = () => reject(new Error("Upload cancelled"));
		xhr.onload = () => {
			if (xhr.status < 200 || xhr.status >= 300) {
				let detail = `Upload failed (${xhr.status})`;
				try {
					const parsed = spaceUploadErrorSchema.parse(
						JSON.parse(xhr.responseText)
					);
					// `app_disabled` puts the actionable sentence in `message`; every
					// other Core error puts it in `error`.
					const said = parsed.message ?? parsed.error;
					if (said) {
						detail = String(said);
					}
				} catch {
					// Non-JSON body — keep the status line.
				}
				reject(new Error(detail));
				return;
			}
			try {
				resolve(spaceFileUploadWireSchema.parse(JSON.parse(xhr.responseText)));
			} catch {
				reject(
					new Error("The node answered the upload with something not JSON.")
				);
			}
		};
		opts?.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
		xhr.send(body);
	});
	return {
		documentId: wire.id,
		mime: wire.mime || file.type || "application/octet-stream",
		byteSize: wire.byte_size ?? file.size,
		index: toFileIndex(wire.index),
	};
}

/** Download a Space file with the same node-token and verified-user identity as
 * every JSON API call. The response is deliberately a Blob: active HTML/SVG is
 * never inserted into the app DOM, and viewers opt into only known safe formats. */
export async function fetchSpaceFileBlob(
	target: ApiTarget,
	spaceId: string,
	documentId: string,
	signal?: AbortSignal
): Promise<Blob> {
	const path = `/api/spaces/${spaceId}/documents/${documentId}/blob`;
	const response = await fetch(apiUrl(target, path), {
		headers: await requestHeaders(target),
		signal,
	});
	if (!response.ok) {
		throw new Error(`Could not open this file (${response.status}).`);
	}
	return response.blob();
}

/** Replace a Space file revision and trigger Core's content re-indexing. */
export async function replaceSpaceFileBlob(
	target: ApiTarget,
	spaceId: string,
	documentId: string,
	blob: Blob,
	mime: string
): Promise<UploadedSpaceFile> {
	if (blob.size > SPACE_UPLOAD_MAX_BYTES) {
		throw new Error(
			`This file is ${formatBytes(blob.size)} — the limit is ${formatBytes(SPACE_UPLOAD_MAX_BYTES)}.`
		);
	}
	const dataBase64 = await readAsBase64(blob, "the edited file");
	const wire = await request<{
		byte_size?: number;
		id: string;
		index?: FileIndexWire | null;
		mime?: string;
	}>(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}/blob`,
		{
			method: "PUT",
			body: { data_base64: dataBase64, mime },
		},
		responseCodec12
	);
	return {
		documentId: wire.id,
		mime: wire.mime || mime,
		byteSize: wire.byte_size ?? blob.size,
		index: toFileIndex(wire.index),
	};
}

/** Fetch a single document's full markdown source for editing. */
export async function fetchDocument(
	target: ApiTarget,
	spaceId: string,
	documentId: string
): Promise<SpaceDocumentContent> {
	const json = await request<DocumentContentWire>(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}`,
		undefined,
		documentContentWireResponseCodec
	);
	return toDocumentContent(json);
}

/**
 * Save a document's markdown source. Core re-chunks + re-embeds on save, so this
 * is the persistence + index trigger. Callers should debounce.
 */
export async function updateDocument(
	target: ApiTarget,
	spaceId: string,
	documentId: string,
	title: string,
	source: string,
	guard?: { expectedRevision: number; operationId: string }
): Promise<DocumentWriteReceipt> {
	const body: DocumentUpdateWireRequest = { title, source };
	if (guard) {
		body.expected_revision = guard.expectedRevision;
		body.operation_id = guard.operationId;
	}
	const json = await request<{ result?: DocumentWriteReceiptWire }>(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}`,
		{
			method: "PUT",
			body,
		},
		responseCodec13
	);
	return toDocumentWriteReceipt(json.result);
}

interface DocumentWriteReceiptWire {
	changed?: boolean;
	duplicate?: boolean;
	revision?: number;
	updated_at?: number;
	version_id?: string | null;
}

export interface DocumentWriteReceipt {
	changed: boolean;
	duplicate: boolean;
	revision: number;
	updatedAt: number;
	versionId: string | null;
}

function toDocumentWriteReceipt(
	value: DocumentWriteReceiptWire | undefined
): DocumentWriteReceipt {
	return {
		changed: value?.changed ?? false,
		duplicate: value?.duplicate ?? false,
		revision: value?.revision ?? 0,
		updatedAt: value?.updated_at ?? 0,
		versionId: value?.version_id ?? null,
	};
}

/** Delete a single document (page) and its chunks/vectors. */
export async function deleteDocument(
	target: ApiTarget,
	spaceId: string,
	documentId: string
): Promise<boolean> {
	const json = await request<{ removed?: boolean }>(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}`,
		{ method: "DELETE" },
		responseCodec14
	);
	return json?.removed ?? false;
}

// ── Document version history (server-backed) ────────────────────────────────

/** Metadata for one saved version of a document. */
export interface DocumentVersionMeta {
	captureType: string;
	/** Unix milliseconds. */
	createdAt: number;
	createdBy: string | null;
	documentId: string;
	granularity: string;
	id: string;
	kind: DocumentKind;
	label: string | null;
	revision: number;
	title: string;
	updatedAt: number;
}

interface DocumentVersionMetaWire {
	capture_type?: string;
	created_at: number;
	created_by?: string | null;
	document_id: string;
	granularity?: string;
	id: string;
	kind: DocumentKind;
	label?: string | null;
	revision?: number;
	title: string;
	updated_at?: number;
}

interface DocumentVersionWire extends DocumentVersionMetaWire {
	source: string;
}

function toDocumentVersionMeta(
	w: DocumentVersionMetaWire
): DocumentVersionMeta {
	return {
		captureType: w.capture_type ?? "manual",
		createdAt: w.created_at,
		createdBy: w.created_by ?? null,
		documentId: w.document_id,
		granularity: w.granularity ?? "exact",
		id: w.id,
		kind: w.kind,
		label: w.label ?? null,
		revision: w.revision ?? 0,
		title: w.title,
		updatedAt: w.updated_at ?? w.created_at,
	};
}

/** List a document's saved versions, newest first (metadata only). */
export async function listDocumentVersions(
	target: ApiTarget,
	spaceId: string,
	documentId: string
): Promise<DocumentVersionMeta[]> {
	const json = await request<DocumentVersionMetaWire[]>(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}/versions`,
		undefined,
		responseCodec15
	);
	return (json ?? []).map(toDocumentVersionMeta);
}

/** Fetch one version's captured markdown source. */
export async function getDocumentVersion(
	target: ApiTarget,
	spaceId: string,
	documentId: string,
	versionId: string
): Promise<string> {
	const json = await request<DocumentVersionWire>(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}/versions/${versionId}`,
		undefined,
		documentVersionWireResponseCodec
	);
	return json.source;
}

/** Snapshot the document's current content as a new version. */
export async function createDocumentVersion(
	target: ApiTarget,
	spaceId: string,
	documentId: string,
	label?: string
): Promise<void> {
	await request(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}/versions`,
		{ method: "POST", body: label ? { label } : {} },
		responseCodec16
	);
}

/** Restore a version as the document's current content (undoable server-side). */
export async function restoreDocumentVersion(
	target: ApiTarget,
	spaceId: string,
	documentId: string,
	versionId: string,
	guard?: { expectedRevision: number; operationId: string }
): Promise<DocumentWriteReceipt> {
	const json = await request<{ result?: DocumentWriteReceiptWire }>(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}/versions/${versionId}/restore`,
		{
			method: "POST",
			body: guard
				? {
						expected_revision: guard.expectedRevision,
						operation_id: guard.operationId,
					}
				: undefined,
		},
		responseCodec17
	);
	return toDocumentWriteReceipt(json.result);
}

/** Reindex progress reported by Core. */
export interface ReindexStatus {
	currentDims: number;
	currentModel: string;
	pendingChunks: number;
	running: boolean;
	totalChunks: number;
}

interface ReindexStatusWire {
	current_dims: number;
	current_model: string;
	pending_chunks: number;
	running: boolean;
	total_chunks: number;
}

/** Get the current embedding-reindex status (how many chunks are stale). */
export async function fetchReindexStatus(
	target: ApiTarget
): Promise<ReindexStatus> {
	const json = await request<ReindexStatusWire>(
		target,
		"/api/embeddings/reindex/status",
		undefined,
		reindexStatusWireResponseCodec
	);
	return {
		currentModel: json.current_model,
		currentDims: json.current_dims,
		totalChunks: json.total_chunks,
		pendingChunks: json.pending_chunks,
		running: json.running,
	};
}

/** Kick off a background reindex of all stale chunks. Returns immediately. */
export async function triggerReindex(target: ApiTarget): Promise<void> {
	await request(
		target,
		"/api/embeddings/reindex",
		{ method: "POST" },
		responseCodec18
	);
}

/** The embedding model Spaces currently uses. */
export interface EmbeddingModel {
	/** Not published by Core's native `GET /api/embeddings/model` today. */
	baseUrl?: string;
	dims: number;
	modelId: string;
}

// Core's native publisher (`EmbeddingModelInfo`) sends only model_id and dims;
// base_url stays optional so a publisher that adds it is still read.
interface EmbeddingModelWire {
	base_url?: string;
	dims: number;
	model_id: string;
}

/** Read the active embedding model. */
export async function fetchEmbeddingModel(
	target: ApiTarget
): Promise<EmbeddingModel> {
	const json = await request<EmbeddingModelWire>(
		target,
		"/api/embeddings/model",
		undefined,
		embeddingModelWireResponseCodec
	);
	return { modelId: json.model_id, baseUrl: json.base_url, dims: json.dims };
}

/**
 * Change the default embedding model. Core persists it and auto-triggers a
 * background reindex of every existing chunk (old vectors live in an
 * incomparable space and must be re-embedded).
 */
export async function setEmbeddingModel(
	target: ApiTarget,
	modelId: string,
	baseUrl?: string,
	dims?: number,
	provider?: string
): Promise<void> {
	const body: EmbeddingModelWireRequest = { model_id: modelId };
	if (baseUrl !== undefined) {
		body.base_url = baseUrl;
	}
	if (dims !== undefined) {
		body.dims = dims;
	}
	if (provider !== undefined) {
		body.provider = provider;
	}
	await request(
		target,
		"/api/embeddings/model",
		{ method: "POST", body },
		responseCodec19
	);
}

/**
 * Search a single Space, returning ranked chunk matches.
 *
 * This is the one call whose algorithm {@link Space.retrievalMode} selects: Core's
 * `search_ext` reads the column and branches to `vector_search` (nearest-neighbour
 * over the `vec0` index) or `graph_search` (entity match + BFS traversal), then
 * reranks. Calling this "a KNN search" — as this comment did — was simply wrong for
 * every graph Space, and it was the only doc a reader had for where the mode takes
 * effect.
 *
 * The metric is named "nearest-neighbour", not "cosine", on purpose: the Rust
 * comments say cosine KNN, but the table is declared `vec0(rowid INTEGER PRIMARY
 * KEY, embedding float[N])` with no `distance_metric=`, and nothing in the crate
 * normalizes the vectors. Rather than copy a metric name none of us has seen
 * assigned, this says only what the code shows — smaller is closer.
 *
 * **The graph branch is a *bounded* traversal, and the bounds are lossy.** Do not
 * describe it to a user as "follows the connections", full stop. `graph_search`
 * walks at most 3 hops and caps each hop's frontier at `MAX_FRONTIER_ENTITIES`
 * (512), because edges are co-occurrence — every pair of entities in a chunk is
 * joined — so an unbounded hop-2 frontier is most of the Space. The cap is not
 * merely a speed guard: Core's own doc states that a chunk whose only path runs
 * through a truncated frontier entity **stops being reachable**. It also stops as
 * soon as `limit` chunks are collected, so results depend on traversal order.
 *
 * Practical consequence for anything built on this: graph results are not a
 * superset of vector results and are not exhaustive. A caller must not present an
 * empty graph result as "this space contains nothing about X".
 */
export async function searchSpace(
	target: ApiTarget,
	spaceId: string,
	query: string,
	limit?: number
): Promise<SpaceMatch[]> {
	const body: SpaceSearchWireRequest = { query };
	if (limit !== undefined) {
		body.limit = limit;
	}
	const json = await request<{ matches?: MatchWire[] }>(
		target,
		`/api/spaces/${encodePathId(spaceId)}/search`,
		{ method: "POST", body },
		responseCodec20
	);
	return (json.matches ?? []).map(toMatch);
}

/** Run one read-only SQL query against the selected Space database document. */
export async function querySpaceDatabase(
	target: ApiTarget,
	spaceId: string,
	databaseId: string,
	query: string,
	parameters: SpaceDatabaseQueryValue[] = []
): Promise<SpaceDatabaseQueryResult> {
	const result = await request<unknown>(
		target,
		`/api/spaces/${encodeURIComponent(spaceId)}/databases/${encodeURIComponent(databaseId)}/query`,
		{ method: "POST", body: { query, parameters } },
		gatewayJsonValueSchema
	);
	const parsed = databaseQueryEnvelopeSchema.safeParse(result);
	if (!parsed.success) {
		throw new Error("Core returned an invalid database query response");
	}
	const schema = parsed.data.schema.map((candidate) => {
		const column = databaseQueryColumnSchema.safeParse(candidate);
		if (!column.success) {
			throw new Error("Core returned an invalid database query schema");
		}
		return column.data;
	});
	const validated = spaceDatabaseQueryResultSchema.safeParse(result);
	if (!validated.success) {
		throw new Error("Core returned an invalid database query response");
	}
	return {
		columns: validated.data.columns.slice(),
		rows: validated.data.rows.map((row) => row.slice()),
		schema,
		truncated: validated.data.truncated,
	};
}

// ── Wiki page-links: backlinks + graph ──────────────────────────────────────────

/** A wiki/mention link between two documents. */
export interface SpaceDocLink {
	/** `null` when the target page does not exist yet (a pending link). */
	dstDocId: string | null;
	dstTitle: string;
	/** `'wiki'` (`[[Title]]`) or `'mention'` (`@Title`). */
	kind: string;
	/** Populated for backlinks: a context snippet around the link. */
	snippet?: string;
	srcDocId: string;
	/** Populated for backlinks: the linking document's title. */
	srcTitle?: string;
}

interface DocLinkWire {
	dst_doc_id: string | null;
	dst_title: string;
	kind: string;
	snippet?: string;
	src_doc_id: string;
	src_title?: string;
}

function toDocLink(l: DocLinkWire): SpaceDocLink {
	return {
		srcDocId: l.src_doc_id,
		dstDocId: l.dst_doc_id,
		dstTitle: l.dst_title,
		kind: l.kind,
		srcTitle: l.src_title,
		snippet: l.snippet,
	};
}

/** A node in the document-link graph (a document, or a pending link target). */
export interface DocGraphNode {
	id: string;
	/** `'page'`, `'database'`, or `'pending'`. */
	kind: string;
	pending: boolean;
	spaceId: string;
	title: string;
}

/** An edge in the document-link graph. */
export interface DocGraphEdge {
	dst: string;
	/** `'wiki'`, `'mention'`, or `'parent'`. */
	kind: string;
	src: string;
}

/** The document-link graph (per-space or global). */
export interface DocGraph {
	edges: DocGraphEdge[];
	nodes: DocGraphNode[];
}

interface DocGraphWire {
	edges: DocGraphEdge[];
	nodes: {
		id: string;
		kind: string;
		pending: boolean;
		space_id: string;
		title: string;
	}[];
}

function toDocGraph(g: DocGraphWire): DocGraph {
	return {
		nodes: g.nodes.map((n) => ({
			id: n.id,
			title: n.title,
			kind: n.kind,
			spaceId: n.space_id,
			pending: n.pending,
		})),
		edges: g.edges,
	};
}

/** Documents that link to `documentId` (Obsidian/Notion "linked references"). */
export async function fetchBacklinks(
	target: ApiTarget,
	spaceId: string,
	documentId: string
): Promise<SpaceDocLink[]> {
	const json = await request<{ backlinks?: DocLinkWire[] }>(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}/backlinks`,
		undefined,
		responseCodec21
	);
	return (json.backlinks ?? []).map(toDocLink);
}

/** Outgoing links from `documentId` (resolved refs + pending titles). */
export async function fetchDocumentLinks(
	target: ApiTarget,
	spaceId: string,
	documentId: string
): Promise<SpaceDocLink[]> {
	const json = await request<{ links?: DocLinkWire[] }>(
		target,
		`/api/spaces/${spaceId}/documents/${documentId}/links`,
		undefined,
		responseCodec22
	);
	return (json.links ?? []).map(toDocLink);
}

/** The document-link graph for one Space. */
export async function fetchSpaceGraph(
	target: ApiTarget,
	spaceId: string
): Promise<DocGraph> {
	const json = await request<DocGraphWire>(
		target,
		`/api/spaces/${spaceId}/graph`,
		undefined,
		docGraphWireResponseCodec
	);
	return toDocGraph(json);
}

/** The global document-link graph across every Space. */
export async function fetchGlobalGraph(target: ApiTarget): Promise<DocGraph> {
	const json = await request<DocGraphWire>(
		target,
		"/api/graph",
		undefined,
		docGraphWireResponseCodec
	);
	return toDocGraph(json);
}

interface CreateSpaceWireRequest {
	description: string | null;
	name: string;
	retrieval_mode?: RetrievalMode;
	visibility?: ResourceVisibility;
}

interface SpaceVisibilityWireRequest {
	team_id?: string;
	visibility: ResourceVisibility;
}

interface DocumentUpdateWireRequest {
	expected_revision?: number;
	operation_id?: string;
	source: string;
	title: string;
}

interface EmbeddingModelWireRequest {
	base_url?: string;
	dims?: number;
	model_id: string;
	provider?: string;
}

interface SpaceSearchWireRequest {
	limit?: number;
	query: string;
}

// Response codecs validate the consumed native DTO fields and retain JSON extension fields.
const responseCodec1 = z
	.object({ id: z.string(), retrieval_mode: z.string().optional() })
	.catchall(gatewayJsonValueSchema);
const responseCodec2 = gatewayJsonValueSchema
	.optional()
	.transform(() => undefined);
const responseCodec3 = gatewayJsonValueSchema
	.optional()
	.transform(() => undefined);
const responseCodec4 = z
	.object({ removed: z.boolean().optional() })
	.catchall(gatewayJsonValueSchema);
const responseCodec5 = gatewayJsonValueSchema
	.optional()
	.transform(() => undefined);
const responseCodec6 = gatewayJsonValueSchema
	.optional()
	.transform(() => undefined);
const spaceLexicalHitWireResponseCodec = z
	.object({
		created_at: z.number(),
		document_id: z.string(),
		snippet: z.string(),
		space_id: z.string(),
		space_name: z.string(),
		title: z.string(),
		updated_at: z.number(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec7 = z
	.object({ hits: z.array(spaceLexicalHitWireResponseCodec).optional() })
	.catchall(gatewayJsonValueSchema);
const responseCodec8 = z
	.object({ document_id: z.string() })
	.catchall(gatewayJsonValueSchema);
const responseCodec9 = z
	.object({ id: z.string() })
	.catchall(gatewayJsonValueSchema);
const responseCodec10 = z
	.object({ id: z.string() })
	.catchall(gatewayJsonValueSchema);
const responseCodec11 = z
	.object({ id: z.string() })
	.catchall(gatewayJsonValueSchema);
const fileIndexWireResponseCodec = z
	.object({
		message: z.union([z.string(), z.null()]).optional(),
		state: z.union([z.string(), z.null()]).optional(),
		warnings: z.union([z.array(z.string()), z.null()]).optional(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec12 = z
	.object({
		byte_size: z.number().optional(),
		id: z.string(),
		index: z.union([fileIndexWireResponseCodec, z.null()]).optional(),
		mime: z.string().optional(),
	})
	.catchall(gatewayJsonValueSchema);
const documentWriteReceiptWireResponseCodec = z
	.object({
		changed: z.boolean().optional(),
		duplicate: z.boolean().optional(),
		revision: z.number().optional(),
		updated_at: z.number().optional(),
		version_id: z.union([z.string(), z.null()]).optional(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec13 = z
	.object({ result: documentWriteReceiptWireResponseCodec.optional() })
	.catchall(gatewayJsonValueSchema);
const responseCodec14 = z
	.object({ removed: z.boolean().optional() })
	.catchall(gatewayJsonValueSchema);
const documentKindResponseCodec = z.union([
	z.literal("page"),
	z.literal("database"),
	z.literal("whiteboard"),
]);
const documentVersionMetaWireResponseCodec = z
	.object({
		capture_type: z.string().optional(),
		created_at: z.number(),
		created_by: z.union([z.string(), z.null()]).optional(),
		document_id: z.string(),
		granularity: z.string().optional(),
		id: z.string(),
		kind: documentKindResponseCodec,
		label: z.union([z.string(), z.null()]).optional(),
		revision: z.number().optional(),
		title: z.string(),
		updated_at: z.number().optional(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec15 = z.array(documentVersionMetaWireResponseCodec);
const documentVersionWireResponseCodec = z.intersection(
	documentVersionMetaWireResponseCodec,
	z.object({ source: z.string() }).catchall(gatewayJsonValueSchema)
);
const responseCodec16 = gatewayJsonValueSchema
	.optional()
	.transform(() => undefined);
const responseCodec17 = z
	.object({ result: documentWriteReceiptWireResponseCodec.optional() })
	.catchall(gatewayJsonValueSchema);
const reindexStatusWireResponseCodec = z
	.object({
		current_dims: z.number(),
		current_model: z.string(),
		pending_chunks: z.number(),
		running: z.boolean(),
		total_chunks: z.number(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec18 = gatewayJsonValueSchema
	.optional()
	.transform(() => undefined);
const embeddingModelWireResponseCodec = z
	.object({
		base_url: z.string().optional(),
		dims: z.number(),
		model_id: z.string(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec19 = gatewayJsonValueSchema
	.optional()
	.transform(() => undefined);
const matchWireResponseCodec = z
	.object({
		chunk_id: z.string(),
		content: z.string(),
		distance: z.number(),
		document_id: z.string(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec20 = z
	.object({ matches: z.array(matchWireResponseCodec).optional() })
	.catchall(gatewayJsonValueSchema);
const docLinkWireResponseCodec = z
	.object({
		dst_doc_id: z.union([z.string(), z.null()]),
		dst_title: z.string(),
		kind: z.string(),
		snippet: z.string().optional(),
		src_doc_id: z.string(),
		src_title: z.string().optional(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec21 = z
	.object({ backlinks: z.array(docLinkWireResponseCodec).optional() })
	.catchall(gatewayJsonValueSchema);
const responseCodec22 = z
	.object({ links: z.array(docLinkWireResponseCodec).optional() })
	.catchall(gatewayJsonValueSchema);
const docGraphEdgeResponseCodec = z
	.object({ dst: z.string(), kind: z.string(), src: z.string() })
	.catchall(gatewayJsonValueSchema);
const docGraphWireResponseCodec = z
	.object({
		edges: z.array(docGraphEdgeResponseCodec),
		nodes: z.array(
			z
				.object({
					id: z.string(),
					kind: z.string(),
					pending: z.boolean(),
					space_id: z.string(),
					title: z.string(),
				})
				.catchall(gatewayJsonValueSchema)
		),
	})
	.catchall(gatewayJsonValueSchema);

const glyphValueResponseCodec = gatewayJsonValueSchema.transform(asGlyphValue);
const spaceWireResponseCodec = z
	.object({
		created_at: z.number(),
		description: z.string().nullable().optional(),
		document_count: z.number(),
		icon: glyphValueResponseCodec.optional(),
		id: z.string(),
		name: z.string(),
		retrieval_mode: z.string().optional(),
		system: z.boolean().optional(),
		team_id: z.string().nullable().optional(),
		updated_at: z.number(),
		visibility: z.string().optional(),
	})
	.catchall(gatewayJsonValueSchema);
const listSpacesResponseCodec = z
	.object({ spaces: z.array(spaceWireResponseCodec).optional() })
	.catchall(gatewayJsonValueSchema);
const documentWireResponseCodec = z
	.object({
		byte_size: z.number().nullable().optional(),
		chunk_count: z.number(),
		created_at: z.number(),
		icon: glyphValueResponseCodec.optional(),
		id: z.string(),
		index: fileIndexWireResponseCodec.nullable().optional(),
		kind: z.string().optional(),
		mime: z.string().nullable().optional(),
		space_id: z.string(),
		title: z.string(),
		updated_at: z.number().optional(),
	})
	.catchall(gatewayJsonValueSchema);
const listDocumentsResponseCodec = z
	.object({ documents: z.array(documentWireResponseCodec).optional() })
	.catchall(gatewayJsonValueSchema);

const documentContentWireResponseCodec = z
	.object({
		chunk_count: z.number(),
		created_at: z.number(),
		icon: glyphValueResponseCodec.optional(),
		id: z.string(),
		kind: z.string().optional(),
		source: z.string(),
		space_id: z.string(),
		title: z.string(),
		updated_at: z.number(),
	})
	.catchall(gatewayJsonValueSchema);
