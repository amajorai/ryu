import { describe, expect, it } from "bun:test";
import { rustModuleSource } from "./rust-module-source.ts";
import {
	fetchEmbeddingModel,
	formatBytes,
	NODE_UPLOAD_MAX_BYTES,
	querySpaceDatabase,
	SPACE_UPLOAD_MAX_BYTES,
} from "./spaces.ts";
import {
	ANCHOR_PRESENT,
	RETRIEVAL_TARGET,
	rustAnchor,
	rustContains,
	rustItemBody,
	rustSource,
	SERVER_RS,
	SPACES_RS,
	SPACES_TS,
	serverRs,
	spacesRs,
} from "./spaces-test-anchors.ts";

describe("global lexical Spaces search mirrors Core", () => {
	it("mounts the global search route before the dynamic Space route", () => {
		expect(
			rustAnchor(
				serverRs,
				SERVER_RS,
				"fn spaces_routes(",
				'.route("/api/spaces/search", get(search_space_documents))'
			)
		).toBe(ANCHOR_PRESENT);
	});

	it("keeps the client and Core on the same lexical hit contract", () => {
		const search = rustItemBody(
			spacesRs,
			SPACES_RS,
			"pub async fn search_documents_lexical("
		);
		expect(search).toContain("search_documents_lexical_term");
		const termSearch = rustItemBody(
			spacesRs,
			SPACES_RS,
			"async fn search_documents_lexical_term("
		);
		expect(termSearch).toContain("DOC_TENANCY_VISIBLE_PREDICATE");
		// Titles and descriptions are sealed at rest, so the term is matched in Rust
		// against opened values (case-folded), and body hits come from the blind index.
		expect(termSearch).toContain("let needle = term.to_lowercase();");
		expect(termSearch).toContain("terms_query(term)");
		expect(termSearch).toContain("LexicalDocumentMatch");

		const client = rustSource(SPACES_TS);
		expect(client).toContain("/api/spaces/search?");
		expect(client).toContain("params.toString()");
		expect(client).toContain("documentId: hit.document_id");
		expect(client).toContain("updatedAt: hit.updated_at || hit.created_at");
	});

	it("carries document updated_at for relative dates in page rows", () => {
		expect(
			rustAnchor(
				spacesRs,
				SPACES_RS,
				"pub async fn list_documents(",
				"d.created_at, d.updated_at"
			)
		).toBe(ANCHOR_PRESENT);
		expect(rustSource(SPACES_TS)).toContain(
			"updatedAt: d.updated_at ?? d.created_at"
		);
	});
});

describe("shared-space visibility mirrors Core", () => {
	it("sends the visibility field accepted by space creation", () => {
		expect(
			rustAnchor(
				serverRs,
				SERVER_RS,
				"struct CreateSpaceBody",
				"visibility: Option<String>"
			)
		).toBe(ANCHOR_PRESENT);
		expect(rustSource(SPACES_TS)).toContain("body.visibility = visibility");
	});

	it("mounts the write route used by the desktop visibility menu", () => {
		expect(
			rustAnchor(
				serverRs,
				SERVER_RS,
				"fn spaces_routes(",
				'.route("/api/spaces/:id/visibility", post(set_space_visibility))'
			)
		).toBe(ANCHOR_PRESENT);
		expect(
			rustAnchor(
				serverRs,
				SERVER_RS,
				"async fn set_space_visibility(",
				"require_resource_write"
			)
		).toBe(ANCHOR_PRESENT);
		expect(rustSource(SPACES_TS)).toContain(
			"/api/spaces/\u0024{encodeURIComponent(id)}/visibility"
		);
	});
});

