import { expect, test } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

function card(name: string, source = "huggingface") {
	return {
		id: name,
		name,
		source,
		author: null,
		description: "Catalog result",
		downloads: null,
		likes: null,
		homepage: null,
		install: null,
		tags: [],
		updatedAt: null,
	};
}
test("Web Store shares reads, reuses a warm tab and cancels obsolete catalog loads", async ({
	page,
}) => {
	const reads = { models: 0, mcp: 0 };
	const cancelled: string[] = [];
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("requestfailed", (request) => {
		if (request.url().includes("/api/catalog/")) {
			cancelled.push(request.url());
		}
	});
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/**", async (route) => {
		const url = new URL(route.request().url());
		if (!url.pathname.startsWith("/api/")) {
			return route.continue();
		}
		if (url.pathname === "/api/catalog/models") {
			reads.models++;
			return route.fulfill({ json: { items: [card("Cached model")] } });
		}
		if (url.pathname === "/api/catalog/mcp") {
			const index = ++reads.mcp;
			if (index === 1) {
				await pending;
			}
			return route.fulfill({
				json: {
					items: [
						card(
							index === 1 ? "Obsolete tools" : "Current tools",
							"mcp-registry"
						),
					],
				},
			});
		}
		return route.fulfill({ json: {} });
	});
	try {
		await page.goto("/web-catalog-performance-proof.html");
		await expect(
			page.getByText("Cached model", { exact: true }).first()
		).toBeVisible();
		await page.getByRole("button", { name: "Add reader", exact: true }).click();
		expect(reads.models).toBe(1);
		await page.getByRole("button", { name: "MCP", exact: true }).click();
		await expect.poll(() => reads.mcp).toBe(1);
		await expect(page.getByText("Cached model", { exact: true })).toHaveCount(
			0
		);
		await page.getByRole("button", { name: "Models", exact: true }).click();
		await expect(
			page.getByText("Cached model", { exact: true }).first()
		).toBeVisible();
		await expect.poll(() => cancelled.length).toBe(1);
		expect(reads.models).toBe(1);
		await page.getByRole("button", { name: "MCP", exact: true }).click();
		await expect(
			page.getByText("Current tools", { exact: true }).first()
		).toBeVisible();
		release();
		await page.waitForTimeout(50);
		await expect(page.getByText("Obsolete tools", { exact: true })).toHaveCount(
			0
		);
		expect(errors).toEqual([]);
		await page.screenshot({
			path: proofEvidencePath(
				"performance-sweep/web-catalog-cache-completed.png"
			),
			fullPage: true,
			animations: "disabled",
		});
	} finally {
		release();
		await page.unrouteAll({ behavior: "wait" });
	}
});

test("a superseded catalog search cannot replace current results", async ({
	page,
}) => {
	const queries: string[] = [];
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/**", async (route) => {
		const url = new URL(route.request().url());
		if (!url.pathname.startsWith("/api/")) {
			return route.continue();
		}
		if (url.pathname === "/api/catalog/models") {
			const query = url.searchParams.get("query") ?? "";
			queries.push(query);
			if (query === "old") {
				await pending;
			}
			return route.fulfill({
				json: {
					items: [
						card(
							query === "old"
								? "Obsolete search"
								: query === "new"
									? "Current search"
									: "Initial result"
						),
					],
				},
			});
		}
		return route.fulfill({ json: {} });
	});
	try {
		await page.goto("/web-catalog-performance-proof.html");
		await expect(
			page.getByText("Initial result", { exact: true }).first()
		).toBeVisible();
		await page.getByRole("button", { name: "Search", exact: true }).click();
		const input = page.getByPlaceholder("Search catalog…");
		await input.fill("old");
		await expect.poll(() => queries.includes("old")).toBe(true);
		await input.fill("new");
		await expect(
			page.getByText("Current search", { exact: true }).first()
		).toBeVisible();
		release();
		await input.fill("  new  ");
		await page.waitForTimeout(450);
		expect(queries).toEqual(["", "old", "new"]);
		await expect(
			page.getByText("Obsolete search", { exact: true })
		).toHaveCount(0);
		await expect(
			page.getByText("Current search", { exact: true }).first()
		).toBeVisible();
	} finally {
		release();
		await page.unrouteAll({ behavior: "wait" });
	}
});

test("universal search shows ready groups and cancels all pending groups when cleared", async ({
	page,
}) => {
	let releaseModel!: () => void;
	let releaseOthers!: () => void;
	const model = new Promise<void>((resolve) => {
		releaseModel = resolve;
	});
	const others = new Promise<void>((resolve) => {
		releaseOthers = resolve;
	});
	let calls = 0;
	let cancelled = 0;
	page.on("requestfailed", (request) => {
		if (/\/api\/(catalog\/|marketplace\/catalog)/.test(request.url())) {
			cancelled++;
		}
	});
	await page.route("**/api/**", async (route) => {
		const url = new URL(route.request().url());
		if (!url.pathname.startsWith("/api/")) {
			return route.continue();
		}
		if (/^\/api\/(catalog\/|marketplace\/catalog)/.test(url.pathname)) {
			calls++;
			await (url.pathname.endsWith("/models") ? model : others);
			return route.fulfill({
				json: {
					items: url.pathname.endsWith("/models") ? [card("Claude model")] : [],
				},
			});
		}
		return route.fulfill({ json: {} });
	});
	try {
		await page.goto("/web-catalog-performance-proof.html?universal");
		const input = page.getByRole("textbox", { name: "Search the Store" });
		await input.fill("claude");
		await expect.poll(() => calls).toBe(4);
		await expect(
			page.getByText("Claude Code", { exact: true }).first()
		).toBeVisible();
		releaseModel();
		await expect(
			page.getByText("Claude model", { exact: true }).first()
		).toBeVisible();
		await page.screenshot({
			path: proofEvidencePath(
				"performance-sweep/universal-search-progressive-completed.png"
			),
			fullPage: true,
			animations: "disabled",
		});
		await input.fill("");
		await expect.poll(() => cancelled).toBe(3);
		releaseOthers();
		await expect(page.getByText("Claude model", { exact: true })).toHaveCount(
			0
		);
		await expect(
			page.getByText("Search the Store", { exact: true })
		).toBeVisible();
	} finally {
		releaseModel();
		releaseOthers();
		await page.unrouteAll({ behavior: "wait" });
	}
});

test("following-only universal search skips unrelated federated catalogs", async ({
	page,
}) => {
	const calls: string[] = [];
	await page.route("**/api/**", async (route) => {
		const url = new URL(route.request().url());
		if (!url.pathname.startsWith("/api/")) {
			return route.continue();
		}
		calls.push(url.pathname);
		await route.fulfill({ json: { items: [] } });
	});
	await page.goto("/web-catalog-performance-proof.html?universal&following");
	await page.getByRole("textbox", { name: "Search the Store" }).fill("claude");
	await expect(page.getByText("Nothing found", { exact: true })).toBeVisible();
	expect(
		calls.filter((value) => value.startsWith("/api/catalog/")).length
	).toBe(0);
	expect(
		calls.filter((value) => value === "/api/marketplace/catalog")
	).toHaveLength(1);
});

test("catalog and Staff Picks coalesce refreshes and cancel superseded or closed reads", async ({
	page,
}) => {
	const calls: string[] = [];
	let cancelled = 0;
	let holdCurrent = false;
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	page.on("requestfailed", (request) => {
		if (/\/api\/marketplace\/(catalog|featured)/.test(request.url())) {
			cancelled++;
		}
	});
	await page.route("**/api/**", async (route) => {
		const url = new URL(route.request().url());
		if (!url.pathname.startsWith("/api/")) {
			return route.continue();
		}
		if (/\/marketplace\/(catalog|featured)$/.test(url.pathname)) {
			const kind = url.searchParams.get("kind");
			calls.push(`${url.pathname}:${kind}`);
			if (kind === "plugin" || holdCurrent) {
				await pending;
			}
			const name = `${kind === "plugin" ? "Old" : "Current"} ${url.pathname.endsWith("featured") ? "pick" : "catalog"}`;
			return route.fulfill({
				json: {
					items: [
						{
							id: name,
							name,
							kind,
							description: "Marketplace listing",
							author: null,
						},
					],
				},
			});
		}
		return route.fulfill({ json: {} });
	});
	try {
		await page.goto("/web-catalog-performance-proof.html?marketplace-lists");
		await expect.poll(() => calls.length).toBe(2);
		await page
			.getByRole("button", { name: "Refresh lists", exact: true })
			.click();
		expect(calls).toHaveLength(2);
		await page
			.getByRole("button", { name: "Skills catalog", exact: true })
			.click();
		await expect.poll(() => cancelled).toBe(2);
		await expect(
			page.getByText("Current catalog", { exact: true })
		).toBeVisible();
		await expect(page.getByText("Current pick", { exact: true })).toBeVisible();
		expect(calls).toHaveLength(4);
		await page.screenshot({
			path: proofEvidencePath(
				"performance-sweep/marketplace-lists-completed.png"
			),
			fullPage: true,
			animations: "disabled",
		});
		holdCurrent = true;
		await page
			.getByRole("button", { name: "Refresh lists", exact: true })
			.click();
		await expect.poll(() => calls.length).toBe(6);
		await page
			.getByRole("button", { name: "Close lists", exact: true })
			.click();
		await expect.poll(() => cancelled).toBe(4);
		release();
		await expect(page.getByText("Old catalog", { exact: true })).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Open lists", exact: true })
		).toBeVisible();
	} finally {
		release();
		await page.unrouteAll({ behavior: "wait" });
	}
});
