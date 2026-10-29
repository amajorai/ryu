import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import type { RuntimeSite } from "../../../apps-store/sites/sidecar/src/contracts.ts";
import type { SiteExtensions } from "../../../apps-store/sites/sidecar/src/extensions.ts";
import type {
	SitesCall,
	SitesProofApi,
} from "./harness/sites-companion-proof.types.ts";

declare global {
	interface Window {
		__sitesProof: SitesProofApi;
	}
}
async function mount(page: Page, reset = true): Promise<FrameLocator> {
	if (reset) {
		const response = await page.request.post("/__proof/reset", { data: {} });
		expect(response.status()).toBe(200);
	}
	await page.goto("/");
	await page.waitForSelector("body[data-harness-ready='1']");
	const appHtml = await readFile(
		path.join(tmpdir(), "ryu-sites-companion-ui-build/index.html"),
		"utf8"
	);
	await page.evaluate(
		(html) => window.__sitesProof.mount({ appHtml: html }),
		appHtml
	);
	await expect
		.poll(() => page.evaluate(() => window.__sitesProof.connected()))
		.toBe(true);
	return page.frameLocator('iframe[title="Sites proof"]');
}
async function site(page: Page, id: string): Promise<RuntimeSite> {
	const response = await page.request.get("/__proof/state");
	expect(response.status()).toBe(200);
	const projects = ((await response.json()) as { projects: RuntimeSite[] })
		.projects;
	const found = projects.find((candidate) => candidate.id === id);
	if (!found) {
		throw new Error(`Persisted Site ${id} is missing.`);
	}
	return found;
}
async function calls(
	page: Page,
	method: string,
	pathname: string
): Promise<SitesCall[]> {
	return await page.evaluate(
		({ method: verb, pathname: destination }) =>
			window.__sitesProof
				.calls()
				.filter((call) => call.method === verb && call.path === destination),
		{ method, pathname }
	);
}
async function completed(
	page: Page,
	method: string,
	pathname: string,
	count: number
): Promise<SitesCall[]> {
	await expect
		.poll(
			async () =>
				(await calls(page, method, pathname)).filter((call) => call.status > 0)
					.length
		)
		.toBe(count);
	return await calls(page, method, pathname);
}
async function create(
	companion: FrameLocator,
	page: Page,
	name: string,
	slug: string
): Promise<RuntimeSite> {
	await companion
		.getByRole("button", { name: "New site", exact: true })
		.click();
	const dialog = companion.getByRole("dialog");
	await dialog.getByLabel("Site name", { exact: true }).fill(name);
	await dialog.getByLabel("URL name", { exact: true }).fill(slug);
	await dialog
		.getByLabel("Description", { exact: true })
		.fill("Exact action regression fixture");
	const previous = (await calls(page, "POST", "/projects")).length;
	await dialog
		.getByRole("button", { name: "Create site", exact: true })
		.click();
	await expect(dialog).toBeHidden();
	const created = (await completed(page, "POST", "/projects", previous + 1)).at(
		-1
	)?.result as RuntimeSite;
	if (!created?.id) {
		throw new Error("Create action did not return a real persisted Site.");
	}
	return await site(page, created.id);
}
async function extensions(
	companion: FrameLocator,
	page: Page,
	id: string
): Promise<void> {
	await companion
		.getByRole("button", { name: "Extensions", exact: true })
		.click();
	await completed(page, "GET", `/projects/${id}/extensions`, 1);
	await expect(
		companion.getByRole("button", { name: "Save extensions", exact: true })
	).toBeEnabled();
}
async function tool(
	companion: FrameLocator,
	name: string,
	operation: string,
	description: string
): Promise<void> {
	await companion.getByLabel("Tool name", { exact: true }).fill(name);
	await companion
		.getByLabel("Tool description", { exact: true })
		.fill(description);
	await companion.getByLabel("Tool collection", { exact: true }).fill("orders");
	await companion
		.getByRole("combobox", { name: "Tool operation", exact: true })
		.click();
	await companion.getByRole("option", { name: operation, exact: true }).click();
	await companion
		.getByRole("button", { name: "Add tool", exact: true })
		.click();
}
const operations = [
	["List records", "records.list", "list_orders"],
	["Save a record", "records.set", "save_order"],
	["Delete a record", "records.delete", "delete_order"],
	["Search knowledge", "knowledge.search", "search_orders"],
] as const;
for (const [label, operation, name] of operations) {
	test(`Sites ${operation} validates tool drafts and persists the exact selected operation without enabling unavailable MCP`, async ({
		page,
	}) => {
		const companion = await mount(page);
		const original = await create(
			companion,
			page,
			`${label} action`,
			name.replaceAll("_", "-")
		);
		await extensions(companion, page, original.id);
		const endpoint = `/projects/${original.id}/extensions`;
		await expect(
			companion.getByRole("switch", { name: "Enable MCP tools", exact: true })
		).toBeDisabled();
		await tool(
			companion,
			"ryu_site_context",
			label,
			"Reserved names cannot replace the Site view tool"
		);
		await expect(companion.getByRole("alert")).toContainText(
			"unique tool name"
		);
		expect(await calls(page, "PUT", endpoint)).toEqual([]);
		expect(await site(page, original.id)).toEqual(original);
		await tool(companion, name, label, `${label} for reviewed orders`);
		await expect(companion.getByText(name, { exact: true })).toBeVisible();
		await companion
			.getByRole("button", { name: "Add another tool", exact: true })
			.click();
		await tool(
			companion,
			name,
			label,
			"A duplicate must not replace the existing tool"
		);
		await expect(companion.getByRole("alert")).toContainText(
			"unique tool name"
		);
		expect(await calls(page, "PUT", endpoint)).toEqual([]);
		await companion
			.getByRole("switch", { name: "Show Site UI in chat", exact: true })
			.click();
		const expected: SiteExtensions = {
			mcp: false,
			ui: true,
			connections: [],
			tools: [
				{
					name,
					description: `${label} for reviewed orders`,
					operation,
					collection: "orders",
				},
			],
		};
		await companion
			.getByRole("button", { name: "Save extensions", exact: true })
			.click();
		const [write] = await completed(page, "PUT", endpoint, 1);
		expect(write?.status).toBe(200);
		expect(write?.body).toEqual({
			expectedRevision: original.revision,
			extensions: expected,
		});
		const saved = await site(page, original.id);
		expect(saved.settings).toEqual({
			...original.settings,
			extensions: expected,
		});
		expect(saved.revision).toBe(original.revision + 1);
		expect(saved.versions).toEqual(original.versions);
		expect(saved.deploymentId).toBe(original.deploymentId);
		const publishedRead = await page.request.get(`/__proof/sites${endpoint}`);
		expect(publishedRead.status()).toBe(200);
		expect(
			((await publishedRead.json()) as { published: SiteExtensions }).published
		).toEqual(original.settings.extensions);
		const reopened = await mount(page, false);
		await reopened
			.getByRole("button", { name: "Open site", exact: true })
			.click();
		await extensions(reopened, page, original.id);
		await expect(reopened.getByText(name, { exact: true })).toBeVisible();
		await expect(
			reopened.getByRole("switch", {
				name: "Show Site UI in chat",
				exact: true,
			})
		).toBeChecked();
		expect(await site(page, original.id)).toEqual(saved);
		expect(await calls(page, "PUT", endpoint)).toEqual([]);
	});
}

