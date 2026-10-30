// Shared fixture for the Tools Library interaction proofs: the mocked node
// registry, its routes, evidence capture and the dialog openers.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import {
	type ToolsProofJson,
	toolsCallSchema,
	toolsProofRecordSchema,
	toolsQuery,
	toolsServerCreateSchema,
	toolsServerUpdateSchema,
} from "./tools-library-proof.contracts.ts";

export interface ServerWire {
	args: string[];
	auth_configured: boolean;
	auth_required: boolean;
	auth_type: "env" | "header" | "oauth" | null;
	available: boolean | null;
	command: string;
	description: string | null;
	enabled: boolean;
	env_keys: string[];
	header_names: string[];
	name: string;
	owner_plugin_id: string | null;
	owner_server_name: string | null;
	transport: string | null | undefined;
	url: string | null;
}

export interface ToolWire {
	description: string | null;
	id: string;
	input_schema: ToolsProofJson;
	name: string;
	server: string;
}

export interface FixtureState {
	failFirstServerRead: boolean;
	failNextCreate: boolean;
	failNextDelete: boolean;
	failNextUpdate: boolean;
	failToolDiscovery: boolean;
	mutations: Array<{ body?: ToolsProofJson; method: string; pathname: string }>;
	secrets: Record<
		string,
		{ env: Record<string, string>; headers: Record<string, string> }
	>;
	servers: ServerWire[];
	toolCalls: ToolsProofJson[];
	toolReads: string[];
	tools: ToolWire[];
}

export function server(
	name: string,
	options: Partial<ServerWire> = {}
): ServerWire {
	return {
		args: [],
		auth_configured: false,
		auth_required: false,
		auth_type: null,
		available: true,
		command: "fixture-mcp",
		description: `${name} fixture server`,
		enabled: true,
		env_keys: [],
		header_names: [],
		name,
		owner_plugin_id: null,
		owner_server_name: null,
		transport: "stdio",
		url: null,
		...options,
	};
}

export function initialState(): FixtureState {
	return {
		servers: [
			server("Workspace", {
				args: ["--root", "/fixture/workspace"],
				auth_configured: true,
				auth_required: true,
				auth_type: "env",
				command: "node",
				description: "Project files and document search",
				env_keys: ["API_TOKEN"],
			}),
			server("Calendar", {
				available: false,
				command: "calendar-fixture",
				description: "Find calendar events",
			}),
			server("Reports", {
				description: "Export reports",
				enabled: false,
			}),
		],
		tools: [
			{
				description: "Search documents in the workspace",
				id: "Workspace.search_docs",
				input_schema: {
					type: "object",
					properties: { query: { type: "string" } },
				},
				name: "search_docs",
				server: "Workspace",
			},
			{
				description: "Read one fixture file",
				id: "Workspace.read_file",
				input_schema: {
					type: "object",
					properties: { path: { type: "string" } },
				},
				name: "read_file",
				server: "Workspace",
			},
			{
				description: "Search calendar events",
				id: "Calendar.find_events",
				input_schema: {
					type: "object",
					properties: { from: { type: "string" } },
				},
				name: "find_events",
				server: "Calendar",
			},
			{
				description: "Export a report",
				id: "Reports.export_csv",
				input_schema: { type: "object" },
				name: "export_csv",
				server: "Reports",
			},
			{
				description: "Legacy tool from a removed server",
				id: "Removed.legacy_lookup",
				input_schema: { type: "object" },
				name: "legacy_lookup",
				server: "Removed",
			},
		],
		secrets: {
			Workspace: {
				env: { API_TOKEN: "fixture-env-secret" },
				headers: {},
			},
		},
		mutations: [],
		toolCalls: [],
		toolReads: [],
		failNextCreate: false,
		failNextUpdate: false,
		failNextDelete: false,
		failFirstServerRead: false,
		failToolDiscovery: false,
	};
}

