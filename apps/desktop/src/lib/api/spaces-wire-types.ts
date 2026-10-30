import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import type { ResourceVisibility } from "@/src/lib/resource-visibility.ts";
import type { RetrievalMode } from "./spaces-types.ts";

// apps/desktop/src/lib/api/spaces-wire-types.ts
//
// snake_case wire shapes and request bodies for the Spaces client. Split out of `spaces.ts`, which re-exports
// everything public here so its import path stays stable.

export interface SpaceWire {
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
export interface DocumentWire {
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

export interface SpaceLexicalHitWire {
	created_at: number;
	document_id: string;
	snippet: string;
	space_id: string;
	space_name: string;
	title: string;
	updated_at: number;
}

export interface MatchWire {
	chunk_id: string;
	content: string;
	distance: number;
	document_id: string;
}

export interface FileIndexWire {
	message?: string | null;
	state?: string | null;
	warnings?: string[] | null;
}

export interface CreateSpaceWireRequest {
	description: string | null;
	name: string;
	retrieval_mode?: RetrievalMode;
	visibility?: ResourceVisibility;
}

export interface SpaceVisibilityWireRequest {
	team_id?: string;
	visibility: ResourceVisibility;
}

export interface DocumentUpdateWireRequest {
	expected_revision?: number;
	operation_id?: string;
	source: string;
	title: string;
}

export interface EmbeddingModelWireRequest {
	base_url?: string;
	dims?: number;
	model_id: string;
	provider?: string;
}

export interface SpaceSearchWireRequest {
	limit?: number;
	query: string;
}
