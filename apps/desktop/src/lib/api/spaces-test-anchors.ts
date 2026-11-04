import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatMessage } from "@ryu/i18n";
import type { LiteralMessage } from "@ryu/i18n/react";
import { rustModuleSource } from "./rust-module-source.ts";
import type { RetrievalModeChange } from "./spaces.ts";

export const tl: LiteralMessage = (source, values) =>
	formatMessage(source, values ?? {});

// src/lib/api → src/lib → src → apps/desktop → apps → repo root.
export const REPO_ROOT = join(import.meta.dir, "../../../../..");

export function rustSource(relative: string): string {
	const path = join(REPO_ROOT, relative);
	try {
		return readFileSync(path, "utf8");
	} catch (e) {
		throw new Error(
			`mirror test cannot read ${relative} (resolved ${path}): ${e instanceof Error ? e.message : e}`
		);
	}
}

/**
 * Extract the body of one Rust item by its header line, brace-matched so a method
 * inside an `impl` yields the method and not the rest of the `impl`.
 *
 * Throws — never returns `""` — when the header is absent, because an anchor whose
 * host item was renamed must read as "go look at this test", not as a bare false.
 */
export function rustItemBody(
	source: string,
	file: string,
	header: string
): string {
	const start = source.indexOf(header);
	if (start < 0) {
		throw new Error(
			`mirror test anchor lost its target: \`${header}\` is no longer in ${file}. ` +
				"The Spaces retrieval-mode client (apps/desktop/src/lib/api/spaces.ts) " +
				"claims to speak that item's wire contract; re-point this anchor " +
				"(apps/desktop/src/lib/api/spaces.test.ts) and re-check the client " +
				"against whatever replaced it."
		);
	}
	const open = source.indexOf("{", start);
	if (open < 0) {
		throw new Error(`mirror test found \`${header}\` in ${file} but no body`);
	}
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === "{") {
			depth++;
		} else if (source[i] === "}") {
			depth--;
			if (depth === 0) {
				return source.slice(open, i + 1);
			}
		}
	}
	throw new Error(
		`mirror test found \`${header}\` in ${file} but its body never closes`
	);
}

/** Collapse every whitespace run to one space, so formatting is not the claim. */
export const squeeze = (s: string): string => s.replaceAll(/\s+/g, " ").trim();

/** The mirror under test; named in every anchor diagnostic. */
export const SPACES_TS = "apps/desktop/src/lib/api/spaces.ts";

/** What {@link rustAnchor} returns when the expression is still there. */
export const ANCHOR_PRESENT = "present";

/**
 * Probe a named Rust item for the literal this client mirrors,
 * whitespace-insensitively. Returns {@link ANCHOR_PRESENT}, or a diagnostic
 * naming the file, the item and the expression.
 *
 * A probe rather than an assertion helper on purpose (twice over): Biome's
 * `noMisplacedAssertion` rejects an `expect` outside an `it`, and returning the
 * diagnostic puts it on the FAILURE LINE — the person who breaks this is a Core
 * author who has never opened this file and must know what to do without reading
 * it. Same shape as `preferences.test.ts`, deliberately.
 */
export function rustAnchor(
	source: string,
	file: string,
	header: string,
	anchor: string
): string {
	const body = rustItemBody(source, file, header);
	return squeeze(body).includes(squeeze(anchor))
		? ANCHOR_PRESENT
		: `MISSING from ${file} :: ${header} — the TS client in ${SPACES_TS} claims Core still does: ${anchor}`;
}

/** Probe a Rust item for a bare substring (a JSON key), same contract. */
export function rustContains(
	source: string,
	file: string,
	header: string,
	needle: string
): string {
	return rustItemBody(source, file, header).includes(needle)
		? ANCHOR_PRESENT
		: `MISSING from ${file} :: ${header} — the TS client in ${SPACES_TS} reads: ${needle}`;
}

export const SERVER_RS =
	"apps/core/src/server (mod.rs and its spliced submodules)";
