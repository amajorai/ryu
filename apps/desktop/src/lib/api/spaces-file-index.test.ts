import { describe, expect, it } from "bun:test";
import { rustModuleSource } from "./rust-module-source.ts";
import {
	FILE_DOCUMENT_KIND,
	isFileDocument,
	NOT_CONTENT_SEARCHABLE_STATES,
	type SpaceFileIndexState,
	toFileIndexState,
} from "./spaces.ts";
import {
	ANCHOR_PRESENT,
	CORE_SPACE_FILE_INDEX_RS,
	rustAnchor,
	rustContains,
	rustItemBody,
	rustSource,
	SERVER_RS,
	SPACES_RS,
	SPACES_TS,
	serverRs,
	spaceFileIndexRs,
	spacesRs,
	squeeze,
} from "./spaces-test-anchors.ts";

// ── The two client docs that describe things OUTSIDE this file ───────────────
//
// `RetrievalModeChange.changed` and the `searchSpace` block both explain state a
// reader cannot see from the type alone, and both were wrong at some point in
// exactly the way this file exists to catch:
//
//  - `searchSpace` called the route "a KNN search" for the whole life of graph
//    mode. The header comment at the top of `spaces.ts` then kept saying it for a
//    round after the function's own doc was fixed.
//  - `changed` documents a repair path — re-asserting `graph` on a graph Space to
//    rebuild a dropped graph — that `SpacesPage.tsx` deliberately refuses to
//    issue, returning early when the picked mode equals the current one. The doc
//    now says so. If that guard is ever removed the doc becomes false in the
//    other direction, so the guard is pinned here rather than described.

describe("what the client docs claim about code they do not contain", () => {
	const spacesTs = rustSource("apps/desktop/src/lib/api/spaces.ts");

	it("never calls a Space search a KNN search, header included", () => {
		// Scoped to the two historic sentences rather than the word "KNN", which
		// legitimately names the vector branch inside the corrected prose.
		expect(spacesTs).not.toContain("searched via KNN");
		expect(spacesTs).not.toContain("Run a KNN similarity search");
	});

	it("still has the early return that makes changed:false API-only", () => {
		// The doc on `changed` tells a reader the repair is reachable through the
		// endpoint but not through this UI, and says why (an uncancellable rebuild
		// holding the one SQLite connection). Delete the guard and that becomes a
		// false statement — plus a stray click on the already-selected mode becomes
		// a node-wide stall.
		const page = rustSource("apps/desktop/src/pages/SpacesPage.tsx");
		expect(page).toContain("selected.retrievalMode === mode");
		expect(spacesTs).toContain("API-only");
	});

	it("still describes graph-mode distances as placeholders Core really writes", () => {
		// `SpaceMatch.distance` warns that graph hits and link-expanded chunks carry
		// constants, so array order is the ranking. Both constants are single
		// assignment sites in Core; if either starts carrying a real score the
		// warning over-claims.
		const spacesRs = rustSource(SPACES_RS);
		expect(spacesRs).toContain(
			"// Synthetic distance: 0.0 = direct entity hit."
		);
		expect(spacesRs).toContain(
			"// Synthetic: link-reached chunks re-scored by the reranker."
		);
		expect(spacesTs).not.toContain(
			"/** Squared L2 distance from the query vector (smaller is closer). */"
		);
	});

	it("still reranks by reordering rather than by rewriting distance", () => {
		// The other half of that doc: it tells callers array order, not `distance`,
		// is the ranking. True only while `apply_reranking` binds the cross-encoder
		// score to `_score`, discards it, and pushes the chunk through as a clone.
		// Asserted positively — a `not.toContain("distance =")` would miss the
		// realistic mutation, which is a struct literal carrying `distance: score`.
		const body = rustItemBody(
			rustSource(SPACES_RS),
			SPACES_RS,
			"async fn apply_reranking("
		);
		expect(body).toContain(
			"for (idx, _score) in ranked.into_iter().take(limit)"
		);
		expect(body).toContain("reordered.push(chunk.clone());");
	});
});

