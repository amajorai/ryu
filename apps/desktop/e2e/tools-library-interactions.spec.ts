import { expect, test } from "@playwright/test";
import {
	capture,
	initialState,
	installFixture,
	openAddDialog,
} from "./tools-library-interactions.fixture.ts";

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