export const SPACES_RS = "crates/core/spaces/src/lib.rs";
export const SPACES_RETRIEVAL_RS = "crates/core/spaces/src/retrieval.rs";
export const RAG_RS =
	"crates/core/rag/src (every module except memory_graph.rs)";
/** The RAG crate's source root; every module under it is scanned. */
export const RAG_SRC_DIR = "crates/core/rag/src";
/**
 * Modules under {@link RAG_SRC_DIR} the scan leaves out. `memory_graph.rs` is the
 * agent-memory graph, a different graph from a Space's term graph, so it is the one
 * file the "ONE term graph" guard below must not read.
 */
export const RAG_RS_EXCLUDED = new Set(["memory_graph.rs"]);
/**
 * Every `*.rs` under the RAG crate's `src/`, found by walking the directory rather
 * than kept by hand, so a module added or split out later is scanned by the
 * anchors and the term-graph guard without anyone editing this list. `lib.rs`
 * comes first and the rest in sorted order, so the concatenation is stable.
 */
export const RAG_RS_FILES = readdirSync(join(REPO_ROOT, RAG_SRC_DIR), {
	recursive: true,
	encoding: "utf8",
})
	.map((file) => file.replaceAll("\\", "/"))
	.filter((file) => file.endsWith(".rs") && !RAG_RS_EXCLUDED.has(file))
	.sort((a, b) => {
		if (a === "lib.rs") {
			return -1;
		}
		if (b === "lib.rs") {
			return 1;
		}
		return a.localeCompare(b);
	})
	.map((file) => `${RAG_SRC_DIR}/${file}`);
/** Core's RAG wiring module — home of the ONE `SpaceRecall` implementation. */
export const RAG_HOST_RS = "apps/core/src/rag_host.rs";

export const serverRs = rustModuleSource("apps/core/src/server");
export const spacesRs = rustSource(SPACES_RS);
export const ragRs = RAG_RS_FILES.map(rustSource).join("\n");

export const RETRIEVAL_TARGET = { url: "https://node.test", token: null };

export function completedRetrievalStatus(jobId: string) {
	return {
		job_id: jobId,
		space_id: "space",
		state: "completed",
		change: {
			mode: "graph",
			previous: "vector",
			changed: true,
			graph_rebuilt: true,
			chunks_scanned: 1,
			graph_nodes: 2,
			graph_edges: 1,
			note: "done",
		},
	};
}

/** A change payload with the fields a test does not care about filled in. */
export function change(
	partial: Partial<RetrievalModeChange>
): RetrievalModeChange {
	return {
		mode: "graph",
		previous: "vector",
		changed: true,
		graphRebuilt: true,
		chunksScanned: 0,
		graphNodes: 0,
		graphEdges: 0,
		note: "",
		...partial,
	};
}

// ── Whether an uploaded file's CONTENTS are searchable ───────────────────────
//
// The claim this client makes on screen — "this file is stored and opens, but a
// search will not find the text inside it" — is a claim about Core's
// `document.parse` capability, which the client cannot observe. So it is anchored
// where the behaviour lives, and every anchor below is written to fail LOUDLY, with
// instructions, when Core moves.
//
// This block has already been rewritten once, mid-task, and the reason is worth
// keeping because it is the exact hazard this file's header describes. The first
// version keyed the badge on `rawKind === 'file'` and pinned that to
// `SpaceStore::create_file` still embedding only its `{title}\n{mime}` descriptor.
// Core then landed `space_file_index.rs`, which *wraps* `create_file` — leaving the
// descriptor line untouched, so the anchor kept passing — and started extracting
// text. `.txt`/`.md`/`.csv` go through the in-process floor and are `indexed` before
// the upload returns, so the badge would have libelled them while its test stayed
// green. An anchor on the WRAPPED function cannot see a change made in the WRAPPER;
// the anchors below therefore point at the caller.

export const CORE_SPACE_FILE_INDEX_RS = "apps/core/src/space_file_index.rs";
export const spaceFileIndexRs = rustSource(CORE_SPACE_FILE_INDEX_RS);
