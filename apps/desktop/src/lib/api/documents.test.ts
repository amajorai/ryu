// apps/desktop/src/lib/api/documents.test.ts
//
// Two kinds of test, both about one failure: a client that talks to a route the
// node does not serve, and a panel that renders that silence as a fact.
//
//  1. MIRROR tests. `documents.ts` names Core paths as string literals, and
//     nothing in TypeScript checks that Core registers them. It did not:
//     `GET /api/documents/parse/capability` was declared in `document_parse.rs`,
//     annotated for OpenAPI, and absent from every route table, so the panel's
//     only read 404'd and rendered nothing; `/api/document-parse/backends` and
//     `/api/document-parse/backend` were documented here in prose and had never
//     existed in Core at all, so the panel reported "no document parser is
//     enabled" on a node where markitdown was installed, enabled and bound.
//     These tests PARSE the Rust sources — they are in this repo, reachable from
//     this file's own directory — and every helper THROWS when its anchor is
//     missing, because an assertion over `undefined` is how a guard like this
//     dies quietly.
//
//  2. WIRE tests over the binding write. `PUT /api/capabilities/bindings`
//     REPLACES the whole override map, so "pick a parser" implemented as a
//     single-key PUT silently resets the node's `web.search`, `memory` and
//     `computer.control` picks. That is invisible in the parsing panel and only
//     shows up as a different app misbehaving later, so it is asserted on the
//     bytes that actually go over the wire.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CapabilityBindingConflictError } from "./capability-layers.ts";
import type { ApiTarget } from "./client.ts";
import {
	DOCUMENT_PARSE_CAPABILITY,
	describeApiRefusal,
	fetchParseBackends,
	setParseBackend,
} from "./documents.ts";
import type { GatewayJsonValue } from "./gateway-json-contracts.ts";

// src/lib/api → src/lib → src → apps/desktop → apps → repo root.
const REPO_ROOT = join(import.meta.dir, "../../../../..");

function repoSource(relative: string): string {
	const path = join(REPO_ROOT, relative);
	try {
		return readFileSync(path, "utf8");
	} catch (e) {
		throw new Error(
			`mirror test cannot read ${relative} (resolved ${path}): ${
				e instanceof Error ? e.message : e
			}`
		);
	}
}

const SERVER_MOD_RS = repoSource("apps/core/src/server/mod.rs");
const DOCUMENT_PARSE_RS = repoSource("apps/core/src/document_parse.rs");
const DOCUMENTS_TS = repoSource("apps/desktop/src/lib/api/documents.ts");

/**
 * True when Core's route table registers `path` as a literal route.
 *
 * Matches `.route(` followed by the quoted path across any whitespace, because
 * rustfmt splits a registration onto its own lines the moment the handler list
 * gets long — an indentation-sensitive `includes()` would report a REGISTERED
 * route as missing.
 * The quotes are what keep it off doc comments, which name paths unquoted.
 */
function isRegistered(path: string): boolean {
	const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(String.raw`\.route\(\s*"${escaped}"`).test(SERVER_MOD_RS);
}