describe("the upload ceiling this client reports", () => {
	it("is the one every upload from this app actually hits", () => {
		// `/api/uploads` is where chat attachments, editor pastes and
		// `ui.uploadFile` all land, and 32 MiB is where they stop. This is the only
		// ceiling `StorageSettings` may print.
		expect(rustModuleSource("apps/core/src/server/uploads")).toContain(
			"pub const MAX_UPLOAD_BYTES: usize = crate::server::media::MAX_MEDIA_BYTES;"
		);
		expect(rustSource("apps/core/src/server/media.rs")).toContain(
			"pub const MAX_MEDIA_BYTES: usize = 32 * 1024 * 1024;"
		);
		expect(NODE_UPLOAD_MAX_BYTES).toBe(32 * 1024 * 1024);
	});

	it("declares the ceiling it actually enforces, defined from one source", () => {
		// The 200 MiB figure is gone from Core. `MAX_FILE_BYTES` is now DEFINED AS
		// `uploads::MAX_UPLOAD_BYTES` rather than a second literal, which is the part
		// worth pinning: two literals can drift, a definition cannot. Anchoring on the
		// literal `32 * 1024 * 1024` here would reintroduce exactly that drift.
		expect(serverRs).toContain(
			"const MAX_FILE_BYTES: usize = uploads::MAX_UPLOAD_BYTES;"
		);
		expect(SPACE_UPLOAD_MAX_BYTES).toBe(NODE_UPLOAD_MAX_BYTES);
		expect(
			rustAnchor(
				serverRs,
				SERVER_RS,
				"fn decode_space_file_body(",
				"if bytes.len() > MAX_FILE_BYTES"
			)
		).toBe(ANCHOR_PRESENT);
		expect(
			rustAnchor(
				serverRs,
				SERVER_RS,
				"async fn create_file(",
				"decode_space_file_body(&body.data_base64)"
			)
		).toBe(ANCHOR_PRESENT);
		// The row lives on the Storage tab. It used to be a card on a separate
		// "Document parsing" section, which also carried a duplicate of the
		// `document.parse` provider picker that the node dropdown's Toolkits row
		// already owns; that section is gone and this row moved with the ceiling.
		const panel = rustSource(
			"apps/desktop/src/components/settings/StorageSettings.tsx"
		);
		// It may still be NAMED in the panel's prose (that is where the discrepancy is
		// explained); what it must not be is rendered.
		expect(panel).not.toContain("formatBytes(SPACE_UPLOAD_MAX_BYTES)");
		expect(panel).not.toContain(
			"import { formatBytes, SPACE_UPLOAD_MAX_BYTES }"
		);
		// The panel prefers the ceiling the NODE reports over any client mirror,
		// falling back to the constant only when the node did not answer. That is the
		// stronger shape: a hardcoded figure is what produced the 200 MiB bug, so this
		// pins "fetched, with a labelled fallback" rather than a specific literal.
		expect(panel).toContain("capability?.maxInputBytes");
		expect(panel).toContain("formatBytes(limit)");
		expect(panel).toContain("NODE_UPLOAD_MAX_BYTES");
		expect(panel).toContain('title="Maximum file you can upload"');
	});

	it("pins the axum default that made the old 200 MiB figure unreachable", () => {
		// The experiment, not the inference. This is why the ceiling had to be
		// aligned rather than merely re-documented: without an explicit layer the
		// route caps at axum's implicit 2 MiB, i.e. ~1.5 MiB of base64-encoded file.
		// If this Rust test disappears, the history in `SPACE_UPLOAD_MAX_BYTES`'s doc
		// comment is unsupported.
		expect(
			rustModuleSource("apps/core/src/server/uploads", {
				includeAllSubmodules: true,
			})
		).toContain(
			"async fn a_route_without_an_explicit_limit_caps_at_axums_default()"
		);
		// Both upload routes now DECLARE their limit through a `BodyLimit`, which
		// carries the wire ceiling and the sentence a rejection prints together — so
		// the enforced number and the explanation cannot drift apart. A bare
		// `DefaultBodyLimit::max(...)` enforced the right number and answered with an
		// unexplained 413; anchoring on that older form is what this pins against.
		expect(
			rustAnchor(
				serverRs,
				SERVER_RS,
				"fn protected_routes_5(",
				"uploads::UPLOADS_BODY_LIMIT.apply("
			)
		).toBe(ANCHOR_PRESENT);
		// `/api/spaces/:id/files` is registered in `spaces_routes()`, not
		// `create_router()` — the Spaces surface is a sub-router mounted behind its
		// own AppGate. Anchoring it to the wrong function would pass vacuously the day
		// someone moved it, which is the failure mode these mirrors exist to catch.
		expect(
			rustAnchor(
				serverRs,
				SERVER_RS,
				"fn spaces_routes(",
				"uploads::SPACE_FILE_BODY_LIMIT.apply("
			)
		).toBe(ANCHOR_PRESENT);
	});

	it("formats byte counts the way the limits panel renders them", () => {
		expect(formatBytes(NODE_UPLOAD_MAX_BYTES)).toBe("32 MB");
		expect(formatBytes(SPACE_UPLOAD_MAX_BYTES)).toBe("32 MB");
		// A three-digit MB figure is what the old 200 MiB bug looked like on screen.
		expect(formatBytes(200 * 1024 * 1024)).toBe("200 MB");
		expect(formatBytes(1536)).toBe("1.5 KB");
		expect(formatBytes(999)).toBe("999 B");
		// Never renders "NaN undefined" into a settings row.
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(Number.NaN)).toBe("0 B");
	});
});