test("Sites removing a saved tool keeps deployment unchanged, preserves the removed draft on refusal, and retries the identical revision once", async ({
	page,
}) => {
	const companion = await mount(page);
	const original = await create(
		companion,
		page,
		"Tool removal action",
		"tool-removal-action"
	);
	await extensions(companion, page, original.id);
	await tool(companion, "list_orders", "List records", "Review saved orders");
	const endpoint = `/projects/${original.id}/extensions`;
	await companion
		.getByRole("button", { name: "Save extensions", exact: true })
		.click();
	await completed(page, "PUT", endpoint, 1);
	const baseline = await site(page, original.id);
	await expect(
		companion.getByRole("button", { name: "Remove list_orders", exact: true })
	).toBeEnabled();
	await companion
		.getByRole("button", { name: "Remove list_orders", exact: true })
		.click();
	await expect(companion.getByText("list_orders", { exact: true })).toHaveCount(
		0
	);
	let release!: () => void;
	const hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(
		`**/__proof/sites${endpoint}`,
		async (route) => {
			await hold;
			await route.fulfill({
				status: 503,
				json: { error: { message: "Tool removal was refused." } },
			});
		},
		{ times: 1 }
	);
	await companion
		.getByRole("button", { name: "Save extensions", exact: true })
		.click();
	try {
		await expect
			.poll(async () => (await calls(page, "PUT", endpoint)).length)
			.toBe(2);
		const save = companion.getByRole("button", {
			name: "Save extensions",
			exact: true,
		});
		await expect(save).toBeDisabled();
		await save.click({ force: true });
		expect(await calls(page, "PUT", endpoint)).toHaveLength(2);
		expect(await site(page, original.id)).toEqual(baseline);
	} finally {
		release();
	}
	const [, refused] = await completed(page, "PUT", endpoint, 2);
	expect(refused?.status).toBe(503);
	expect(refused?.body).toEqual({
		expectedRevision: baseline.revision,
		extensions: { ...baseline.settings.extensions, tools: [] },
	});
	await expect(companion.getByRole("alert")).toContainText(
		"Tool removal was refused."
	);
	await expect(companion.getByText("list_orders", { exact: true })).toHaveCount(
		0
	);
	expect(await site(page, original.id)).toEqual(baseline);
	await companion
		.getByRole("button", { name: "Save extensions", exact: true })
		.click();
	const [, , accepted] = await completed(page, "PUT", endpoint, 3);
	expect(accepted?.status).toBe(200);
	expect(accepted?.body).toEqual(refused?.body);
	const saved = await site(page, original.id);
	expect(saved.settings.extensions.tools).toEqual([]);
	expect(saved.revision).toBe(baseline.revision + 1);
	expect(saved.versions).toEqual(baseline.versions);
	expect(saved.deploymentId).toBe(baseline.deploymentId);
	const reopened = await mount(page, false);
	await reopened
		.getByRole("button", { name: "Open site", exact: true })
		.click();
	await extensions(reopened, page, original.id);
	await expect(reopened.getByText("list_orders", { exact: true })).toHaveCount(
		0
	);
	expect(await calls(page, "PUT", endpoint)).toEqual([]);
});

