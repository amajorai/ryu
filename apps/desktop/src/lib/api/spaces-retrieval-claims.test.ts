import { describe, expect, it } from "bun:test";
import { describeRetrievalModeChange, toRetrievalMode } from "./spaces.ts";
import {
	ANCHOR_PRESENT,
	change,
	RAG_HOST_RS,
	RAG_RS,
	ragRs,
	rustAnchor,
	rustItemBody,
	rustSource,
	SERVER_RS,
	SPACES_RETRIEVAL_RS,
	SPACES_RS,
	serverRs,
	spacesRs,
	squeeze,
	tl,
} from "./spaces-test-anchors.ts";

// ── `system`: the flag the sidebar greys "Delete space" out on ───────────────
//
// The Spaces sidebar disables its Delete item for `space.system` and explains
// why in a tooltip (`SpaceSidebarRow`, apps/desktop/src/components/layout/
// sidebar-space-row.tsx). That is a claim about Core, and an unusually load-bearing
// one: get it wrong in the "false" direction and the user gets the action back
// plus the failure toast it always produced; get it wrong in the "true"
// direction and a perfectly deletable Space becomes undeletable from the UI.
//
// Two Rust facts hold the claim up, and they live in different crates:
//
//   1. `spaces::Space` still SERIALIZES `system` on every listed Space — with
//      `#[serde(default)]`, which is what lets the client treat an absent field
//      as `false` against an older node instead of greying out everything.
//   2. `SpaceStore::delete_space` still REFUSES a system Space. The moment that
//      bail goes away the disable is a lie and should be deleted with it.
//
// Note the org-bound path is deliberately NOT pinned here: on a bound node the
// `require_resource_write` gate in `delete_space` (server/mod.rs) 403s an
// owner-less system row before the store is ever reached, so the two paths fail
// differently. The client reads the flag precisely so it does not have to
// predict which of the two it would have hit.
describe("the system-Space flag the delete action is gated on", () => {
	it("is still serialized on every listed Space, with serde(default)", () => {
		const spaceStruct = rustItemBody(spacesRs, SPACES_RS, "pub struct Space {");
		expect(spaceStruct).toContain("pub system: bool");
		// The attribute sits immediately above the field; `default` is what the
		// client's `s.system ?? false` older-Core tolerance rests on, and a
		// `skip_serializing_if` would make a system Space indistinguishable from a
		// user one on the wire.
		const beforeField = spaceStruct.slice(
			0,
			spaceStruct.indexOf("pub system: bool")
		);
		const attrs = beforeField.split("///").at(-1) ?? "";
		expect(attrs).toContain("serde(default)");
		expect(attrs).not.toContain("skip_serializing_if");
	});

	it("is still listed off the spaces table, so the wire value is the column", () => {
		expect(
			rustAnchor(
				spacesRs,
				SPACES_RS,
				"pub async fn list_spaces(",
				"s.retrieval_mode, s.system, s.icon"
			)
		).toBe(ANCHOR_PRESENT);
	});

	it("still makes Core REFUSE to delete a system Space", () => {
		// Without this bail the disabled item is inventing a restriction. With it,
		// an ENABLED item could only ever produce the "Couldn't delete this space"
		// toast — which is the bug the disable exists to remove.
		const del = rustItemBody(
			spacesRs,
			SPACES_RS,
			"pub async fn delete_space(&self, space_id: &str)"
		);
		expect(squeeze(del)).toContain("if is_system == Some(1)");
		expect(del).toContain("is a system space and cannot be deleted");
	});
});

