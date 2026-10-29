import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("Spaces retains rows during refresh and restores a recently used node", async ({
	page,
}) => {
	const calls = { alpha: 0, beta: 0 };
	let held = false;
	let release: () => void = () => undefined;
	let cancelled = 0;
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("requestfailed", (r) => {
		if (r.url().endsWith("/alpha/api/spaces")) {
			cancelled++;
		}
	});
	await page.route("**/*", async (route) => {
		const p = new URL(route.request().url()).pathname;
		if (!/^\/(?:alpha\/|beta\/)?api\//.test(p)) {
			return route.continue();
		}
		const match = p.match(/^\/(alpha|beta)\/api\/spaces$/);
		if (match) {
			// SAFETY: the successful native RegExp match immediately above restricts capture 1 to the literal alternatives alpha or beta.
			const node = match[1] as "alpha" | "beta";
			calls[node]++;
			if (held && node === "alpha") {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			await route
				.fulfill({
					json: {
						spaces: [
							{
								id: "space",
								name: `Research ${node}`,
								description: "Workspace notes",
								document_count: 0,
								created_at: 1_700_000_000,
								updated_at: 1_700_000_000,
								retrieval_mode: "vector",
								visibility: "private",
							},
						],
					},
				})
				.catch(() => undefined);
			return;
		}
		await route.fulfill({
			json: p.endsWith("/api/backups")
				? { destinations: [], policies: [], operations: [] }
				: {},
		});
	});
	await page.goto("/spaces-performance-proof.html");
	await expect(
		page.getByText("Research alpha", { exact: true }).first()
	).toBeVisible();
	expect(calls.alpha).toBe(1);
	held = true;
	await page.getByRole("button", { name: "Refresh list", exact: true }).click();
	await expect.poll(() => calls.alpha).toBe(2);
	await expect(
		page.getByText("Research alpha", { exact: true }).first()
	).toBeVisible();
	await page.getByRole("button", { name: "Beta node", exact: true }).click();
	await expect(
		page.getByText("Research beta", { exact: true }).first()
	).toBeVisible();
	await expect.poll(() => cancelled).toBe(1);
	held = false;
	release();
	await expect(page.getByText("Research alpha", { exact: true })).toHaveCount(
		0
	);
	await page.getByRole("button", { name: "Alpha node", exact: true }).click();
	await expect(
		page.getByText("Research alpha", { exact: true }).first()
	).toBeVisible();
	expect(calls.alpha).toBe(2);
	expect(calls.beta).toBe(1);
	expect(errors).toEqual([]);
	const dir = path.resolve(
		import.meta.dirname,
		"../../../docs/proof/performance-sweep"
	);
	await mkdir(dir, { recursive: true });
	await page.screenshot({
		path: path.join(dir, "spaces-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
	await writeFile(
		path.join(dir, "spaces-reads.json"),
		`${JSON.stringify({ calls, cancelled, rowsRetainedDuringRefresh: true, returnToRecentNodeExtraReads: 0, scope: "Actual SpacesPage/provider against controlled HTTP" }, null, 2)}\n`
	);
});

test("folder preview content is never reused across nodes with identical document ids", async ({
	page,
}) => {
	const reads = { alpha: 0, beta: 0 };
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/*", async (route) => {
		const path = new URL(route.request().url()).pathname;
		const match = path.match(/^\/(alpha|beta)\/api\/spaces(.*)$/);
		if (match) {
			// SAFETY: the successful native RegExp match immediately above restricts capture 1 to the literal alternatives alpha or beta.
			const node = match[1] as "alpha" | "beta";
			const tail = match[2];
			const document = {
				id: "shared-doc",
				space_id: "space",
				title: "Shared document",
				kind: "page",
				chunk_count: 1,
				created_at: 1,
				updated_at: 2,
			};
			if (!tail) {
				return route.fulfill({
					json: {
						spaces: [
							{
								id: "space",
								name: `Research ${node}`,
								description: "Preview scope",
								document_count: 1,
								created_at: 1,
								updated_at: 2,
								retrieval_mode: "vector",
								visibility: "private",
							},
						],
					},
				});
			}
			if (tail === "/space/documents") {
				return route.fulfill({ json: { documents: [document] } });
			}
			if (tail === "/space/documents/shared-doc") {
				reads[node]++;
				return route.fulfill({
					json: { ...document, source: `Only ${node} content` },
				});
			}
		}
		if (/^\/(?:alpha\/|beta\/)?api\//.test(path)) {
			return route.fulfill({ json: {} });
		}
		return route.continue();
	});
	await page.goto("/spaces-performance-proof.html?previews");
	await expect.poll(() => reads.alpha).toBe(1);
	await page.getByRole("button", { name: "Beta node", exact: true }).click();
	await expect.poll(() => reads.beta).toBe(1);
	await expect(
		page.getByText("Research beta", { exact: true }).first()
	).toBeVisible();
	await page
		.getByRole("button", { name: "Research beta", exact: true })
		.click();
	await expect(
		page.getByRole("dialog").getByText("Only beta content", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Only alpha content", { exact: true })
	).toHaveCount(0);
	expect(errors).toEqual([]);
	const dir = path.resolve(
		import.meta.dirname,
		"../../../docs/proof/performance-sweep"
	);
	await mkdir(dir, { recursive: true });
	await page.screenshot({
		path: path.join(dir, "space-preview-cache-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("backup reads do not overlap or leak across target switches", async ({
	page,
}) => {
	let alphaReads = 0;
	let releaseOverview: () => void = () => undefined;
	let releaseBrowse: () => void = () => undefined;
	let browseStarted = false;
	let canceled = 0;
	page.on("requestfailed", (request) => {
		if (request.url().includes("/api/backups")) {
			canceled++;
		}
	});
	await page.route("**/*", async (route) => {
		const pathname = new URL(route.request().url()).pathname;
		const match = pathname.match(/^\/(alpha|beta)\/api\/backups(.*)$/);
		if (match) {
			const node = match[1];
			if (!match[2]) {
				if (node === "alpha" && ++alphaReads === 2) {
					await new Promise<void>((resolve) => {
						releaseOverview = resolve;
					});
				}
				await route
					.fulfill({
						json: {
							destinations: [
								{
									id: "destination",
									name: `${node} storage`,
									endpoint: "https://storage.example",
									bucket: "backups",
									region: "test",
									prefix: "",
									pathStyle: true,
									allowHttp: false,
									allowedApps: [],
									createdAt: "2026-09-12T00:00:00Z",
								},
							],
							policies: [],
							operations:
								node === "alpha"
									? [
											{
												id: "running",
												action: "backup",
												scope: { kind: "node" },
												destinationId: "destination",
												status: alphaReads >= 3 ? "completed" : "running",
												createdAt: "2026-09-12T00:00:00Z",
											},
										]
									: [],
						},
					})
					.catch(() => undefined);
				return;
			}
			if (match[2].endsWith("/backups")) {
				browseStarted = true;
				await new Promise<void>((resolve) => {
					releaseBrowse = resolve;
				});
				await route
					.fulfill({
						json: [
							{
								id: "old-beta-snapshot",
								objectKey: "old-beta-snapshot",
								scope: { kind: "node" },
								bytes: 100,
								sha256: "abc",
								version: 1,
								createdAt: "2026-09-12T00:00:00Z",
							},
						],
					})
					.catch(() => undefined);
				return;
			}
			throw new Error("Unexpected backup mutation in read-only proof");
		}
		if (/^\/(?:alpha\/|beta\/)?api\//.test(pathname)) {
			return route.fulfill({
				json: pathname.endsWith("/spaces") ? { spaces: [] } : {},
			});
		}
		return route.continue();
	});
	await page.clock.install();
	try {
		await page.goto("/spaces-performance-proof.html?backups");
		await expect(
			page.getByText("alpha storage", { exact: true }).first()
		).toBeVisible();
		await page.clock.fastForward(1600);
		await expect.poll(() => alphaReads).toBe(2);
		await page.clock.fastForward(6000);
		expect(alphaReads).toBe(2);
		await page.getByRole("button", { name: "Beta node", exact: true }).click();
		await expect(
			page.getByText("beta storage", { exact: true }).first()
		).toBeVisible();
		releaseOverview();
		await page
			.getByRole("button", { name: "Browse backups", exact: true })
			.press("Enter");
		await expect.poll(() => browseStarted).toBe(true);
		await page.getByRole("button", { name: "Alpha node", exact: true }).click();
		await expect(
			page.getByText("alpha storage", { exact: true }).first()
		).toBeVisible();
		releaseBrowse();
		await expect.poll(() => canceled).toBeGreaterThanOrEqual(2);
		await expect(
			page.getByText("old-beta-snapshot", { exact: false })
		).toHaveCount(0);
		await expect(page.getByRole("alert")).toHaveCount(0);
		await expect(page.getByText("Completed", { exact: true })).toBeVisible();
		const dir = path.resolve(
			import.meta.dirname,
			"../../../docs/proof/performance-sweep"
		);
		await page.screenshot({
			path: path.join(dir, "backup-scope-completed.png"),
			fullPage: true,
			animations: "disabled",
		});
	} finally {
		releaseOverview();
		releaseBrowse();
		await page.unrouteAll({ behavior: "wait" });
	}
});

test("offscreen folders defer document reads until approached", async ({
	page,
}) => {
	const reads = { alpha: 0, beta: 0 };
	let lists = 0;
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/*", async (route) => {
		const path = new URL(route.request().url()).pathname;
		const match = path.match(/^\/(alpha|beta)\/api\/spaces(.*)$/);
		if (match) {
			// SAFETY: the successful native RegExp match immediately above restricts capture 1 to the literal alternatives alpha or beta.
			const node = match[1] as "alpha" | "beta";
			const tail = match[2];
			const document = {
				id: "shared-doc",
				space_id: "space",
				title: "Shared document",
				kind: "page",
				chunk_count: 1,
				created_at: 1,
				updated_at: 2,
			};
			if (!tail) {
				return route.fulfill({
					json: {
						spaces: [
							{
								id: "space",
								name: `Research ${node}`,
								description: "Preview scope",
								document_count: 1,
								created_at: 1,
								updated_at: 2,
								retrieval_mode: "vector",
								visibility: "private",
							},
						],
					},
				});
			}
			if (tail === "/space/documents") {
				lists++;
				return route.fulfill({ json: { documents: [document] } });
			}
			if (tail === "/space/documents/shared-doc") {
				reads[node]++;
				return route.fulfill({
					json: { ...document, source: `Only ${node} content` },
				});
			}
		}
		if (/^\/(?:alpha\/|beta\/)?api\//.test(path)) {
			return route.fulfill({ json: {} });
		}
		return route.continue();
	});
	await page.goto("/spaces-performance-proof.html?previews&offscreen");
	const folder = page.getByRole("button", {
		name: "Research alpha",
		exact: true,
	});
	await expect(folder).toBeAttached();
	// Sample several observer frames before asserting no offscreen reads.
	await page.waitForTimeout(250);
	expect(lists).toBe(0);
	expect(reads.alpha).toBe(0);
	await folder.scrollIntoViewIfNeeded();
	await expect.poll(() => reads.alpha).toBe(1);
	await folder.click();
	await expect(
		page.getByRole("dialog").getByText("Only alpha content", { exact: true })
	).toBeVisible();
	await page.keyboard.press("Escape");
	await page.evaluate(() => window.scrollTo(0, 0));
	await folder.scrollIntoViewIfNeeded();
	await folder.click();
	await expect(
		page.getByRole("dialog").getByText("Only alpha content", { exact: true })
	).toBeVisible();
	expect(lists).toBe(1);
	expect(reads.alpha).toBe(1);
	expect(errors).toEqual([]);
	const dir = path.resolve(
		import.meta.dirname,
		"../../../docs/proof/performance-sweep"
	);
	await mkdir(dir, { recursive: true });
	await expect(page.getByRole("dialog")).toHaveCSS("transform", "none");
	await expect
		.poll(() =>
			page
				.getByRole("dialog")
				.evaluate((element) => getComputedStyle(element.parentElement!).opacity)
		)
		.toBe("1");
	await page.screenshot({
		path: path.join(dir, "space-preview-viewport-completed.png"),
		fullPage: false,
		animations: "disabled",
	});
});

test("folder and chat mentions share an in-flight document list", async ({
	page,
}) => {
	const reads = { alpha: 0, beta: 0 };
	let lists = 0;
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/*", async (route) => {
		const path = new URL(route.request().url()).pathname;
		const match = path.match(/^\/(alpha|beta)\/api\/spaces(.*)$/);
		if (match) {
			// SAFETY: the successful native RegExp match immediately above restricts capture 1 to the literal alternatives alpha or beta.
			const node = match[1] as "alpha" | "beta";
			const tail = match[2];
			const document = {
				id: "shared-doc",
				space_id: "space",
				title: "Shared document",
				kind: "page",
				chunk_count: 1,
				created_at: 1,
				updated_at: 2,
			};
			if (!tail) {
				return route.fulfill({
					json: {
						spaces: [
							{
								id: "space",
								name: `Research ${node}`,
								description: "Preview scope",
								document_count: 1,
								created_at: 1,
								updated_at: 2,
								retrieval_mode: "vector",
								visibility: "private",
							},
						],
					},
				});
			}
			if (tail === "/space/documents") {
				lists++;
				await pending;
				return route.fulfill({ json: { documents: [document] } });
			}
			if (tail === "/space/documents/shared-doc") {
				reads[node]++;
				return route.fulfill({
					json: { ...document, source: `Only ${node} content` },
				});
			}
		}
		if (/^\/(?:alpha\/|beta\/)?api\//.test(path)) {
			return route.fulfill({ json: {} });
		}
		return route.continue();
	});
	try {
		await page.goto("/spaces-performance-proof.html?previews&mentions");
		await expect(
			page.getByRole("button", { name: "Research alpha", exact: true })
		).toBeVisible();
		await expect(page.getByLabel("Mention pages")).toHaveText(
			"0 mention pages"
		);
		await expect.poll(() => lists).toBe(1);
		await page.waitForTimeout(250);
		expect(lists).toBe(1);
		release();
		await expect(page.getByLabel("Mention pages")).toHaveText(
			"1 mention pages"
		);
		await expect.poll(() => reads.alpha).toBe(1);
		await page
			.getByRole("button", { name: "Research alpha", exact: true })
			.click();
		await expect(
			page.getByRole("dialog").getByText("Only alpha content", { exact: true })
		).toBeVisible();
		await expect(page.getByRole("dialog")).toHaveCSS("transform", "none");
		await expect
			.poll(() =>
				page
					.getByRole("dialog")
					.evaluate(
						(element) => getComputedStyle(element.parentElement!).opacity
					)
			)
			.toBe("1");
		expect(lists).toBe(1);
		expect(errors).toEqual([]);
		const dir = path.resolve(
			import.meta.dirname,
			"../../../docs/proof/performance-sweep"
		);
		await mkdir(dir, { recursive: true });
		await page.screenshot({
			path: path.join(dir, "space-document-list-shared-completed.png"),
			fullPage: true,
			animations: "disabled",
		});
	} finally {
		release();
		await page.unrouteAll({ behavior: "wait" });
	}
});