describe("the routes this client calls exist in Core", () => {
	it("registers the capability route the parsing panel depends on", () => {
		// The panel's whole readout — bound parser, format count, missing native
		// tools, byte ceiling — comes from this one response. While it was
		// unregistered the fetch threw, `capability` stayed null, and both the
		// readout and the limits row rendered nothing at all.
		expect(isRegistered("/api/documents/parse/capability")).toBe(true);
		expect(SERVER_MOD_RS).toContain(
			"get(crate::document_parse::parse_capability)"
		);
		expect(DOCUMENTS_TS).toContain('"/api/documents/parse/capability"');
	});

	it("has no /api/document-parse/* route, and this client no longer calls one", () => {
		// The inverse direction, and the one that actually bit: the client invented
		// a pair of endpoints, documented them as Core's, and reported their 404 as
		// "this node has no parser". The backend view now comes from the generic
		// capability layer, so the literal must be gone from BOTH sides — a
		// re-added client path would fail here before it could ship as a silent
		// misreport again.
		expect(SERVER_MOD_RS).not.toContain("/api/document-parse");
		expect(DOCUMENTS_TS).not.toContain('"/api/document-parse');
	});

	it("reads the backend list from the generic capability layer", () => {
		expect(isRegistered("/api/capabilities")).toBe(true);
		expect(isRegistered("/api/capabilities/bindings")).toBe(true);
		expect(DOCUMENT_PARSE_CAPABILITY).toBe("document.parse");
		// Core's own name for the same capability, so a rename on either side
		// cannot leave this client filtering for a row that no longer exists.
		expect(DOCUMENT_PARSE_RS).toContain(
			'pub const CAP_DOCUMENT_PARSE: &str = "document.parse";'
		);
	});

	it("registers the submit/poll routes parseDocument calls", () => {
		// `parseDocument` submits and then polls; both halves must exist in Core's
		// route table, and this module's header must say so.
		expect(isRegistered("/api/documents/parse")).toBe(true);
		expect(isRegistered("/api/documents/parse/jobs/:job_id")).toBe(true);
		expect(DOCUMENTS_TS).toContain(
			"All three parse routes are registered in Core"
		);
	});
});

// ── Wire tests ────────────────────────────────────────────────────────────────

const TARGET: ApiTarget = {
	url: "http://127.0.0.1:7777",
	token: null,
	userJwt: null,
};

interface Call {
	body: string | null;
	method: string;
	url: string;
}

function jsonResponse(payload: GatewayJsonValue, status = 200): Response {
	return Response.json(payload, { status });
}

/**
 * Run `run` with `globalThis.fetch` replaced by a router over `routes`, and
 * return every call it made.
 *
 * Bodies are recorded EAGERLY rather than read back from the recorded call
 * later: the transport only reads a body on its own success path, so a lazy
 * recorder can leave the assertion comparing "" to "" and pass for the wrong
 * reason.
 */
async function withFetch<T>(
	routes: (url: string, init?: RequestInit) => Response,
	run: () => Promise<T>
): Promise<{ calls: Call[]; result: T }> {
	const original = globalThis.fetch;
	const calls: Call[] = [];
	globalThis.fetch = Object.assign(
		async (...[url, init]: Parameters<typeof globalThis.fetch>) => {
			calls.push({
				body: init?.body === undefined ? null : String(init.body),
				method: init?.method ?? "GET",
				url: String(url),
			});
			return routes(String(url), init);
		},
		{ preconnect: original.preconnect }
	);
	try {
		return { calls, result: await run() };
	} finally {
		globalThis.fetch = original;
	}
}

/** A `/api/capabilities` payload with a `document.parse` row plus a decoy. */
const CAPABILITIES_PAYLOAD = {
	capabilities: [
		{
			capability: "web.search",
			providers: [{ id: "com.ryu.exa", name: "Exa" }],
			available: [],
			bound: "com.ryu.exa",
			overridden: true,
			selectable: true,
		},
		{
			capability: "document.parse",
			providers: [
				{
					id: "@ryu/markitdown",
					name: "MarkItDown",
					version: "1.2.0",
					is_default: true,
				},
			],
			available: [{ id: "@ryu/docling", name: "Docling" }],
			bound: "@ryu/markitdown",
			overridden: false,
			selectable: true,
		},
	],
	verbs: [],
};