describe("file index state mirrors Core's document.parse status", () => {
	it("uses exactly the four spellings IndexState::as_str emits, plus unattempted", () => {
		// `as_str` is the ONE definition of the stored wire strings, and its own doc
		// says "The stable wire string. Clients branch on this." `unattempted` is not
		// a stored variant — it is synthesised by `unknown_json` for a document with
		// no status row — so it is asserted separately rather than expected here.
		const asStr = rustItemBody(
			spaceFileIndexRs,
			CORE_SPACE_FILE_INDEX_RS,
			"pub const fn as_str(self)"
		);
		const stored = [...asStr.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
		expect(stored).toEqual(["failed", "indexed", "pending", "skipped"]);
		expect(
			rustContains(
				spaceFileIndexRs,
				CORE_SPACE_FILE_INDEX_RS,
				"pub fn unknown_json(",
				'"state": "unattempted"'
			)
		).toBe(ANCHOR_PRESENT);
		// Every one of the five round-trips through the client's coercion.
		for (const state of [
			"failed",
			"indexed",
			"pending",
			"skipped",
			"unattempted",
		] satisfies SpaceFileIndexState[]) {
			expect(toFileIndexState(state)).toBe(state);
		}
	});

	it("says NOTHING rather than 'not searchable' for an unknown or absent state", () => {
		// The load-bearing default. A sixth state added in Core must make this UI go
		// quiet, not make it accuse an indexed file. Same for the field being absent,
		// which is every row today.
		expect(toFileIndexState(undefined)).toBeNull();
		expect(toFileIndexState(null)).toBeNull();
		expect(toFileIndexState("")).toBeNull();
		expect(toFileIndexState("Indexed")).toBeNull();
		expect(toFileIndexState("extracted")).toBeNull();
	});

	it("treats pending as on-its-way, not as not-searchable", () => {
		// Telling a user their file is unsearchable while a reader is mid-parse would
		// be wrong within seconds, and `pending` is written BEFORE the parse starts —
		// Core's comment: "so a client that reads immediately after upload sees
		// 'running', not an absent row it would have to guess about."
		expect(NOT_CONTENT_SEARCHABLE_STATES).toEqual([
			"failed",
			"skipped",
			"unattempted",
		]);
		expect(NOT_CONTENT_SEARCHABLE_STATES).not.toContain("pending");
		expect(NOT_CONTENT_SEARCHABLE_STATES).not.toContain("indexed");
	});

	it("reads the key Core actually serializes the record under", () => {
		// `index` is taken from the CREATE response, which is the only response that
		// carries the record today. Re-spelled there, the client's list reader must
		// be re-pointed too — `toDocument` is its only reader.
		expect(
			rustAnchor(
				serverRs,
				SERVER_RS,
				"async fn create_file(",
				'"index": created.index.to_json(),'
			)
		).toBe(ANCHOR_PRESENT);
		expect(
			rustAnchor(
				spaceFileIndexRs,
				CORE_SPACE_FILE_INDEX_RS,
				"pub fn to_json(&self)",
				'"state": self.state.as_str(),'
			)
		).toBe(ANCHOR_PRESENT);
	});

	it("only renders `message`, which Core promises is never the contents", () => {
		// A `failed` row shows this string to the user. Core's field doc is what
		// makes that safe; if the guarantee goes, so must the rendering.
		expect(spaceFileIndexRs).toContain(
			"/// Human-readable detail. Never the document's contents."
		);
	});
});

describe("the client does not guess a file's index state", () => {
	it("no longer derives 'not searchable' from the file kind", () => {
		// THE regression this block was rewritten for. `create_file_indexed` awaits
		// the shared stored-file indexer, which runs the builtin floor inline, so a
		// `.txt`/`.md`/`.csv` is `indexed` by the time
		// the upload response is written and a kind-based rule would be wrong about
		// it. `isFileDocument` survives (routing and icons still need it) but must
		// not be the source of a searchability claim.
		expect(
			rustAnchor(
				spaceFileIndexRs,
				CORE_SPACE_FILE_INDEX_RS,
				"async fn index_stored_file(",
				"if document_parse::is_builtin_readable(title) {"
			)
		).toBe(ANCHOR_PRESENT);
		const spacesTs = rustSource(SPACES_TS);
		expect(spacesTs).not.toContain("isFileDocument(doc) ? false");
		expect(isFileDocument({ rawKind: FILE_DOCUMENT_KIND })).toBe(true);
		expect(isFileDocument({ rawKind: "page" })).toBe(false);
	});

	it("no longer derives it from the chunk count either", () => {
		// `chunkCount === 1` held for every file before extraction and is a
		// coincidence after it (a short extracted document also yields one chunk), so
		// it would degrade into a silent lie rather than a failing test.
		const spacesTs = rustSource(SPACES_TS);
		const map = rustItemBody(spacesTs, SPACES_TS, "function toDocument(");
		expect(map).toContain("withFileIndex(toFileIndex(d.index))");
		expect(map).not.toContain("chunkCount ===");
		// One reader for both sources: the (future) inline list field and the
		// per-document status route must not be able to fill these three fields
		// differently, which is what `withFileIndex` exists to prevent.
		const coerce = rustItemBody(spacesTs, SPACES_TS, "function toFileIndex(");
		expect(coerce).toContain("toFileIndexState(w?.state)");
	});

	it("every upload path goes through the one indexed-create seam", () => {
		// Two wired and one not is the state a later reader cannot tell apart from
		// "this file type just isn't extractable" — Core's own words. If a fourth
		// caller appears that skips it, its files get no status row and read as
		// `unattempted` forever, which the UI would then report as fact.
		expect(serverRs).toContain("crate::space_file_index::create_file_indexed(");
		expect(rustModuleSource("apps/core/src/server/uploads")).toContain(
			"crate::space_file_index::create_file_indexed("
		);
		expect(rustSource("apps/core/src/sidecar/mcp/artifact_tool.rs")).toContain(
			"crate::space_file_index::create_file_indexed_detached("
		);
	});
});

describe("the list route carries index state, so the client asks once", () => {
	// This block replaces "the gap this client cannot close from its own side",
	// which asserted the opposite. The gap is closed: Core joins its per-document
	// extraction record onto the list rows. What has to be pinned now is the shape
	// of that join and the two rules that keep it honest.

	it("still keeps the state OUT of the spaces crate's own schema", () => {
		// The join is Core-side because `ryu-spaces` has zero dependency on
		// `apps/core` and must keep none — teaching its `documents` table a
		// parser-provenance vocabulary would invert that layering. So `Document`
		// gains no column and `list_documents` gains no join; Core decorates the
		// serialized rows afterwards.
		const doc = rustItemBody(spacesRs, SPACES_RS, "pub struct Document {");
		expect(doc).not.toContain("index");
		const list = rustItemBody(
			spacesRs,
			SPACES_RS,
			"pub async fn list_documents("
		);
		expect(list).not.toContain("index_state");
	});

	it("joins the record onto the LIST response in one pass", () => {
		// One store read for the whole list. The client used to fan out one HTTP
		// request per file row (batched eight at a time) against a Space — Uploads —
		// whose length is bounded by nothing.
		expect(
			rustAnchor(
				serverRs,
				SERVER_RS,
				"async fn list_documents(",
				"crate::space_file_index::attach_index_states(&mut rows).await;"
			)
		).toBe(ANCHOR_PRESENT);
		// Bulk, not N calls to `get`.
		expect(spaceFileIndexRs).toContain("pub async fn get_many(");
		expect(
			rustAnchor(
				spaceFileIndexRs,
				CORE_SPACE_FILE_INDEX_RS,
				"pub async fn attach_index_states(",
				"store.get_many(&file_ids).await"
			)
		).toBe(ANCHOR_PRESENT);
	});

	it("answers every file row and stays silent about every other kind", () => {
		// The two rules the desktop reader depends on. A page/database/whiteboard is
		// re-chunked from its own source on every save, so `index` must be ABSENT for
		// it — stamping `unattempted` there would badge every page "Name only". A
		// file with no status row must still get `unknown_json`, because "nobody
		// looked" is a real answer and a dropped key is not.
		const merge = rustItemBody(
			spaceFileIndexRs,
			CORE_SPACE_FILE_INDEX_RS,
			"pub fn merge_index_into_documents("
		);
		expect(merge).toContain("Some(FILE_DOCUMENT_KIND)");
		expect(merge).toContain("unknown_json(&doc_id)");
	});

	it("uses the SAME key and object the create responses already send", () => {
		// One wire shape for three routes, so `toFileIndex` is the only reader the
		// client needs. `LIST_INDEX_KEY` is that key, spelled once in Core.
		expect(spaceFileIndexRs).toContain(
			'pub const LIST_INDEX_KEY: &str = "index";'
		);
		expect(
			rustAnchor(
				serverRs,
				SERVER_RS,
				"async fn create_file(",
				'"index": created.index.to_json(),'
			)
		).toBe(ANCHOR_PRESENT);
	});

	it("has no per-document fan-out left in the client", () => {
		// Two writers for the same three document fields is how they drift apart.
		// The per-document route stays mounted in Core (it is a documented
		// single-document read) but this app no longer calls it.
		const spacesTs = rustSource(SPACES_TS);
		expect(spacesTs).not.toContain(
			"export async function fetchDocumentIndexStatus"
		);
		const page = rustSource("apps/desktop/src/pages/SpacesPage.tsx");
		expect(page).not.toContain("fetchDocumentIndexStatus");
		expect(page).not.toContain("INDEX_STATUS_BATCH");
		const routes = rustItemBody(serverRs, SERVER_RS, "fn spaces_routes(");
		expect(squeeze(routes)).toContain(
			squeeze(
				'"/api/spaces/:id/documents/:doc_id/index", get(get_document_index_status),'
			)
		);
	});
});
