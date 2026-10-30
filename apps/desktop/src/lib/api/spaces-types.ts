import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import type { ResourceVisibility } from "@/src/lib/resource-visibility.ts";

// apps/desktop/src/lib/api/spaces-types.ts
//
// Client-side Spaces domain types and their lenient wire coercions. Split out of `spaces.ts`, which re-exports
// everything public here so its import path stays stable.

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

export function toDocumentKind(kind?: string): DocumentKind {
	if (kind === "database") {
		return "database";
	}
	if (kind === "whiteboard") {
		return "whiteboard";
	}
	return "page";
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