describe("fetchParseBackends", () => {
	it("returns the document.parse row, not another layer's", async () => {
		const { result } = await withFetch(
			() => jsonResponse(CAPABILITIES_PAYLOAD),
			() => fetchParseBackends(TARGET)
		);
		expect(result.bound).toBe("@ryu/markitdown");
		expect(result.providers.map((p) => p.id)).toEqual(["@ryu/markitdown"]);
		expect(result.providers[0]?.isDefault).toBe(true);
		expect(result.providers[0]?.version).toBe("1.2.0");
		// Installed-but-disabled backends are carried, never hidden: every heavy
		// parser ships opt-in, so dropping them leaves a node looking as if nothing
		// could ever read a PDF.
		expect(result.available.map((p) => p.id)).toEqual(["@ryu/docling"]);
		expect(result.selectable).toBe(true);
		expect(result.overridden).toBe(false);
	});

	it("returns the empty view when no app provides the capability", async () => {
		// A node with every parser uninstalled has no such row. That is a state the
		// panel renders (the built-in floor plus a pointer at the Store), so it must
		// not arrive as an exception.
		const { result } = await withFetch(
			() => jsonResponse({ capabilities: [], verbs: [] }),
			() => fetchParseBackends(TARGET)
		);
		expect(result.providers).toEqual([]);
		expect(result.bound).toBeNull();
		expect(result.selectable).toBe(false);
	});

	it("throws when the node does not answer, rather than reporting no parser", async () => {
		// THE regression. `catch { setBackends(null) }` in the panel turns a throw
		// into "no parser is enabled on this node", so this must stay a throw and
		// never degrade into an empty-but-successful list — an unreachable node is
		// not a node without a parser.
		await expect(
			withFetch(
				() => jsonResponse({ error: "nope" }, 500),
				() => fetchParseBackends(TARGET)
			)
		).rejects.toBeDefined();
	});
});

const bindingBodySchema = z.object({
	overrides: z.record(z.string(), z.string()),
});

describe("setParseBackend", () => {
	/** Route GET bindings → `current`, PUT → echo, everything else → 404. */
	function bindingRoutes(current: Record<string, string>) {
		return (url: string, init?: RequestInit) => {
			if (url.endsWith("/api/capabilities/bindings")) {
				if ((init?.method ?? "GET") === "GET") {
					return jsonResponse({ overrides: current });
				}
				return jsonResponse({
					ok: true,
					overrides: bindingBodySchema.parse(
						JSON.parse(String(init?.body ?? "{}"))
					).overrides,
				});
			}
			return jsonResponse({ error: `unrouted ${url}` }, 404);
		};
	}

	function putBody(calls: Call[]): Record<string, string> {
		const put = calls.find((c) => c.method === "PUT");
		if (!put?.body) {
			throw new Error("no PUT was made — the binding write did not happen");
		}
		return bindingBodySchema.parse(JSON.parse(put.body)).overrides;
	}

	it("pinning a parser preserves every other capability's override", async () => {
		const { calls } = await withFetch(
			bindingRoutes({
				"web.search": "com.ryu.tavily",
				memory: "com.ryu.mem0",
			}),
			() => setParseBackend(TARGET, "@ryu/docling")
		);
		expect(putBody(calls)).toEqual({
			"web.search": "com.ryu.tavily",
			memory: "com.ryu.mem0",
			"document.parse": "@ryu/docling",
		});
	});

	it("resetting to automatic removes ONLY the document.parse key", async () => {
		const { calls } = await withFetch(
			bindingRoutes({
				"document.parse": "@ryu/docling",
				"web.search": "com.ryu.tavily",
			}),
			() => setParseBackend(TARGET, null)
		);
		expect(putBody(calls)).toEqual({ "web.search": "com.ryu.tavily" });
	});

	it("resetting when nothing is overridden writes nothing at all", async () => {
		const { calls } = await withFetch(
			bindingRoutes({ "web.search": "com.ryu.tavily" }),
			() => setParseBackend(TARGET, null)
		);
		expect(calls.some((c) => c.method === "PUT")).toBe(false);
	});
});

describe("describeApiRefusal", () => {
	it("keeps the blocking plugin and the reason code on a 409", () => {
		// Core answers a refused binding change with WHICH enabled app the change
		// would leave unbound. Flattening the typed conflict to `error.message`
		// drops exactly that, leaving the user with an unactionable sentence.
		const described = describeApiRefusal(
			new CapabilityBindingConflictError(
				"capability document.parse is ambiguous",
				"@ryu/spaces",
				"ambiguous"
			)
		);
		expect(described).toContain("@ryu/spaces");
		expect(described).toContain("ambiguous");
	});

	it("falls back to a transport error's own message", () => {
		expect(describeApiRefusal(new Error("network down"))).toBe("network down");
	});

	it("says nothing for a non-error value rather than printing [object Object]", () => {
		expect(describeApiRefusal({ nope: true })).toBeUndefined();
	});
});