describe("Space database SQL queries", () => {
	it("uses the mounted route and sends bound parameters", async () => {
		const originalFetch = globalThis.fetch;
		let requestUrl = "";
		let requestBody: unknown;
		globalThis.fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				requestUrl = String(input);
				requestBody = JSON.parse(String(init?.body));
				return Response.json({
					columns: ["task_name"],
					rows: [["Review"]],
					schema: [{ id: "name", label: "Task Name", name: "task_name" }],
					truncated: false,
				});
			},
			{ preconnect: originalFetch.preconnect }
		);
		try {
			const result = await querySpaceDatabase(
				RETRIEVAL_TARGET,
				"space/one",
				"database two",
				"SELECT task_name FROM data WHERE task_name = ?",
				["Review"]
			);
			expect(requestUrl).toContain(
				"/api/spaces/space%2Fone/databases/database%20two/query"
			);
			expect(requestBody).toEqual({
				query: "SELECT task_name FROM data WHERE task_name = ?",
				parameters: ["Review"],
			});
			expect(result.rows).toEqual([["Review"]]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("embedding model read mirrors Core's GET /api/embeddings/model", () => {
	it("Core's EmbeddingModelInfo publishes model_id and dims, not base_url", () => {
		const header = "pub struct EmbeddingModelInfo";
		expect(rustContains(spacesRs, SPACES_RS, header, "pub model_id:")).toBe(
			ANCHOR_PRESENT
		);
		expect(rustContains(spacesRs, SPACES_RS, header, "pub dims:")).toBe(
			ANCHOR_PRESENT
		);
		// If Core starts publishing base_url, the client may read it as required
		// again; until then the field must stay optional in spaces.ts.
		expect(rustItemBody(spacesRs, SPACES_RS, header)).not.toContain("base_url");
	});

	it("reads Core's real {model_id, dims} body without a base_url", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = Object.assign(
			async () =>
				Response.json({ model_id: "nomic-embed-text-v1.5", dims: 768 }),
			{ preconnect: originalFetch.preconnect }
		);
		try {
			const model = await fetchEmbeddingModel(RETRIEVAL_TARGET);
			expect(model).toEqual({
				modelId: "nomic-embed-text-v1.5",
				baseUrl: undefined,
				dims: 768,
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("still reads base_url when a publisher sends it", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = Object.assign(
			async () =>
				Response.json({
					base_url: "http://127.0.0.1:8081/v1",
					dims: 512,
					model_id: "text-embedding-3-small",
				}),
			{ preconnect: originalFetch.preconnect }
		);
		try {
			const model = await fetchEmbeddingModel(RETRIEVAL_TARGET);
			expect(model).toEqual({
				modelId: "text-embedding-3-small",
				baseUrl: "http://127.0.0.1:8081/v1",
				dims: 512,
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