test("Sites search filters names and URLs; shared scope never exposes owned records and list-card Share only changes the selected Site", async ({
	page,
}) => {
	const companion = await mount(page);
	const alpha = await create(
		companion,
		page,
		"Alpha customer guide",
		"alpha-customer-guide"
	);
	await companion
		.getByRole("button", { name: "All sites", exact: true })
		.click();
	const beta = await create(
		companion,
		page,
		"Beta operations guide",
		"beta-operations-guide"
	);
	await companion
		.getByRole("button", { name: "All sites", exact: true })
		.click();
	await companion
		.getByLabel("Search sites", { exact: true })
		.fill("ALPHA CUSTOMER");
	await expect(
		companion.getByRole("heading", { name: alpha.name, exact: true })
	).toBeVisible();
	await expect(
		companion.getByRole("heading", { name: beta.name, exact: true })
	).toHaveCount(0);
	await companion.getByLabel("Search sites", { exact: true }).fill(beta.slug);
	await expect(
		companion.getByRole("heading", { name: beta.name, exact: true })
	).toBeVisible();
	await expect(
		companion.getByRole("heading", { name: alpha.name, exact: true })
	).toHaveCount(0);
	await companion.getByLabel("Search sites", { exact: true }).fill("");
	await companion
		.getByRole("button", { name: "Shared with you", exact: true })
		.click();
	await completed(page, "GET", "/projects?scope=shared", 1);
	await expect(
		companion.getByText("Sites shared with you appear here.", { exact: true })
	).toBeVisible();
	await expect(
		companion.getByRole("heading", { name: alpha.name, exact: true })
	).toHaveCount(0);
	await expect(
		companion.getByRole("heading", { name: beta.name, exact: true })
	).toHaveCount(0);
	await companion
		.getByRole("button", { name: "Owned by you", exact: true })
		.click();
	await expect(
		companion.getByRole("heading", { name: beta.name, exact: true })
	).toBeVisible();
	const card = companion.locator("section").filter({
		has: companion.getByRole("heading", { name: alpha.name, exact: true }),
	});
	await card.getByRole("button", { name: "Share", exact: true }).click();
	const dialog = companion.getByRole("dialog", {
		name: `Share ${alpha.name}`,
		exact: true,
	});
	await dialog
		.getByRole("combobox", { name: "Who can visit", exact: true })
		.click();
	await companion
		.getByRole("option", { name: "Anyone with the link", exact: true })
		.click();
	const [write] = await completed(
		page,
		"PUT",
		`/projects/${alpha.id}/settings`,
		1
	);
	expect(write?.status).toBe(200);
	expect(write?.body).toEqual({
		expectedRevision: alpha.revision,
		settings: { ...alpha.settings, audience: "public" },
	});
	expect(await site(page, beta.id)).toEqual(beta);
	expect(await calls(page, "PUT", `/projects/${beta.id}/settings`)).toEqual([]);
});

test("Sites Copy link reports real sandbox clipboard refusal, and dismissing Share creates no hidden settings write", async ({
	page,
}) => {
	const companion = await mount(page);
	const original = await create(
		companion,
		page,
		"Clipboard refusal guide",
		"clipboard-refusal-guide"
	);
	await companion.getByRole("button", { name: "Share", exact: true }).click();
	const dialog = companion.getByRole("dialog");
	await dialog.getByRole("button", { name: "Copy link", exact: true }).click();
	await expect(dialog.getByRole("status")).toHaveText(
		"Clipboard access is unavailable"
	);
	expect(await site(page, original.id)).toEqual(original);
	expect(await calls(page, "PUT", `/projects/${original.id}/settings`)).toEqual(
		[]
	);
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	expect(await site(page, original.id)).toEqual(original);
	expect(await calls(page, "PUT", `/projects/${original.id}/settings`)).toEqual(
		[]
	);
});
