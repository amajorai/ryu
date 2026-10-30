import { expect, test } from "@playwright/test";
import {
	capture,
	initialState,
	installFixture,
	openServerSettings,
} from "./tools-library-interactions.fixture.ts";

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
	await settings.getByRole("switch", { name: /Server enabled/ }).click();
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