export async function installFixture(page: Page, state: FixtureState) {
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (!url.pathname.startsWith("/api/")) {
			return route.continue();
		}

		if (request.method() === "GET" && url.pathname === "/api/mcp/servers") {
			if (state.failFirstServerRead) {
				return route.fulfill({
					status: 503,
					json: { error: "Fixture registry offline" },
				});
			}
			return route.fulfill({ json: { servers: state.servers } });
		}

		if (request.method() === "GET" && url.pathname === "/api/mcp/tools") {
			state.toolReads.push(url.pathname + url.search);
			if (state.failToolDiscovery) {
				return route.fulfill({
					status: 503,
					json: { error: "Fixture tool discovery offline" },
				});
			}
			const tools =
				url.searchParams.get("agent") === "research-agent"
					? state.tools.filter((tool) => tool.id === "Workspace.search_docs")
					: state.tools;
			return route.fulfill({ json: { tools } });
		}

		if (request.method() === "GET" && url.pathname === "/api/agents") {
			return route.fulfill({
				json: {
					agents: [
						{ id: "research-agent", name: "Research agent" },
						{ id: "ops-agent", name: "Operations agent" },
					],
				},
			});
		}

		if (request.method() === "GET" && url.pathname === "/api/apps") {
			return route.fulfill({ json: { apps: [] } });
		}

		if (request.method() === "GET" && url.pathname === "/api/identities") {
			return route.fulfill({ json: { profiles: [] } });
		}

		if (request.method() === "POST" && url.pathname === "/api/mcp/servers") {
			const body = toolsProofRecordSchema.parse(request.postDataJSON());
			state.mutations.push({
				body,
				method: request.method(),
				pathname: url.pathname,
			});
			if (state.failNextCreate) {
				state.failNextCreate = false;
				return route.fulfill({
					json: { ok: false, error: "Fixture create conflict" },
				});
			}
			const command = toolsServerCreateSchema.parse(body);
			const env = command.env ?? {};
			const headers = command.headers ?? {};
			const created = server(String(command.name), {
				args: command.args ?? [],
				command: command.command ?? "",
				description: command.description ?? null,
				enabled: true,
				env_keys: Object.keys(env),
				header_names: Object.keys(headers),
				transport: command.type,
				url: command.url ?? null,
			});
			state.servers.push(created);
			state.secrets[created.name] = {
				env: { ...env },
				headers: { ...headers },
			};
			return route.fulfill({ json: { ok: true, server: created } });
		}

		if (
			request.method() === "PUT" &&
			url.pathname.startsWith("/api/mcp/servers/")
		) {
			const name = decodeURIComponent(
				url.pathname.slice("/api/mcp/servers/".length)
			);
			const body = toolsProofRecordSchema.parse(request.postDataJSON());
			state.mutations.push({
				body,
				method: request.method(),
				pathname: url.pathname,
			});
			if (state.failNextUpdate) {
				state.failNextUpdate = false;
				return route.fulfill({
					json: { ok: false, error: "Fixture update unavailable" },
				});
			}
			const current = state.servers.find((item) => item.name === name);
			if (!current) {
				return route.fulfill({
					json: { ok: false, error: "Server not found" },
				});
			}
			const command = toolsServerUpdateSchema.parse(body);
			const env = command.env ?? {};
			const headers = command.headers ?? {};
			const secrets = state.secrets[name] ?? { env: {}, headers: {} };
			for (const [key, value] of Object.entries(env)) {
				if (value !== "••••••") {
					secrets.env[key] = value;
				}
			}
			for (const [key, value] of Object.entries(headers)) {
				if (value !== "••••••") {
					secrets.headers[key] = value;
				}
			}
			const updated = server(name, {
				...current,
				args: command.args ?? current.args,
				command: command.command ?? current.command,
				description: command.description ?? current.description,
				enabled: command.enabled ?? current.enabled,
				env_keys: Object.keys(env),
				header_names: Object.keys(headers),
				transport: command.type ?? current.transport,
				url: command.url ?? current.url,
			});
			state.servers = state.servers.map((item) =>
				item.name === name ? updated : item
			);
			state.secrets[name] = secrets;
			return route.fulfill({ json: { ok: true, server: updated } });
		}

		if (
			request.method() === "DELETE" &&
			url.pathname.startsWith("/api/mcp/servers/")
		) {
			const name = decodeURIComponent(
				url.pathname.slice("/api/mcp/servers/".length)
			);
			state.mutations.push({
				method: request.method(),
				pathname: url.pathname,
			});
			if (state.failNextDelete) {
				state.failNextDelete = false;
				return route.fulfill({
					json: { ok: false, error: "Fixture delete unavailable" },
				});
			}
			state.servers = state.servers.filter((item) => item.name !== name);
			delete state.secrets[name];
			return route.fulfill({ json: { ok: true } });
		}

		if (request.method() === "POST" && url.pathname === "/api/mcp/tools/call") {
			const body = toolsProofRecordSchema.parse(request.postDataJSON());
			state.toolCalls.push(body);
			if (state.toolCalls.length === 1) {
				return route.fulfill({
					json: { ok: false, error: "Fixture call failed once" },
				});
			}
			return route.fulfill({
				json: {
					ok: true,
					output: {
						fixture: "search completed",
						query: toolsQuery(toolsCallSchema.parse(body).arguments),
					},
				},
			});
		}

		return route.fulfill({ json: {} });
	});
}

export const evidenceDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence/tools-library"
);

export async function capture(page: Page, name: string) {
	await mkdir(evidenceDir, { recursive: true });
	await page.evaluate(() => {
		if (document.activeElement instanceof HTMLElement) {
			document.activeElement.blur();
		}
	});
	await page.screenshot({
		path: path.join(evidenceDir, name),
		fullPage: true,
		animations: "disabled",
	});
}

export async function openAddDialog(page: Page) {
	let trigger = page
		.getByRole("button", { name: "Add server", exact: true })
		.last();
	if (!(await trigger.isVisible().catch(() => false))) {
		await page
			.getByRole("button", { name: "Filter & add", exact: true })
			.click();
		trigger = page
			.getByRole("button", { name: "Add server", exact: true })
			.last();
	}
	await expect(trigger).toBeVisible();
	await trigger.click();
	return page.getByRole("dialog", { name: "Add MCP server" });
}

export async function openServerSettings(page: Page, name = "Workspace") {
	let settingsButton = page.getByRole("button", {
		name: "Settings",
		exact: true,
	});
	if (!(await settingsButton.isVisible().catch(() => false))) {
		await page
			.getByRole("button", { name: "Details", exact: true })
			.first()
			.click();
		settingsButton = page.getByRole("button", {
			name: "Settings",
			exact: true,
		});
	}
	await settingsButton.click();
	return page.getByRole("dialog", { name: `Configure ${name}` });
}
