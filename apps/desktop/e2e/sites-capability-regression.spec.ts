import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import type { RuntimeSite } from "../../../apps-store/sites/sidecar/src/contracts.ts";
import type { SitesProofApi } from "./harness/sites-capability-regression.types.ts";
declare global {
	interface Window {
		__sitesProof: SitesProofApi;
	}
}
interface State {
	ids: { owned: string; shared: string; hidden: string };
	projects: RuntimeSite[];
	installations: unknown[];
	installedFile: string;
	databaseCalls: Array<{ method: string; input: unknown }>;
	visitorPort: number;
}
async function state(page: Page): Promise<State> {
	const response = await page.request.get("/__proof/state");
	expect(response.status()).toBe(200);
	return await response.json();
}
async function mount(page: Page, mcp = true) {
	await page.request.post("/__proof/reset", { data: { mcp } });
	await page.goto("/");
	await page.waitForSelector("body[data-harness-ready='1']");
	const appHtml = await readFile(
		path.join(tmpdir(), "ryu-sites-capability-regression-ui-build/index.html"),
		"utf8"
	);
	await page.evaluate((input) => window.__sitesProof.mount(input), { appHtml });
	await expect
		.poll(() => page.evaluate(() => window.__sitesProof.connected()))
		.toBe(true);
	return page.frameLocator('iframe[title="Sites proof"]');
}
async function open(companion: FrameLocator) {
	await companion
		.getByRole("button", { name: "Open site", exact: true })
		.click();
	await expect(
		companion.getByRole("heading", {
			name: "Owned capability board",
			exact: true,
		})
	).toBeVisible();
}
async function panel(companion: FrameLocator) {
	await open(companion);
	await companion
		.getByRole("button", { name: "Extensions", exact: true })
		.click();
	await expect(
		companion.getByRole("button", { name: "Save extensions", exact: true })
	).toBeEnabled();
}
async function calls(page: Page, method: string, endpoint: string) {
	return await page.evaluate(
		({ method, endpoint }) =>
			window.__sitesProof
				.calls()
				.filter((call) => call.method === method && call.path === endpoint),
		{ method, endpoint }
	);
}
async function waitCalls(
	page: Page,
	method: string,
	endpoint: string,
	count: number
) {
	await expect
		.poll(
			async () =>
				(await calls(page, method, endpoint)).filter(
					(call) => call.status !== 0
				).length
		)
		.toBe(count);
	return await calls(page, method, endpoint);
}
async function owned(page: Page) {
	const snapshot = await state(page);
	const site = snapshot.projects.find(
		(candidate) => candidate.id === snapshot.ids.owned
	);
	if (!site) {
		throw new Error("Missing real persisted owner Site.");
	}
	return site;
}

for (const update of [false, true]) {
	test(`Sites ${update ? "Update installed plugin" : "Install plugin"} refuses without mutation, suppresses pending duplicates and retries the exact production manifest authority`, async ({
		page,
	}) => {
		const companion = await mount(page);
		await panel(companion);
		const baseline = await owned(page);
		const endpoint = `/projects/${baseline.id}/install-plugin`;
		const extensions = (
			await calls(page, "GET", `/projects/${baseline.id}/extensions`)
		).at(-1)?.result as { plugin: Record<string, unknown> };
		const action = companion.getByRole("button", {
			name: update ? "Update installed plugin" : "Install plugin",
			exact: true,
		});
		await page.evaluate(
			({ endpoint }) =>
				window.__sitesProof.failNext(
					"POST",
					endpoint,
					"Native installer refused this revision."
				),
			{ endpoint }
		);
		await action.click();
		const rejected = (await waitCalls(page, "POST", endpoint, 1))[0];
		expect(rejected?.status).toBe(503);
		expect(rejected?.body).toEqual({
			expectedRevision: baseline.revision,
			...(update ? { update: true } : {}),
		});
		await expect(companion.getByRole("alert")).toContainText(
			"Native installer refused this revision."
		);
		expect((await state(page)).installations).toEqual([]);
		expect(await owned(page)).toEqual(baseline);
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const route = `**/__proof/sites${endpoint}`;
		await page.route(route, async (interception) => {
			await held;
			await interception.continue();
		});
		await action.click();
		try {
			await expect
				.poll(async () => (await calls(page, "POST", endpoint)).length)
				.toBe(2);
			await expect(action).toBeDisabled();
			await action.click({ force: true });
			expect(await calls(page, "POST", endpoint)).toHaveLength(2);
			expect((await state(page)).installations).toEqual([]);
			expect(await owned(page)).toEqual(baseline);
		} finally {
			release();
		}
		const accepted = (await waitCalls(page, "POST", endpoint, 2))[1];
		expect(accepted?.status).toBe(200);
		expect(accepted?.body).toEqual(rejected?.body);
		const persisted = await state(page);
		expect(persisted.installations).toEqual([{ ...extensions.plugin, update }]);
		expect(JSON.parse(persisted.installedFile)).toEqual(
			persisted.installations
		);
		expect(await owned(page)).toEqual(baseline);
		await expect(
			companion.getByRole("status").filter({
				hasText: update
					? "Installed plugin updated. Review its connection in Plugins."
					: "Plugin installed. Review and enable it in Plugins, then connect your account.",
			})
		).toBeVisible();
		if (!update) {
			const installed = companion.getByRole("button", {
				name: "Plugin installed",
				exact: true,
			});
			await expect(installed).toBeDisabled();
			await installed.click({ force: true });
			expect(await calls(page, "POST", endpoint)).toHaveLength(2);
		}
		await page.unroute(route);
	});
}