// ── The SCOPE of the mode, pinned in both directions ─────────────────────────
//
// The UI copy (`RETRIEVAL_MODE_SCOPE` in packages/blocks/src/desktop/spaces.tsx,
// and the `Space.retrievalMode` doc in spaces.ts) makes a claim about Core that
// no type checks. It has now been wrong in BOTH directions, which is why the
// anchors below are two-sided:
//
//  1. OVERclaim (shipped): the card said the setting decided "how this space finds
//     answers when an agent searches it", while an agent's automatic recall on a
//     chat turn went through a code path that had never heard of the column.
//  2. UNDERclaim (caught here, by this file's own negative anchor): the copy was
//     narrowed to "direct search only" — and then Core grew
//     `ryu_rag::SpaceRecall`, a delegate that answers `RetrievalOptions::space_ids`
//     out of `SpaceStore::search_ext`, which is precisely the function that reads
//     the column. The chat turn started honouring the mode, and copy telling the
//     user it does not is as wrong as the copy that overpromised.
//
// So the anchors pin the CHAIN, not one endpoint: the column is read in exactly
// one place (`search_ext`), and both the direct-search route and the chat-turn
// recall path must be shown to reach it. If either link goes, the picker is again
// a control that writes a field somebody's path ignores.
describe("what the retrieval mode is claimed to govern", () => {
	it("is still read in exactly one place — collect_candidates", () => {
		// `search_ext` is `search_with` with default options, and every Space
		// search (`search_ext`, `search_with`, `search_multi`) gathers its
		// candidates in `collect_candidates` → `space_mode()`, the single branch
		// point between `vector_search` and `graph_search`. Every claim below is a
		// claim that some caller reaches THIS function; if the read moves, they all
		// need re-pointing.
		expect(
			rustAnchor(
				rustSource(SPACES_RETRIEVAL_RS),
				SPACES_RETRIEVAL_RS,
				"async fn collect_candidates(",
				"let mode = self.space_mode(space_id).await?;"
			)
		).toBe(ANCHOR_PRESENT);
		expect(
			rustAnchor(
				spacesRs,
				SPACES_RS,
				"pub async fn search_ext(",
				"self.search_with(space_id, query, &opts, filter)"
			)
		).toBe(ANCHOR_PRESENT);
	});

	it("still reaches the Space search pipeline from the route the client posts to", () => {
		expect(
			rustAnchor(
				serverRs,
				SERVER_RS,
				"async fn search_space(",
				".search_multi("
			)
		).toBe(ANCHOR_PRESENT);
	});

	it("also reaches the Space search pipeline from the chat-turn recall path", () => {
		// The chain the copy now promises, one link at a time. `retrieve` is what
		// `sidecar/adapters` calls to build a turn's context from memory + the
		// agent's Spaces; it delegates the Spaces half rather than scanning
		// `retrieval.db` for them (a Space's documents are never indexed there).
		// The `pub` in the header is deliberate: this file also declares a trait
		// method and a trait impl with the same name, and anchoring the wrong one
		// would pass while proving nothing.
		const retrieve = rustItemBody(
			ragRs,
			RAG_RS,
			"pub async fn retrieve(&self, query: &str, opts: &RetrievalOptions)"
		);
		// Positive control: local retrieval still performs cosine ranking after the
		// local and Spaces branches were split into concurrent work.
		const localRetrieve = rustItemBody(
			ragRs,
			RAG_RS,
			"async fn retrieve_local("
		);
		expect(squeeze(localRetrieve)).toContain(
			"score_candidates(&query_embedding, opts)"
		);
		const scoreCandidates = rustItemBody(
			ragRs,
			RAG_RS,
			"async fn score_candidates("
		);
		// The scan runs on a blocking `CandidateScorer`, which ranks by cosine.
		expect(squeeze(scoreCandidates)).toContain(
			"scorer.score(&conn, &model, &query, &opts)"
		);
		expect(
			squeeze(rustItemBody(ragRs, RAG_RS, "impl CandidateScorer"))
		).toContain("cosine_similarity(query, &vector)");
		expect(retrieve).toContain("self.retrieve_local(query, opts)");
		expect(retrieve).toContain("self.recall_spaces(query, opts)");

		// …which calls the delegate…
		expect(
			rustAnchor(
				ragRs,
				RAG_RS,
				"async fn recall_spaces(",
				"delegate.recall(query, opts, opts.top_k)"
			)
		).toBe(ANCHOR_PRESENT);

		// …whose ONE production implementation calls `search_with`, closing the chain
		// back onto the column read pinned above.
		const ragHostRs = rustSource(RAG_HOST_RS);
		expect(
			rustAnchor(
				ragHostRs,
				RAG_HOST_RS,
				"impl SpaceRecall for SpacesRecall",
				".search_with(&space_id, query, &search_options, filter.clone())"
			)
		).toBe(ANCHOR_PRESENT);
	});

	it("keeps ONE term graph, in the Spaces store, not a copy in the RAG crate", () => {
		// The invariant that survives the delegation, and the reason delegation was
		// chosen over mirroring: two entity graphs that can disagree would be a worse
		// defect than the one the delegate closed. The RAG crate must therefore never
		// grow graph tables or a traversal of its own — it asks `spaces.db`.
		//
		// Comments are stripped first because the crate's docs legitimately NAME
		// these tables to explain where the graph lives; scanning raw source would
		// force the explanation out to keep the guard green.
		const ragCode = ragRs
			.replaceAll(/^\s*\/\/.*$/gm, "")
			.replaceAll(/\/\*[\s\S]*?\*\//g, "");
		for (const name of ["graph_nodes", "graph_edges", "fn graph_search"]) {
			expect(ragCode).not.toContain(name);
		}
	});
});

describe("toRetrievalMode", () => {
	it("passes through the two known spellings", () => {
		expect(toRetrievalMode("graph")).toBe("graph");
		expect(toRetrievalMode("vector")).toBe("vector");
	});

	it("degrades anything else to vector instead of throwing", () => {
		// Matches Rust `from_str`'s `_ => Self::Vector`, including case sensitivity:
		// `"Graph"` is NOT graph on either side.
		for (const value of ["Graph", "GRAPH", "graphrag", "", "hybrid"]) {
			expect(toRetrievalMode(value)).toBe("vector");
		}
	});

	it("treats an absent field as vector (older Core, no column serialized)", () => {
		expect(toRetrievalMode(undefined)).toBe("vector");
		expect(toRetrievalMode(null)).toBe("vector");
	});
});

describe("describeRetrievalModeChange", () => {
	it("reports what the graph rebuild covered", () => {
		const text = describeRetrievalModeChange(
			change({ chunksScanned: 12, graphNodes: 30, graphEdges: 45 }),
			tl
		);
		expect(text).toContain("30 entities");
		expect(text).toContain("45 connections");
		expect(text).toContain("12 chunks");
	});

	it("singularizes counts of one", () => {
		const text = describeRetrievalModeChange(
			change({ chunksScanned: 1, graphNodes: 1, graphEdges: 1 }),
			tl
		);
		expect(text).toContain("1 entity");
		expect(text).toContain("1 connection");
		expect(text).toContain("1 chunk");
		expect(text).not.toContain("entities");
	});

	it("does not read an empty space as a failed rebuild", () => {
		// "Mapped 0 entities across 0 chunks" is a correct outcome for a space with
		// no documents, but it reads as breakage. This case gets its own sentence.
		const text = describeRetrievalModeChange(change({ chunksScanned: 0 }), tl);
		expect(text).toContain("no documents yet");
		expect(text).not.toContain("0 entities");
	});

	it("says the graph was discarded when switching back to vector", () => {
		const text = describeRetrievalModeChange(
			change({ mode: "vector", previous: "graph", graphRebuilt: false }),
			tl
		);
		expect(text).toContain("discarded");
		expect(text).toContain("Vector retrieval is on");
	});

	it("never claims anything was re-embedded, in either direction", () => {
		// Core never re-embeds on a mode switch. Copy that implied it would send
		// users looking for a cost/wait that does not exist.
		for (const outcome of [
			change({ chunksScanned: 3, graphNodes: 4, graphEdges: 5 }),
			change({ chunksScanned: 0 }),
			change({ mode: "vector", graphRebuilt: false }),
		]) {
			expect(describeRetrievalModeChange(outcome, tl)).not.toMatch(
				/re-?embedding|will be re-?embedded/i
			);
		}
	});
});
