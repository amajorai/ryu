import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	type ToolsProofJson,
	toolsCallSchema,
	toolsProofRecordSchema,
	toolsQuery,
	toolsServerCreateSchema,
	toolsServerUpdateSchema,
} from "./tools-library-proof.contracts.ts";

interface ServerWire {
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

interface ToolWire {
	description: string | null;
	id: string;
	input_schema: ToolsProofJson;
	name: string;
	server: string;
}

interface FixtureState {
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

function server(name: string, options: Partial<ServerWire> = {}): ServerWire {
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

function initialState(): FixtureState {
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

async function installFixture(page: Page, state: FixtureState) {
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

const evidenceDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence/tools-library"
);

async function capture(page: Page, name: string) {
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

async function openAddDialog(page: Page) {
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

async function openServerSettings(page: Page, name = "Workspace") {
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

test("catalog grouping, search, allowlist, details, and card clipboard match the local registry", async ({
	page,
}) => {
	const state = initialState();
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await installFixture(page, state);
	await page.goto("/tools-library-interactions.html");

	await expect(
		page.getByText("Workspace", { exact: true }).first()
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Search Docs", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Read File", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Find Events", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Export Csv", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: /Other tools/ })
	).toBeVisible();
	await expect(page.getByText("Not installed", { exact: true })).toBeVisible();
	await expect(page.getByText("Disabled", { exact: true })).toBeVisible();
	const workspaceY = await page
		.getByRole("button", { name: /^Workspace/ })
		.first()
		.boundingBox();
	const calendarY = await page
		.getByRole("button", { name: /^Calendar/ })
		.first()
		.boundingBox();
	const reportsY = await page
		.getByRole("button", { name: /^Reports/ })
		.first()
		.boundingBox();
	expect(workspaceY?.y).toBeLessThan(calendarY?.y ?? Number.POSITIVE_INFINITY);
	expect(calendarY?.y).toBeLessThan(reportsY?.y ?? Number.POSITIVE_INFINITY);

	await page.getByRole("button", { name: "Filter & add", exact: true }).click();
	await page
		.getByRole("button", { name: "All tools A–Z", exact: true })
		.click();
	await page.getByRole("button", { name: "By server", exact: true }).click();
	await page
		.getByRole("button", { name: "All tools A–Z", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Legacy Lookup", exact: true })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Legacy Lookup", exact: true })
		.click();
	await expect(
		page
			.getByRole("dialog")
			.filter({ hasText: "Legacy tool from a removed server" })
	).toBeVisible();
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Search", exact: true }).click();
	const search = page.getByPlaceholder("Search servers and tools…");
	await search.fill("documents in the workspace");
	await page.getByRole("button", { name: "Filter & add", exact: true }).click();
	await expect(
		page.getByText("Search results are always shown as one flat list.")
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("button", { name: "Search Docs", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Find Events", exact: true })
	).toHaveCount(0);
	await search.fill("");
	await search.fill("no-fixture-tool-matches-this");
	await expect(page.getByText("No tools found", { exact: true })).toBeVisible();
	await expect(page.getByLabel("Clear search")).toBeVisible();
	await page.getByLabel("Clear search").click();
	await expect(
		page.getByRole("button", { name: "Search Docs", exact: true })
	).toBeVisible();

	await page.getByRole("button", { name: "Filter & add", exact: true }).click();
	await page.getByRole("combobox", { name: "Allowlist", exact: true }).click();
	await page
		.getByRole("option", { name: "Research agent", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Filter & add 1", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Search Docs", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Read File", exact: true })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Find Events", exact: true })
	).toHaveCount(0);
	expect(state.toolReads).toContain("/api/mcp/tools?agent=research-agent");
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Search", exact: true }).click();
	await page
		.getByPlaceholder("Search servers and tools…")
		.fill("no-allowed-result");
	await expect(
		page.getByText("This agent's allowlist exposes no matching tools.", {
			exact: true,
		})
	).toBeVisible();
	await page
		.getByRole("button", { name: "Clear filters", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Search Docs", exact: true })
	).toBeVisible();
	await page
		.getByRole("button", { name: /Workspace/ })
		.first()
		.click();
	await expect(
		page.getByRole("button", { name: "Search Docs", exact: true })
	).toHaveCount(0);
	await page
		.getByRole("button", { name: /Workspace/ })
		.first()
		.click();
	await page
		.getByRole("button", { name: "Details", exact: true })
		.first()
		.click();
	const serverDetail = page
		.getByRole("dialog")
		.filter({ hasText: "Workspace" });
	await expect(
		serverDetail.getByText("API_TOKEN", { exact: false })
	).toBeVisible();
	await page.keyboard.press("Escape");

	await page.getByRole("button", { name: "Filter & add", exact: true }).click();
	await page.getByRole("combobox", { name: "Allowlist", exact: true }).click();
	await page.getByRole("option", { name: "All tools", exact: true }).click();
	await page.keyboard.press("Escape");
	await page
		.getByRole("button", { name: "Search Docs", exact: true })
		.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Copy tool name", exact: true })
		.click();
	await expect
		.poll(() => page.evaluate(() => navigator.clipboard.readText()))
		.toBe("search_docs");
	await expect(
		page
			.getByRole("dialog")
			.filter({ hasText: "Search documents in the workspace" })
	).toHaveCount(0);
	await page.getByRole("button", { name: "Search Docs", exact: true }).click();
	await expect(
		page
			.getByRole("dialog")
			.filter({ hasText: "Search documents in the workspace" })
	).toBeVisible();
	await capture(page, "catalog-search-and-tool-detail.png");
	expect(pageErrors).toEqual([]);
});

test("add stdio server validates fields, preserves drafts on retry, and persists exact configuration", async ({
	page,
}) => {
	const state = initialState();
	state.failNextCreate = true;
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await installFixture(page, state);
	await page.goto("/tools-library-interactions.html");
	await expect(
		page.getByText("Workspace", { exact: true }).first()
	).toBeVisible();

	const dialog = await openAddDialog(page);
	await dialog.getByRole("button", { name: "Add server", exact: true }).click();
	await expect(
		dialog.getByText("Name is required.", { exact: true })
	).toBeVisible();
	await dialog.getByLabel("Name").fill("bad__name");
	await dialog.getByLabel("Command").fill("npx");
	await dialog.getByRole("button", { name: "Add server", exact: true }).click();
	await expect(
		dialog.getByText(
			"Name must not contain '__' (reserved legacy separator).",
			{ exact: true }
		)
	).toBeVisible();
	await dialog.getByLabel("Name").fill("fixture-files");
	await dialog.getByLabel("Command").fill("   ");
	await dialog.getByRole("button", { name: "Add server", exact: true }).click();
	await expect(
		dialog.getByText("Command is required for stdio servers.", { exact: true })
	).toBeVisible();
	await expect(state.mutations).toHaveLength(0);
	await dialog.getByLabel("Name").fill("cancelled-fixture");
	await dialog.getByLabel("Command").fill("echo");
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	const reopened = await openAddDialog(page);
	await expect(reopened.getByLabel("Name")).toHaveValue("");
	await expect(reopened.getByLabel("Command")).toHaveValue("");
	await reopened.getByLabel("Name").fill("fixture-files");
	await reopened.getByLabel("Command").fill("npx");
	await reopened
		.getByLabel("Arguments (space-separated)")
		.fill("-y @fixture/server /fixture/data");
	await reopened
		.getByRole("button", { name: "Add environment variable", exact: true })
		.click();
	await reopened
		.getByLabel("Environment variables key 1")
		.fill("FIXTURE_TOKEN");
	await reopened
		.getByLabel("Environment variables value 1")
		.fill("local-secret-value");
	await reopened
		.getByRole("button", { name: "Add environment variable", exact: true })
		.click();
	await reopened.getByLabel("Environment variables key 2").fill("REMOVE_ME");
	await reopened.getByLabel("Environment variables value 2").fill("unused");
	await reopened
		.getByRole("button", {
			name: "Remove environment variables 2",
			exact: true,
		})
		.click();
	await reopened
		.getByLabel("Description (optional)")
		.fill("Local filesystem fixture");
	await reopened
		.getByRole("button", { name: "Add server", exact: true })
		.click();
	await expect(
		reopened.getByText("Fixture create conflict", { exact: true })
	).toBeVisible();
	await expect(reopened.getByLabel("Name")).toHaveValue("fixture-files");
	await expect(
		reopened.getByLabel("Environment variables value 1")
	).toHaveValue("local-secret-value");
	await expect(state.mutations).toHaveLength(1);
	await expect(state.mutations[0]?.body).toEqual({
		args: ["-y", "@fixture/server", "/fixture/data"],
		command: "npx",
		description: "Local filesystem fixture",
		env: { FIXTURE_TOKEN: "local-secret-value" },
		headers: {},
		name: "fixture-files",
		type: "stdio",
	});
	await capture(page, "add-stdio-server-retry-error.png");

	await reopened
		.getByRole("button", { name: "Add server", exact: true })
		.click();
	await expect(reopened).toHaveCount(0);
	await expect(
		page.getByText("fixture-files", { exact: true }).first()
	).toBeVisible();
	await expect(
		state.servers.find((item) => item.name === "fixture-files")?.args
	).toEqual(["-y", "@fixture/server", "/fixture/data"]);
	await expect(state.mutations).toHaveLength(2);
	await expect(state.mutations[1]?.body).toEqual(state.mutations[0]?.body);
	await page.keyboard.press("Escape");
	await capture(page, "add-stdio-server-persisted.png");
	expect(pageErrors).toEqual([]);
});

test("add Streamable HTTP validates endpoint and header JSON then persists exact configuration", async ({
	page,
}) => {
	const state = initialState();
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await installFixture(page, state);
	await page.goto("/tools-library-interactions.html");
	await expect(
		page.getByText("Workspace", { exact: true }).first()
	).toBeVisible();

	const dialog = await openAddDialog(page);
	await dialog.getByLabel("Name").fill("remote-streamable");
	await dialog
		.getByRole("combobox", { name: "Transport", exact: true })
		.click();
	await page
		.getByRole("option", { name: "Streamable HTTP", exact: true })
		.click();
	await expect(
		dialog.getByText("Connect to a current MCP Streamable HTTP endpoint.", {
			exact: true,
		})
	).toBeVisible();
	await dialog.getByRole("button", { name: "Add server", exact: true }).click();
	await expect(
		dialog.getByText("Endpoint URL is required for remote servers.", {
			exact: true,
		})
	).toBeVisible();
	await dialog.getByLabel("Endpoint URL").fill("not a URL");
	await dialog.getByRole("button", { name: "Add server", exact: true }).click();
	await expect(
		dialog.getByText("Endpoint URL is not valid.", { exact: true })
	).toBeVisible();
	await dialog.getByLabel("Endpoint URL").fill("ftp://fixture.invalid/mcp");
	await dialog
		.getByLabel("Headers (optional JSON)")
		.fill('{"Authorization":"Bearer fixture"}');
	await dialog.getByRole("button", { name: "Add server", exact: true }).click();
	await expect(
		dialog.getByText("Endpoint URL must use http:// or https://.", {
			exact: true,
		})
	).toBeVisible();
	await dialog.getByLabel("Endpoint URL").fill("https://fixture.invalid/mcp");
	await dialog.getByLabel("Headers (optional JSON)").fill("{");
	await dialog.getByRole("button", { name: "Add server", exact: true }).click();
	await expect(
		dialog.getByText("Headers must be valid JSON.", { exact: true })
	).toBeVisible();
	await dialog.getByLabel("Headers (optional JSON)").fill('["not-an-object"]');
	await dialog.getByRole("button", { name: "Add server", exact: true }).click();
	await expect(
		dialog.getByText("Headers must be a JSON object of string values.", {
			exact: true,
		})
	).toBeVisible();
	await dialog
		.getByLabel("Headers (optional JSON)")
		.fill('{"Authorization":4}');
	await dialog.getByRole("button", { name: "Add server", exact: true }).click();
	await expect(
		dialog.getByText("Headers must be a JSON object of string values.", {
			exact: true,
		})
	).toBeVisible();
	await dialog
		.getByLabel("Headers (optional JSON)")
		.fill('{"Authorization":"Bearer local-fixture","X-Trace":"fixture-42"}');
	await dialog.getByRole("button", { name: "Add server", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(state.mutations[0]?.body).toEqual({
		args: [],
		description: null,
		env: {},
		headers: { Authorization: "Bearer local-fixture", "X-Trace": "fixture-42" },
		name: "remote-streamable",
		type: "streamable-http",
		url: "https://fixture.invalid/mcp",
	});
	await expect(
		page.getByText("remote-streamable", { exact: true }).first()
	).toBeVisible();
	await page.keyboard.press("Escape");
	await capture(page, "add-streamable-server-persisted.png");

	expect(pageErrors).toEqual([]);
});

test("add legacy SSE server persists its endpoint and selected transport", async ({
	page,
}) => {
	const state = initialState();
	await installFixture(page, state);
	await page.goto("/tools-library-interactions.html");
	await expect(
		page.getByText("Workspace", { exact: true }).first()
	).toBeVisible();
	const dialog = await openAddDialog(page);
	await dialog.getByLabel("Name").fill("remote-sse");
	await dialog
		.getByRole("combobox", { name: "Transport", exact: true })
		.click();
	await page
		.getByRole("option", { name: "Legacy HTTP + SSE", exact: true })
		.click();
	await expect(
		dialog.getByText(
			"Connect to the legacy SSE endpoint and its announced POST route.",
			{ exact: true }
		)
	).toBeVisible();
	await dialog.getByLabel("Endpoint URL").fill("http://fixture.invalid/events");
	await dialog.getByRole("button", { name: "Add server", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(state.mutations[0]?.body).toEqual({
		args: [],
		description: null,
		env: {},
		headers: {},
		name: "remote-sse",
		type: "sse",
		url: "http://fixture.invalid/events",
	});
	await expect(
		page.getByText("remote-sse", { exact: true }).first()
	).toBeVisible();
	await page.keyboard.press("Escape");
	await capture(page, "add-sse-server-persisted.png");
});

test("empty catalog offers the add-server flow and exits the empty state after persistence", async ({
	page,
}) => {
	const state = initialState();
	state.servers = [];
	state.tools = [];
	await installFixture(page, state);
	await page.goto("/tools-library-interactions.html");
	await expect(
		page.getByText("No MCP servers registered", { exact: true })
	).toBeVisible();
	const addButtons = page.getByRole("button", {
		name: "Add server",
		exact: true,
	});
	await expect(addButtons.last()).toBeVisible();
	await capture(page, "empty-catalog-add-server-cta.png");
	await addButtons.last().click();
	const dialog = page.getByRole("dialog", { name: "Add MCP server" });
	await dialog.getByLabel("Name").fill("first-server");
	await dialog.getByLabel("Command").fill("fixture-command");
	await dialog.getByRole("button", { name: "Add server", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(
		page.getByText("No MCP servers registered", { exact: true })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: /^first-server/ })
	).toBeVisible();
	await expect(state.mutations[0]?.body).toEqual({
		args: [],
		command: "fixture-command",
		description: null,
		env: {},
		headers: {},
		name: "first-server",
		type: "stdio",
	});
	await page.keyboard.press("Escape");
	await capture(page, "empty-catalog-server-created.png");
});

test("server settings save, validate, preserve masked secrets, retry, cancel deletion, and delete only after confirmation", async ({
	page,
}) => {
	const state = initialState();
	state.failNextUpdate = true;
	state.failNextDelete = true;
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await installFixture(page, state);
	await page.goto("/tools-library-interactions.html");
	await expect(
		page.getByText("Workspace", { exact: true }).first()
	).toBeVisible();

	let settings = await openServerSettings(page);
	await expect(settings.getByLabel("Command")).toHaveValue("node");
	await expect(
		settings.getByLabel("Environment variables value 1")
	).toHaveValue("••••••");
	await settings.getByLabel("Command").fill("");
	await settings
		.getByRole("button", { name: "Save changes", exact: true })
		.click();
	await expect(
		settings.getByText("Command is required for stdio servers.", {
			exact: true,
		})
	).toBeVisible();
	await expect(state.mutations).toHaveLength(0);
	await settings.getByLabel("Command").fill("cancelled-command");
	await settings.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(settings).toHaveCount(0);
	settings = await openServerSettings(page);
	await expect(settings.getByLabel("Command")).toHaveValue("node");
	await settings.getByLabel("Command").fill("node-fixture");
	await settings.getByLabel("Arguments").fill("--workspace /fixture/new-root");
	await settings.getByLabel("Description").fill("Updated fixture workspace");
	await settings.getByRole("button", { name: "Enabled", exact: true }).click();
	await settings
		.getByRole("button", { name: "Add environment variable", exact: true })
		.click();
	await settings.getByLabel("Environment variables key 2").fill("REGION");
	await settings.getByLabel("Environment variables value 2").fill("test-west");
	await settings
		.getByRole("button", { name: "Save changes", exact: true })
		.click();
	await expect(
		settings.getByText("Fixture update unavailable", { exact: true })
	).toBeVisible();
	await expect(settings.getByLabel("Command")).toHaveValue("node-fixture");
	await expect(state.mutations).toHaveLength(1);
	await expect(state.mutations[0]?.body).toEqual({
		args: ["--workspace", "/fixture/new-root"],
		command: "node-fixture",
		description: "Updated fixture workspace",
		enabled: false,
		env: { API_TOKEN: "••••••", REGION: "test-west" },
		headers: {},
		type: "stdio",
	});

	await settings
		.getByRole("button", { name: "Save changes", exact: true })
		.click();
	await expect(settings).toHaveCount(0);
	await expect(state.secrets.Workspace?.env.API_TOKEN).toBe(
		"fixture-env-secret"
	);
	await expect(
		state.servers.find((item) => item.name === "Workspace")?.enabled
	).toBe(false);
	await expect(
		state.servers.find((item) => item.name === "Workspace")?.args
	).toEqual(["--workspace", "/fixture/new-root"]);
	await capture(page, "settings-stdio-persisted.png");

	settings = await openServerSettings(page);
	await settings
		.getByRole("combobox", { name: "Transport", exact: true })
		.click();
	await page
		.getByRole("option", { name: "Streamable HTTP", exact: true })
		.click();
	await settings
		.getByRole("button", { name: "Save changes", exact: true })
		.click();
	await expect(
		settings.getByText("Endpoint URL is required for remote servers.", {
			exact: true,
		})
	).toBeVisible();
	await settings
		.getByLabel("Endpoint URL")
		.fill("ftp://fixture.invalid/workspace-mcp");
	await settings
		.getByRole("button", { name: "Save changes", exact: true })
		.click();
	await expect(
		settings.getByText("Endpoint URL must use http:// or https://.", {
			exact: true,
		})
	).toBeVisible();
	await settings
		.getByLabel("Endpoint URL")
		.fill("https://fixture.invalid/workspace-mcp");
	await settings
		.getByRole("button", { name: "Add request header", exact: true })
		.click();
	await settings.getByLabel("Request headers key 1").fill("Authorization");
	await settings
		.getByLabel("Request headers value 1")
		.fill("fixture-header-secret");
	await settings
		.getByRole("button", { name: "Save changes", exact: true })
		.click();
	await expect(settings).toHaveCount(0);
	await expect(state.mutations[2]?.body).toEqual({
		args: ["--workspace", "/fixture/new-root"],
		description: "Updated fixture workspace",
		enabled: false,
		env: { API_TOKEN: "••••••", REGION: "••••••" },
		headers: { Authorization: "fixture-header-secret" },
		type: "streamable-http",
		url: "https://fixture.invalid/workspace-mcp",
	});
	await expect(
		state.servers.find((item) => item.name === "Workspace")?.url
	).toBe("https://fixture.invalid/workspace-mcp");

	settings = await openServerSettings(page);
	await expect(settings.getByLabel("Request headers value 1")).toHaveValue(
		"••••••"
	);
	await expect(
		settings.getByLabel("Environment variables value 1")
	).toHaveValue("••••••");
	await settings.getByLabel("Description").fill("Keep fixture credentials");
	await settings
		.getByRole("button", { name: "Save changes", exact: true })
		.click();
	await expect(settings).toHaveCount(0);
	await expect(state.secrets.Workspace?.headers.Authorization).toBe(
		"fixture-header-secret"
	);
	await expect(state.secrets.Workspace?.env.API_TOKEN).toBe(
		"fixture-env-secret"
	);
	await expect(state.secrets.Workspace?.env.REGION).toBe("test-west");
	await expect(state.mutations.at(-1)?.body).toEqual({
		args: ["--workspace", "/fixture/new-root"],
		description: "Keep fixture credentials",
		enabled: false,
		env: { API_TOKEN: "••••••", REGION: "••••••" },
		headers: { Authorization: "••••••" },
		type: "streamable-http",
		url: "https://fixture.invalid/workspace-mcp",
	});

	settings = await openServerSettings(page);
	await settings
		.getByRole("button", { name: "Remove server", exact: true })
		.click();
	const confirm = page.getByRole("alertdialog", { name: "Remove Workspace?" });
	await expect(
		confirm.getByText("It does not delete an installed package.", {
			exact: false,
		})
	).toBeVisible();
	await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(confirm).toHaveCount(0);
	await expect(
		state.mutations.filter((item) => item.method === "DELETE")
	).toHaveLength(0);

	await settings
		.getByRole("button", { name: "Remove server", exact: true })
		.click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Remove server", exact: true })
		.click();
	await expect(page.getByRole("alertdialog")).toBeVisible();
	await expect(state.servers.some((item) => item.name === "Workspace")).toBe(
		true
	);
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	await expect(
		page.getByText("Fixture delete unavailable", { exact: true })
	).toBeVisible();
	await settings
		.getByRole("button", { name: "Remove server", exact: true })
		.click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Remove server", exact: true })
		.click();
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	await expect(
		page.getByRole("dialog").filter({ hasText: "Configure Workspace" })
	).toHaveCount(0);
	await expect(state.servers.some((item) => item.name === "Workspace")).toBe(
		false
	);
	await expect(
		state.mutations.filter((item) => item.method === "DELETE")
	).toHaveLength(2);
	await expect(state.mutations.at(-1)).toEqual({
		method: "DELETE",
		pathname: "/api/mcp/servers/Workspace",
	});
	await expect(page.getByRole("button", { name: /^Workspace/ })).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: /Other tools/ })
	).toBeVisible();
	await capture(page, "settings-delete-persisted.png");
	expect(pageErrors).toEqual([]);
});

test("registry load retry and tool detail JSON validation, exact call payload, failure, and retry work", async ({
	page,
}) => {
	const state = initialState();
	state.failFirstServerRead = true;
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await installFixture(page, state);
	await page.goto("/tools-library-interactions.html");
	await expect(
		page.getByText("Could not load tools", { exact: true })
	).toBeVisible();
	state.failFirstServerRead = false;
	await page.getByRole("button", { name: "Try again", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Search Docs", exact: true })
	).toBeVisible();

	await page.getByRole("button", { name: "Search Docs", exact: true }).click();
	const detail = page
		.getByRole("dialog")
		.filter({ hasText: "Search documents in the workspace" });
	await detail.getByRole("combobox", { name: "Run as", exact: true }).click();
	await page
		.getByRole("option", { name: "Operations agent", exact: true })
		.click();
	await detail.getByLabel("Arguments (JSON)").fill("{invalid json");
	await detail.getByRole("button", { name: "Test call", exact: true }).click();
	await expect(
		detail.getByText("Arguments must be valid JSON.", { exact: true })
	).toBeVisible();
	await expect(state.toolCalls).toHaveLength(0);

	await detail.getByLabel("Arguments (JSON)").fill('{"query":"release notes"}');
	await detail.getByRole("button", { name: "Test call", exact: true }).click();
	await expect(
		detail.getByText("Fixture call failed once", { exact: true })
	).toBeVisible();
	await detail.getByRole("button", { name: "Test call", exact: true }).click();
	await expect(
		detail.getByText('"fixture": "search completed"', { exact: false })
	).toBeVisible();
	await expect(state.toolCalls).toHaveLength(2);
	await expect(state.toolCalls[0]).toEqual({
		arguments: { query: "release notes" },
		agent_id: "ops-agent",
		tool: "Workspace.search_docs",
	});
	await expect(state.toolCalls[1]).toEqual(state.toolCalls[0]);
	await capture(page, "tool-detail-call-success.png");
	expect(pageErrors).toEqual([]);
});

test("tool discovery failure keeps server controls usable and refresh recovers the catalog", async ({
	page,
}) => {
	const state = initialState();
	state.failToolDiscovery = true;
	await installFixture(page, state);
	await page.goto("/tools-library-interactions.html");
	await expect(page.getByRole("alert")).toContainText(
		"Tool discovery failed. Refresh to try again."
	);
	await expect(
		page.getByRole("button", { name: "Details", exact: true }).first()
	).toBeEnabled();
	await expect(
		page.getByText("Could not load tools", { exact: true })
	).toHaveCount(0);
	state.failToolDiscovery = false;
	await page
		.getByRole("button", { name: "Refresh tools", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Search Docs", exact: true })
	).toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect
		.poll(
			() => state.toolReads.filter((read) => read === "/api/mcp/tools").length
		)
		.toBeGreaterThan(1);
});