test("Sites native manifest is the published production endpoint; real sandbox copy refusal creates no installation or hidden settings write", async ({
	page,
}) => {
	const companion = await mount(page);
	await panel(companion);
	const baseline = await owned(page);
	const snapshot = await state(page);
	const service = (
		await calls(page, "GET", `/projects/${baseline.id}/extensions`)
	).at(-1)?.result as { plugin: { mcp_servers: { site: { url: string } } } };
	const endpoint = `http://127.0.0.1:${snapshot.visitorPort}/sites/${baseline.id}/mcp`;
	expect(service.plugin.mcp_servers.site.url).toBe(endpoint);
	await expect(
		companion.getByLabel("MCP endpoint", { exact: true })
	).toHaveValue(endpoint);
	await expect(
		companion.getByLabel("MCP endpoint", { exact: true })
	).toHaveAttribute("readonly", "");
	const before = await page.evaluate(() => window.__sitesProof.calls());
	await companion
		.getByRole("button", { name: "Copy native manifest", exact: true })
		.click();
	await expect(companion.getByRole("alert")).toContainText(
		/clipboard|writeText/iu
	);
	expect(await page.evaluate(() => window.__sitesProof.calls())).toEqual(
		before
	);
	expect(await owned(page)).toEqual(baseline);
	expect((await state(page)).installations).toEqual([]);
});

test("Sites authenticated MCP and approved connection drafts save exact config, remain unpublished until actual version deployment and reload correctly", async ({
	page,
}) => {
	const companion = await mount(page, false);
	await panel(companion);
	const baseline = await owned(page);
	const enabled = {
		...baseline.settings.extensions,
		mcp: true,
		ui: true,
		connections: ["approved-read"],
	};
	await companion
		.getByRole("switch", { name: "Enable MCP tools", exact: true })
		.click();
	await companion
		.getByRole("switch", { name: "Show Site UI in chat", exact: true })
		.click();
	await companion
		.getByRole("switch", { name: "Approved read connector", exact: true })
		.click();
	await companion
		.getByRole("button", { name: "Save extensions", exact: true })
		.click();
	const write = (
		await waitCalls(page, "PUT", `/projects/${baseline.id}/extensions`, 1)
	)[0];
	expect(write?.body).toEqual({
		expectedRevision: baseline.revision,
		extensions: enabled,
	});
	const saved = await owned(page);
	expect(saved.settings.extensions).toEqual(enabled);
	expect(saved.revision).toBe(baseline.revision + 1);
	expect(saved.deploymentId).toBe(baseline.deploymentId);
	await companion
		.getByRole("button", { name: "Save version", exact: true })
		.click();
	await waitCalls(page, "POST", `/projects/${baseline.id}/versions`, 1);
	const versioned = await owned(page);
	const version = versioned.versions.at(-1);
	if (!version) {
		throw new Error("No actual saved version.");
	}
	await companion
		.getByRole("button", { name: "Deploy version", exact: true })
		.filter({ visible: true })
		.first()
		.click();
	const deployment = (
		await waitCalls(page, "POST", `/projects/${baseline.id}/deploy`, 1)
	)[0];
	expect(deployment?.body).toEqual({
		versionId: version.id,
		expectedRevision: versioned.revision,
	});
	expect((await owned(page)).deploymentId).toBe(version.id);
	await companion
		.getByRole("button", { name: "Extensions", exact: true })
		.click();
	await expect(
		companion.getByText("Published MCP plugin", { exact: true })
	).toBeVisible();
	const current = (
		await calls(page, "GET", `/projects/${baseline.id}/extensions`)
	).at(-1)?.result as { published: unknown };
	expect(current.published).toEqual(enabled);
	await page.reload();
	const appHtml = await readFile(
		path.join(tmpdir(), "ryu-sites-capability-regression-ui-build/index.html"),
		"utf8"
	);
	await page.evaluate((input) => window.__sitesProof.mount(input), { appHtml });
	await panel(companion);
	await expect(
		companion.getByRole("switch", { name: "Enable MCP tools", exact: true })
	).toHaveAttribute("aria-checked", "true");
	await expect(
		companion.getByRole("switch", {
			name: "Approved read connector",
			exact: true,
		})
	).toHaveAttribute("aria-checked", "true");
	expect(
		await calls(page, "PUT", `/projects/${baseline.id}/extensions`)
	).toEqual([]);
});

