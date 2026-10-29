import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("tools library shares registry reads and fetches only tools on agent filter changes", async ({
	page,
}) => {
	const calls: Record<string, number> = {};
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.route("**/api/**", async (route) => {
		const url = new URL(route.request().url());
		if (!url.pathname.startsWith("/api/")) {
			return route.continue();
		}
		const key = url.pathname + url.search;
		calls[key] = (calls[key] ?? 0) + 1;
		const payloads = new Map(
			Object.entries({
				"/api/mcp/servers": {
					servers: [
						{
							name: "Workspace",
							command: "fixture",
							enabled: true,
							available: true,
							description: "Local workspace tools",
							transport: "stdio",
						},
					],
				},
				"/api/mcp/tools": {
					tools: [
						{
							id: "Workspace.search",
							name: "Search files",
							server: "Workspace",
							description: "Find workspace documents",
							input_schema: { type: "object" },
						},
					],
				},
				"/api/mcp/tools?agent=agent-a": {
					tools: [
						{
							id: "Workspace.search",
							name: "Search files",
							server: "Workspace",
							description: "Allowed for Research agent",
							input_schema: { type: "object" },
						},
					],
				},
				"/api/agents": { agents: [{ id: "agent-a", name: "Research agent" }] },
				"/api/apps": { apps: [] },
				"/api/identities": { profiles: [] },
			})
		);
		await route.fulfill({ json: payloads.get(key) ?? {} });
	});
	await page.goto("/mcp-performance-proof.html");
	await expect(
		page.getByText("Workspace", { exact: true }).first()
	).toBeVisible();
	expect(calls["/api/mcp/servers"]).toBe(1);
	expect(calls["/api/mcp/tools"]).toBe(1);
	expect(calls["/api/agents"]).toBe(1);
	await page.getByRole("button", { name: "Add consumer", exact: true }).click();
	expect(calls["/api/mcp/servers"]).toBe(1);
	await page.getByRole("button", { name: "Filter & add", exact: true }).click();
	await page.getByRole("combobox", { name: "Allowlist", exact: true }).click();
	await page
		.getByRole("option", { name: "Research agent", exact: true })
		.click();
	await expect.poll(() => calls["/api/mcp/tools?agent=agent-a"]).toBe(1);
	expect(calls["/api/mcp/servers"]).toBe(1);
	expect(calls["/api/agents"]).toBe(1);
	await page.keyboard.press("Escape");
	expect(errors).toEqual([]);
	const dir = path.resolve(
		import.meta.dirname,
		"../../../docs/proof/performance-sweep"
	);
	await mkdir(dir, { recursive: true });
	await page.screenshot({
		path: path.join(dir, "mcp-library-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
	await writeFile(
		path.join(dir, "mcp-reads.json"),
		`${JSON.stringify({ initialConsumers: 4, initialRegistryReads: 3, warmConsumerExtraReads: 0, agentFilterExtraReads: 1, calls, scope: "Actual ToolsLibrary and MCP hooks against controlled HTTP" }, null, 2)}\n`
	);
});

test("server details open while tool discovery is pending", async ({
	page,
}) => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/api/**", async (route) => {
		const pathname = new URL(route.request().url()).pathname;
		if (!pathname.startsWith("/api/")) {
			return route.continue();
		}
		if (pathname === "/api/mcp/tools") {
			await pending;
			return route.fulfill({
				json: {
					tools: [
						{
							id: "Workspace.search",
							name: "Search files",
							server: "Workspace",
							description: "Find workspace documents",
							input_schema: { type: "object" },
						},
					],
				},
			});
		}
		const payloads = new Map(
			Object.entries({
				"/api/mcp/servers": {
					servers: [
						{
							name: "Workspace",
							command: "fixture",
							enabled: true,
							available: true,
							transport: "stdio",
						},
					],
				},
				"/api/agents": { agents: [] },
				"/api/apps": { apps: [] },
				"/api/identities": { profiles: [] },
			})
		);
		await route.fulfill({ json: payloads.get(pathname) ?? {} });
	});
	try {
		await page.goto("/mcp-performance-proof.html");
		await expect(
			page.getByText("Workspace", { exact: true }).first()
		).toBeVisible();
		await expect(
			page.getByText("This server advertises no tools.", { exact: true })
		).toHaveCount(0);
		await page.getByRole("button", { name: "Details", exact: true }).click();
		await expect(page.getByRole("dialog")).toBeVisible();
		await expect(
			page.getByRole("dialog").getByText("Loading tools…", { exact: true })
		).toBeVisible();
		release();
		await expect(
			page.getByRole("dialog").getByText("Search files", { exact: true })
		).toBeVisible();
		await page.keyboard.press("Escape");
		expect(errors).toEqual([]);
		const dir = path.resolve(
			import.meta.dirname,
			"../../../docs/proof/performance-sweep"
		);
		await mkdir(dir, { recursive: true });
		await page.screenshot({
			path: path.join(dir, "mcp-progressive-completed.png"),
			fullPage: true,
			animations: "disabled",
		});
	} finally {
		release();
		await page.unrouteAll({ behavior: "wait" });
	}
});

test("tool discovery failure leaves server controls available and can recover", async ({
	page,
}) => {
	let fail = true;
	await page.route("**/api/**", async (route) => {
		const pathname = new URL(route.request().url()).pathname;
		if (!pathname.startsWith("/api/")) {
			return route.continue();
		}
		if (pathname === "/api/mcp/tools") {
			return route.fulfill(
				fail
					? { status: 503, json: { error: "Discovery unavailable" } }
					: {
							json: {
								tools: [
									{
										id: "Workspace.search",
										name: "Search files",
										server: "Workspace",
										description: "Find workspace documents",
										input_schema: { type: "object" },
									},
								],
							},
						}
			);
		}
		const payloads = new Map(
			Object.entries({
				"/api/mcp/servers": {
					servers: [
						{
							name: "Workspace",
							command: "fixture",
							enabled: true,
							available: true,
							transport: "stdio",
						},
					],
				},
				"/api/agents": { agents: [] },
				"/api/apps": { apps: [] },
				"/api/identities": { profiles: [] },
			})
		);
		await route.fulfill({ json: payloads.get(pathname) ?? {} });
	});
	await page.goto("/mcp-performance-proof.html");
	await expect(page.getByRole("alert")).toContainText("Tool discovery failed");
	await expect(
		page.getByRole("button", { name: "Details", exact: true })
	).toBeEnabled();
	await expect(
		page.getByText("Could not load tools", { exact: true })
	).toHaveCount(0);
	fail = false;
	await page
		.getByRole("button", { name: "Refresh tools", exact: true })
		.click();
	await expect(
		page.getByText("Find workspace documents", { exact: true })
	).toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await page.unrouteAll({ behavior: "wait" });
});

test("agent edits update the shared Tools picker while engine metadata is pending", async ({
	page,
}) => {
	const calls: Record<string, number> = {};
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/**", async (route) => {
		const pathname = new URL(route.request().url()).pathname;
		if (!pathname.startsWith("/api/")) {
			return route.continue();
		}
		calls[pathname] = (calls[pathname] ?? 0) + 1;
		if (pathname === "/api/engines") {
			await pending;
		}
		const payloads = new Map(
			Object.entries({
				"/api/mcp/servers": {
					servers: [
						{
							name: "Workspace",
							command: "fixture",
							enabled: true,
							available: true,
							transport: "stdio",
						},
					],
				},
				"/api/mcp/tools": { tools: [] },
				"/api/agents": { agents: [{ id: "agent-a", name: "Research agent" }] },
				"/api/agents/agent-a": {
					agent: { id: "agent-a", name: "Updated research agent", tools: [] },
				},
				"/api/apps": { apps: [] },
				"/api/identities": { profiles: [] },
				"/api/engines": { engines: [] },
			})
		);
		await route.fulfill({ json: payloads.get(pathname) ?? {} });
	});
	try {
		await page.goto("/mcp-performance-proof.html?agents");
		await expect(
			page.getByText("Workspace", { exact: true }).first()
		).toBeVisible();
		await page
			.getByRole("button", { name: "Filter & add", exact: true })
			.click();
		await page
			.getByRole("combobox", { name: "Allowlist", exact: true })
			.click();
		await expect(
			page.getByRole("option", { name: "Research agent", exact: true })
		).toBeVisible();
		await page.keyboard.press("Escape");
		await page.keyboard.press("Escape");
		await page
			.getByRole("button", { name: "Rename research agent", exact: true })
			.click();
		await expect.poll(() => calls["/api/agents/agent-a"]).toBe(1);
		await page
			.getByRole("button", { name: "Filter & add", exact: true })
			.click();
		await page
			.getByRole("combobox", { name: "Allowlist", exact: true })
			.click();
		await expect(
			page.getByRole("option", { name: "Updated research agent", exact: true })
		).toBeVisible();
		await expect(
			page.getByRole("option", { name: "Research agent", exact: true })
		).toHaveCount(0);
		expect(calls["/api/agents"]).toBe(1);
		expect(calls["/api/mcp/servers"]).toBe(1);
		expect(calls["/api/mcp/tools"]).toBe(1);
		expect(errors).toEqual([]);
		await page.screenshot({
			path: path.resolve(
				import.meta.dirname,
				"../../../docs/proof/performance-sweep/agent-picker-shared-completed.png"
			),
			fullPage: true,
			animations: "disabled",
		});
	} finally {
		release();
		await page.unrouteAll({ behavior: "wait" });
	}
});
