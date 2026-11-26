// apps/mcp/src/tools.path-ids.test.ts
//
// The id of ryu_run_workflow and the spaceId of ryu_search_space are written by
// the model of the MCP host and become one segment of a Core path. An id with a
// path character must be refused before any request leaves, so a tool call
// cannot reach a Core route outside the tool list. Stub fetch only.

import { expect, test } from "bun:test";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { isSafePathId } from "./tool-path-id.ts";
import { registerRyuTools } from "./tools.ts";

type Handler = (input: Record<string, unknown>) => Promise<CallToolResult>;

const BASE = "http://core.test";

/** Ids that must never reach a Core path, with the reason each one is here. */
const REFUSED_IDS: readonly string[] = [
	"../api/agents/a?", // leaves the route, moves the suffix into the query
	"../api/node/token/rotate?", // the route Security named: a POST that needs no body
	"runs/run_1", // a sibling path under the same prefix
	"a\\b", // HTTP URL parsers read a backslash as a slash
	"wf_1?x=1",
	"wf_1#x",
	"wf%2f1", // an escape the server decodes
	".",
	"..",
	".\t.", // URL parsers drop tab, CR and LF
	"wf\n1",
	"wf 1",
	"wf\u007f1",
	"",
];

/** The tools of a fresh server whose Core is a stub that records every request. */
function recordingTools(): { requests: string[]; tools: Map<string, Handler> } {
	const requests: string[] = [];
	const tools = new Map<string, Handler>();
	const server = {
		registerTool: (name: string, _config: unknown, handler: Handler) => {
			tools.set(name, handler);
		},
	} as unknown as McpServer;
	const target: ApiTarget = {
		url: BASE,
		token: "node-token",
		fetch: (input, init) => {
			requests.push(`${init?.method ?? "GET"} ${String(input)}`);
			return Promise.resolve(new Response("{}", { status: 500 }));
		},
	};
	registerRyuTools(server, target);
	return { requests, tools };
}

/** Call `tool` once per refused id and list every id that reached the stub. */
async function leakedIds(
	tool: string,
	input: (id: string) => Record<string, unknown>
): Promise<{ leaked: string[]; notRefused: string[] }> {
	const leaked: string[] = [];
	const notRefused: string[] = [];
	for (const id of REFUSED_IDS) {
		const { requests, tools } = recordingTools();
		const handler = tools.get(tool);
		if (!handler) {
			throw new Error(`${tool} is not registered`);
		}
		const result = await handler(input(id));
		if (requests.length > 0) {
			leaked.push(`${JSON.stringify(id)} sent ${requests.join(", ")}`);
		}
		const text = JSON.stringify(result.content);
		if (!(result.isError && text.includes("without path characters"))) {
			notRefused.push(JSON.stringify(id));
		}
	}
	return { leaked, notRefused };
}

test("ryu_run_workflow sends nothing for an id with a path character", async () => {
	const { leaked, notRefused } = await leakedIds("ryu_run_workflow", (id) => ({
		id,
		input: { key: "value" },
	}));
	expect(leaked).toEqual([]);
	expect(notRefused).toEqual([]);
});

test("ryu_search_space sends nothing for a spaceId with a path character", async () => {
	const { leaked, notRefused } = await leakedIds("ryu_search_space", (id) => ({
		spaceId: id,
		query: "notes",
		limit: 3,
	}));
	expect(leaked).toEqual([]);
	expect(notRefused).toEqual([]);
});

test("ryu_run_workflow still posts a plain workflow id to its own route", async () => {
	const { requests, tools } = recordingTools();
	await tools.get("ryu_run_workflow")?.({ id: "wf_0123abcd", dryRun: true });
	expect(requests).toEqual([`POST ${BASE}/workflows/wf_0123abcd/run`]);
});

test("ryu_search_space still posts a plain space id to its own route", async () => {
	const { requests, tools } = recordingTools();
	await tools.get("ryu_search_space")?.({ spaceId: "space-1", query: "notes" });
	expect(requests).toEqual([`POST ${BASE}/api/spaces/space-1/search`]);
});

test("the id rule refuses every listed id and keeps the ids Core mints", () => {
	expect(REFUSED_IDS.filter(isSafePathId)).toEqual([]);
	for (const id of ["wf_0123abcd", "run-9f", "space-1", "a.b", "A_b-9"]) {
		expect(isSafePathId(id)).toBe(true);
	}
});