test("Sites database connection retries an exact revision, persists its real Site binding and runs actual SQLite SELECT with pending and invalid-query recovery", async ({
	page,
}) => {
	const companion = await mount(page);
	await open(companion);
	const baseline = await owned(page);
	await companion
		.getByRole("button", { name: "Database", exact: true })
		.click();
	const connect = companion.getByRole("button", {
		name: "Connect Ryu Spaces database",
		exact: true,
	});
	await expect(connect).toBeEnabled();
	const endpoint = `/projects/${baseline.id}/database/connect`;
	await page.evaluate(
		(endpoint) =>
			window.__sitesProof.failNext(
				"POST",
				endpoint,
				"Database binding refused."
			),
		endpoint
	);
	await connect.click();
	const rejected = (await waitCalls(page, "POST", endpoint, 1))[0];
	expect(rejected?.body).toEqual({ expectedRevision: baseline.revision });
	expect(await owned(page)).toEqual(baseline);
	await expect(companion.getByRole("alert")).toContainText(
		"Database binding refused."
	);
	await connect.click();
	const accepted = (await waitCalls(page, "POST", endpoint, 2))[1];
	expect(accepted?.body).toEqual(rejected?.body);
	const bound = await owned(page);
	expect(bound.settings.database).toEqual({
		spaceId: "capability-space",
		databaseId: "capability-database",
	});
	expect(bound.revision).toBe(baseline.revision + 1);
	await expect(
		companion.getByText("2 records in this Site database", { exact: true })
	).toBeVisible();
	const query = companion.getByLabel("SQL query", { exact: true });
	await query.fill("SELECT key,value FROM data ORDER BY key");
	const run = companion.getByRole("button", { name: "Run query", exact: true });
	const queryPath = `/projects/${baseline.id}/database/query`;
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const route = `**/__proof/sites${queryPath}`;
	await page.route(route, async (interception) => {
		await held;
		await interception.continue();
	});
	await run.click();
	try {
		await expect
			.poll(async () => (await calls(page, "POST", queryPath)).length)
			.toBe(1);
		await expect(
			companion.getByRole("button", { name: "Running…", exact: true })
		).toBeDisabled();
		expect(await owned(page)).toEqual(bound);
	} finally {
		release();
	}
	const sql = (await waitCalls(page, "POST", queryPath, 1))[0];
	expect(sql?.body).toEqual({
		query: "SELECT key,value FROM data ORDER BY key",
	});
	expect(sql?.result).toEqual({
		columns: ["key", "value"],
		rows: [
			["first", '{"text":"Keep rollback"}'],
			["second", '{"text":"Verify import"}'],
		],
		schema: [],
		truncated: false,
	});
	await expect(companion.getByRole("table")).toContainText("Keep rollback");
	await page.unroute(route);
	await query.fill("SELECT missing_column FROM data");
	await run.click();
	const failedSql = (await waitCalls(page, "POST", queryPath, 2))[1];
	expect(failedSql?.status).toBe(500);
	expect(failedSql?.result).toEqual({
		error: {
			code: "internal_error",
			message: "The operation could not be completed",
		},
	});
	await expect(companion.getByRole("alert")).toHaveText(
		"The operation could not be completed"
	);
	await expect(companion.getByRole("table")).toHaveCount(0);
	await query.fill("SELECT key,value FROM data ORDER BY key");
	await run.click();
	await waitCalls(page, "POST", queryPath, 3);
	await expect(companion.getByRole("table")).toContainText("Verify import");
	expect(await owned(page)).toEqual(bound);
});

