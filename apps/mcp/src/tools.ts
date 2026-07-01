// Registers every Ryu tool on an McpServer. Each tool wraps a typed
// @ryuhq/core-client function against a single ApiTarget (the running Core
// node). Reads are safe; the few writes (set active model, install skill, run
// workflow, call a registered MCP tool) are deliberate and clearly described.
//
// All logging MUST go to stderr — stdout is the JSON-RPC channel.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAgents } from "@ryuhq/core-client/agents";
import { askBtw } from "@ryuhq/core-client/btw";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { fetchEngines } from "@ryuhq/core-client/engines";
import { callMcpTool, fetchMcpServers } from "@ryuhq/core-client/mcp";
import {
	getActiveModel,
	searchModels,
	setActiveModel,
} from "@ryuhq/core-client/models";
import { searchRetrieval } from "@ryuhq/core-client/retrieval";
import {
	installSkill,
	listSkills,
	searchSkills,
} from "@ryuhq/core-client/skills";
import { fetchSpaces, searchSpace } from "@ryuhq/core-client/spaces";
import {
	fetchHealth,
	fetchSystemInfo,
	fetchSystemStatus,
} from "@ryuhq/core-client/system";
import { fetchTeams } from "@ryuhq/core-client/teams";
import { fetchWorkflows, runWorkflow } from "@ryuhq/core-client/workflows";
import { z } from "zod";
import { fetchSession, loadToken } from "./auth.ts";

interface ToolText {
	content: { type: "text"; text: string }[];
	isError?: boolean;
}