test("Sites real ownership scopes exclude private third-party records; every sharing audience writes only owner record and Visit reaches trusted host", async ({
	page,
}) => {
	const companion = await mount(page);
	const original = await state(page);
	await companion
		.getByRole("button", { name: "Shared with you", exact: true })
		.click();
	await expect(
		companion.getByText("Independent shared board", { exact: true })
	).toBeVisible();
	await expect(
		companion.getByText("Owned capability board", { exact: true })
	).toHaveCount(0);
	await expect(
		companion.getByText("Uninvited private board", { exact: true })
	).toHaveCount(0);
	const sharedList = (await calls(page, "GET", "/projects?scope=shared")).at(-1)
		?.result as RuntimeSite[];
	expect(
		sharedList.map((site) => ({ id: site.id, access: site.access }))
	).toEqual([{ id: original.ids.shared, access: "viewer" }]);
	await companion
		.getByRole("button", { name: "Owned by you", exact: true })
		.click();
	await open(companion);
	await companion.getByRole("button", { name: "Share", exact: true }).click();
	const dialog = companion.getByRole("dialog");
	let previous = await owned(page);
	const endpoint = `/projects/${previous.id}/settings`;
	for (const [label, audience] of [
		["Invited viewers", "invited"],
		["Workspace", "workspace"],
		["Anyone with the link", "public"],
		["Just me", "private"],
	] as const) {
		await dialog
			.getByRole("combobox", { name: "Who can visit", exact: true })
			.click();
		await companion.getByRole("option", { name: label, exact: true }).click();
		await expect
			.poll(async () => (await owned(page)).settings.audience)
			.toBe(audience);
		const written = (await calls(page, "PUT", endpoint)).at(-1);
		expect(written?.body).toEqual({
			expectedRevision: previous.revision,
			settings: { ...previous.settings, audience },
		});
		previous = await owned(page);
		expect(previous.revision).toBe(
			(written?.body as { expectedRevision: number }).expectedRevision + 1
		);
		expect(
			(await state(page)).projects.find(
				(site) => site.id === original.ids.shared
			)
		).toEqual(
			original.projects.find((site) => site.id === original.ids.shared)
		);
	}
	const href = await dialog
		.getByRole("link", { name: "Visit", exact: true })
		.getAttribute("href");
	expect(href).toBe(
		`http://${previous.slug}.localhost:${original.visitorPort}/`
	);
	await dialog.getByRole("link", { name: "Visit", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => window.__sitesProof.openedExternal()))
		.toEqual([href]);
	expect(page.context().pages()).toHaveLength(1);
	expect(await owned(page)).toEqual(previous);
	expect(
		await calls(page, "PUT", `/projects/${original.ids.shared}/settings`)
	).toEqual([]);
});

test("Sites daily analytics distinguish repeated views and cross-day unique visitors and selected range excludes older persisted traffic", async ({
	page,
}) => {
	const companion = await mount(page);
	await open(companion);
	const baseline = await owned(page);
	await companion
		.getByRole("button", { name: "Analytics", exact: true })
		.click();
	await waitCalls(page, "GET", `/projects/${baseline.id}/analytics?days=7`, 1);
	const analytics = (
		await calls(page, "GET", `/projects/${baseline.id}/analytics?days=7`)
	).at(-1)?.result as {
		summary: unknown;
		daily: Array<{ day: string; pageViews: number; uniqueVisitors: number }>;
	};
	expect(analytics.summary).toEqual({ pageViews: 6, uniqueVisitors: 2 });
	expect(
		analytics.daily.map((row) => ({
			pageViews: row.pageViews,
			uniqueVisitors: row.uniqueVisitors,
		}))
	).toEqual([
		{ pageViews: 2, uniqueVisitors: 1 },
		{ pageViews: 4, uniqueVisitors: 2 },
	]);
	await companion.getByText("Daily counts", { exact: true }).click();
	const table = companion.getByRole("table").filter({
		has: companion.getByRole("columnheader", { name: "Day", exact: true }),
	});
	for (const row of analytics.daily) {
		await expect(
			table.getByRole("row").filter({ hasText: row.day }).getByRole("cell")
		).toHaveText([row.day, String(row.uniqueVisitors), String(row.pageViews)]);
	}
	await companion
		.getByRole("combobox", { name: "Analytics date range", exact: true })
		.click();
	await companion
		.getByRole("option", { name: "Last 30 days", exact: true })
		.click();
	const broad = (
		await waitCalls(
			page,
			"GET",
			`/projects/${baseline.id}/analytics?days=30`,
			1
		)
	)[0]?.result as { summary: unknown; daily: unknown[] };
	expect(broad.summary).toEqual({ pageViews: 15, uniqueVisitors: 3 });
	expect(broad.daily).toHaveLength(3);
	expect(await owned(page)).toEqual(baseline);
	expect(
		await page.evaluate(() =>
			window.__sitesProof.calls().filter((call) => call.method !== "GET")
		)
	).toEqual([]);
});