const ok = (value: unknown): ToolText => ({
	content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

const fail = (err: unknown): ToolText => ({
	content: [{ type: "text", text: String(err) }],
	isError: true,
});

const run = async (fn: () => Promise<unknown>): Promise<ToolText> => {
	try {
		return ok(await fn());
	} catch (err) {
		return fail(err);
	}
};

export const registerRyuTools = (
	server: McpServer,
	target: ApiTarget
): void => {
	// ── System ────────────────────────────────────────────────────────────────
	server.registerTool(
		"ryu_health",
		{
			title: "Ryu Health",
			description:
				"Probe whether the Ryu Core node is alive (GET /api/health).",
			inputSchema: {},
		},
		() => run(() => fetchHealth(target))
	);

	server.registerTool(
		"ryu_system_info",
		{
			title: "Ryu System Info",
			description:
				"Live hardware snapshot of the node (CPU, RAM, disk, GPU/VRAM, OS).",
			inputSchema: {},
		},
		() => run(() => fetchSystemInfo(target))
	);

	server.registerTool(
		"ryu_system_status",
		{
			title: "Ryu System Status",
			description:
				"Service status of the node - active engine, engine running state, sidecars, gateway reachability, mesh.",
			inputSchema: {},
		},
		() => run(() => fetchSystemStatus(target))
	);

	// ── Agents & teams ──────────────────────────────────────────────────────────
	server.registerTool(
		"ryu_list_agents",
		{
			title: "Ryu List Agents",
			description: "List the agents configured on this Ryu node.",
			inputSchema: {},
		},
		() => run(() => fetchAgents(target))
	);

	server.registerTool(
		"ryu_list_teams",
		{
			title: "Ryu List Teams",
			description: "List the multi-agent teams configured on this Ryu node.",
			inputSchema: {},
		},
		() => run(() => fetchTeams(target))
	);

	// ── Models & engines ────────────────────────────────────────────────────────
	server.registerTool(
		"ryu_search_models",
		{
			title: "Ryu Search Models",
			description:
				"Search the Ryu model catalog (Hugging Face GGUF by default). Returns matching model cards.",
			inputSchema: {
				query: z.string().describe("Free-text model search query."),
				limit: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Max results to return."),
			},
		},
		({ query, limit }) => run(() => searchModels(target, { query, limit }))
	);

	server.registerTool(
		"ryu_get_active_model",
		{
			title: "Ryu Get Active Model",
			description:
				"Read which installed model the local chat engine is currently serving.",
			inputSchema: {},
		},
		() => run(() => getActiveModel(target))
	);

	server.registerTool(
		"ryu_set_active_model",
		{
			title: "Ryu Set Active Model",
			description:
				"Switch the model the local chat stack serves to an already-installed model. modelId is the local stem or Hugging Face repo id. Optionally override the derived engine.",
			inputSchema: {
				modelId: z
					.string()
					.describe(
						"Local stem or Hugging Face repo id of an installed model."
					),
				engine: z
					.string()
					.optional()
					.describe("Override the engine derived from the model format."),
			},
		},
		({ modelId, engine }) => run(() => setActiveModel(target, modelId, engine))
	);

	server.registerTool(
		"ryu_list_engines",
		{
			title: "Ryu List Engines",
			description:
				"List the inference engines available on this node and their installed models.",
			inputSchema: {},
		},
		() => run(() => fetchEngines(target))
	);

	// ── Skills ──────────────────────────────────────────────────────────────────
	server.registerTool(
		"ryu_list_skills",
		{
			title: "Ryu List Skills",
			description:
				"List the skills installed on this node and their active (enabled) state.",
			inputSchema: {},
		},
		() => run(() => listSkills(target))
	);

	server.registerTool(
		"ryu_search_skills",
		{
			title: "Ryu Search Skills",
			description: "Search/browse the Ryu skills directory.",
			inputSchema: {
				query: z.string().describe("Free-text skill search query."),
				limit: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Max results to return."),
			},
		},
		({ query, limit }) => run(() => searchSkills(target, { query, limit }))
	);

	server.registerTool(
		"ryu_install_skill",
		{
			title: "Ryu Install Skill",
			description:
				"Install a skill (by catalog id) into the node and hot-reload Core's skill registry.",
			inputSchema: {
				id: z.string().describe("Catalog id of the skill to install."),
			},
		},
		({ id }) => run(() => installSkill(target, id))
	);

	// ── Workflows ───────────────────────────────────────────────────────────────
	server.registerTool(
		"ryu_list_workflows",
		{
			title: "Ryu List Workflows",
			description: "List the workflows defined on this Ryu node.",
			inputSchema: {},
		},
		() => run(() => fetchWorkflows(target))
	);

	server.registerTool(
		"ryu_run_workflow",
		{
			title: "Ryu Run Workflow",
			description:
				"Run a workflow by id with an optional string input map. Returns the run state (may be awaiting_input on a human-in-the-loop gate).",
			inputSchema: {
				id: z.string().describe("Workflow id to run."),
				input: z
					.record(z.string(), z.string())
					.optional()
					.describe("String key/value inputs for the workflow run."),
			},
		},
		({ id, input }) => run(() => runWorkflow(target, id, input ?? {}))
	);

	// ── MCP bridge ──────────────────────────────────────────────────────────────
	server.registerTool(
		"ryu_list_mcp_servers",
		{
			title: "Ryu List MCP Servers",
			description:
				"List the MCP servers Ryu has registered. Use ryu_call_mcp_tool to invoke any tool they expose.",
			inputSchema: {},
		},
		() => run(() => fetchMcpServers(target))
	);

	server.registerTool(
		"ryu_call_mcp_tool",
		{
			title: "Ryu Call MCP Tool",
			description:
				"Bridge: invoke a tool on ANY MCP server Ryu has registered. tool is the fully-qualified id (server__tool); if you pass a bare tool name, also pass server and they are combined. agentId is required - Core ties the per-agent tool allowlist to a registered agent (empty/unknown agent is denied).",
			inputSchema: {
				tool: z
					.string()
					.describe(
						"Fully-qualified tool id (server__tool), or a bare tool name when server is also given."
					),
				server: z
					.string()
					.optional()
					.describe(
						"Server name, combined with a bare tool name as server__tool."
					),
				agentId: z
					.string()
					.describe(
						"Id (or unique prefix) of a registered Ryu agent whose allowlist authorizes the call."
					),
				args: z
					.record(z.string(), z.unknown())
					.optional()
					.describe("Arguments object passed to the target tool."),
			},
		},
		({ tool, server: mcpServer, agentId, args }) => {
			const toolId =
				mcpServer && !tool.includes("__") ? `${mcpServer}__${tool}` : tool;
			return run(() =>
				callMcpTool(target, {
					tool: toolId,
					agentId,
					arguments: args ?? {},
				})
			);
		}
	);

	// ── Spaces & retrieval (RAG) ────────────────────────────────────────────────
	server.registerTool(
		"ryu_list_spaces",
		{
			title: "Ryu List Spaces",
			description:
				"List the knowledge Spaces (document collections) on this node.",
			inputSchema: {},
		},
		() => run(() => fetchSpaces(target))
	);

	server.registerTool(
		"ryu_search_space",
		{
			title: "Ryu Search Space",
			description:
				"Semantic search within a single Space. Returns ranked document matches.",
			inputSchema: {
				spaceId: z.string().describe("Id of the Space to search."),
				query: z.string().describe("Search query."),
				limit: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Max matches to return."),
			},
		},
		({ spaceId, query, limit }) =>
			run(() => searchSpace(target, spaceId, query, limit))
	);

	server.registerTool(
		"ryu_search_retrieval",
		{
			title: "Ryu Search Retrieval",
			description:
				"Search across memory and all Spaces, returning scored chunks ranked by relevance (unified RAG retrieval).",
			inputSchema: {
				query: z.string().describe("Retrieval query."),
				topK: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Max chunks to return after ranking."),
			},
		},
		({ query, topK }) => run(() => searchRetrieval(target, { query, topK }))
	);

	// ── Ask Ryu ─────────────────────────────────────────────────────────────────
	server.registerTool(
		"ryu_ask",
		{
			title: "Ask Ryu",
			description:
				"Ask Ryu a question and get a single synchronous answer (POST /api/btw). This routes to the node's configured side-question model with no tool access. Pass conversationId to ground the answer in an existing conversation's context; omit it to ask against an empty/ephemeral context.",
			inputSchema: {
				question: z.string().describe("The question to ask Ryu."),
				conversationId: z
					.string()
					.optional()
					.describe(
						"Optional Core conversation id to ground the answer; omit for an ephemeral context."
					),
			},
		},
		({ question, conversationId }) =>
			run(() => askBtw(target, conversationId ?? "", question))
	);

	// ── Identity ────────────────────────────────────────────────────────────────
	server.registerTool(
		"ryu_whoami",
		{
			title: "Ryu Who Am I",
			description:
				"Report the Ryu user this server is signed in as (via the device-auth login). Returns the control-plane session user, or a prompt to run `ryu-mcp login` when not signed in.",
			inputSchema: {},
		},
		async () => {
			const data = loadToken();
			if (!data) {
				return ok({
					signedIn: false,
					hint: "Run `ryu-mcp login` to sign in with the Ryu device-authorization flow.",
				});
			}
			const user = await fetchSession(data.token);
			return ok({
				signedIn: true,
				// Live session when the control plane is reachable; otherwise the
				// cached profile from the local credential.
				user: user ?? { name: data.name, email: data.email, cached: true },
			});
		}
	);
};
