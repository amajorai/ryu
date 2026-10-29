import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

interface CapturedRequest {
	auth: string | null;
	body: unknown;
	method: string;
	origin: string;
	path: string;
	status: number | null;
}

interface MemoryFixtureRow {
	category: string;
	content: string;
	id: string;
	importance: number;
	scope: string;
	scope_id: string | null;
	tags: string[];
	when_to_use: string | null;
}

interface MemoryLibrarySnapshot {
	memories: MemoryFixtureRow[];
	preferences: Record<string, string>;
	requests: CapturedRequest[];
	unexpected: string[];
}

interface MemoryLibraryWindow extends Window {
	__memoryLibraryProof: {
		armFailure: (method: string, path: string, status?: number) => void;
		snapshot: () => MemoryLibrarySnapshot;
	};
}

const evidenceDir =
	process.env.RYU_MEMORY_LIBRARY_PROOF_DIR ??
	path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence"
	);
const evidence = (name: string) => {
	mkdirSync(evidenceDir, { recursive: true });
	return path.resolve(evidenceDir, name);
};
const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(async ({ page }, info) => {
	await expect.soft
		.poll(async () => (await snapshot(page)).preferences)
		.toEqual({
			"entitlement-active": "true",
			"managed-inference-entitled": "false",
		});
	const current = await snapshot(page);
	const errors = pageErrors.get(page) ?? [];
	writeFileSync(
		evidence(`${info.title.replace(/[^a-z0-9]+/gi, "-")}-contracts.json`),
		JSON.stringify({ ...current, pageErrors: errors }, null, 2)
	);
	expect(
		current.unexpected,
		"all API methods/paths, node origin and bearer auth must match the fixture"
	).toEqual([]);
	expect(errors, "uncaught production page errors").toEqual([]);
});

async function snapshot(page: Page): Promise<MemoryLibrarySnapshot> {
	return await page.evaluate(() =>
		/* SAFETY: memory-library-proof.tsx installs __memoryLibraryProof before this proof page is evaluated. */ (
			window as MemoryLibraryWindow
		).__memoryLibraryProof.snapshot()
	);
}

async function armFailure(
	page: Page,
	method: string,
	path: string,
	status = 503
): Promise<void> {
	await page.evaluate(
		({ requestMethod, requestPath, responseStatus }) =>
			/* SAFETY: memory-library-proof.tsx installs __memoryLibraryProof before this proof page is evaluated. */ (
				window as MemoryLibraryWindow
			).__memoryLibraryProof.armFailure(
				requestMethod,
				requestPath,
				responseStatus
			),
		{ requestMethod: method, requestPath: path, responseStatus: status }
	);
}

async function openLibrary(
	page: Page,
	url = "/memory-library-proof.html?reset=true"
): Promise<void> {
	await page.goto(url);
	await expect(
		page.getByRole("heading", { name: "Memory", exact: true })
	).toBeVisible();
}

async function chooseOption(
	page: Page,
	label: string,
	option: string | RegExp
): Promise<void> {
	await page.getByRole("combobox", { name: label }).click();
	await page.getByRole("option", { name: option }).click();
}

test.describe.configure({ timeout: 60_000 });

test("loads and filters memories, recovers from a Core read error, and switches views", async ({
	page,
}) => {
	await openLibrary(
		page,
		"/memory-library-proof.html?reset=true&fail-list-once=true"
	);
	await expect(
		page.getByText("Couldn't load memories", { exact: true }).first()
	).toBeVisible();
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(
		page.getByText("Project Atlas ships on Fridays", { exact: true })
	).toBeVisible();

	await page.getByLabel("Search memories").fill("atlas");
	await chooseOption(page, "Filter by scope", "This project");
	await chooseOption(page, "Filter by category", "About this project");
	await chooseOption(page, "Filter by tag", "#release");
	await expect(
		page.getByText("Project Atlas ships on Fridays", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Prefers concise code reviews", { exact: true })
	).toHaveCount(0);
	await page.getByLabel("Search memories").fill("no such memory");
	await expect(page.getByText("No matches", { exact: true })).toBeVisible();

	// Navigation only: this fixture deliberately has no graph nodes or edges.
	await page.getByRole("tab", { name: "Graph" }).click();
	await expect(page.getByRole("tab", { name: "Graph" })).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await page.getByRole("tab", { name: "Library" }).click();
	await expect(page.getByRole("tab", { name: "Library" })).toHaveAttribute(
		"aria-selected",
		"true"
	);

	const current = await snapshot(page);
	expect(
		current.requests
			.filter(
				(request) => request.path === "/api/memory" && request.method === "GET"
			)
			.map((request) => request.status)
	).toEqual([503, 200]);
	expect(
		current.requests
			.filter((request) => request.path.startsWith("/api/memory/graph"))
			.map((request) => ({
				method: request.method,
				path: request.path,
				status: request.status,
			}))
	).toEqual([
		{
			method: "GET",
			path: "/api/memory/graph",
			status: 200,
		},
	]);
	await expect(page.getByText("No matches", { exact: true })).toBeVisible();
});

test("creates a classified memory with validated defaults, exact metadata, and reload persistence", async ({
	page,
}) => {
	await openLibrary(page);
	await page.getByRole("button", { name: "New memory" }).first().click();
	const dialog = page.getByRole("dialog", { name: "New memory" });
	await expect(dialog).toBeVisible();
	const create = dialog.getByRole("button", { name: "Create memory" });
	await expect(create).toBeDisabled();
	await page
		.getByLabel("Memory", { exact: true })
		.fill("Abandoned create draft");
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toBeHidden();
	expect(
		(await snapshot(page)).requests.filter(
			(request) => request.path === "/api/memory" && request.method === "POST"
		)
	).toHaveLength(0);
	await page.getByRole("button", { name: "New memory" }).first().click();
	await expect(page.getByLabel("Memory", { exact: true })).toHaveValue("");

	await page
		.getByLabel("Memory", { exact: true })
		.fill("  Releases happen every Friday.  ");
	await chooseOption(page, "Scope", "This project");
	await page.getByLabel("Project id").fill(" atlas ");
	await chooseOption(page, "Category", "Preference");
	await chooseOption(page, "Importance", "4 — High");
	await page
		.getByLabel("When to use (optional)")
		.fill("  When planning a release  ");
	await page.getByLabel("Tags (optional)").fill(" release, planning, release ");
	await expect(create).toBeEnabled();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("desktop-memory-library-editor-create.png"),
	});
	await armFailure(page, "POST", "/api/memory", 503);
	await create.click();
	await expect(dialog.getByText("/api/memory failed: 503")).toBeVisible();
	await expect(page.getByLabel("Memory", { exact: true })).toHaveValue(
		"  Releases happen every Friday.  "
	);
	await create.click();
	await expect(dialog).toBeHidden();
	await expect(
		page.getByText("Releases happen every Friday.", { exact: true })
	).toBeVisible();

	const saved = await snapshot(page);
	expect(
		saved.requests
			.filter(
				(request) => request.path === "/api/memory" && request.method === "POST"
			)
			.map((request) => ({ body: request.body, status: request.status }))
	).toEqual([
		{
			body: {
				category: "preference",
				content: "Releases happen every Friday.",
				importance: 4,
				scope: "project",
				scope_id: "atlas",
				tags: ["release", "planning"],
				when_to_use: "When planning a release",
			},
			status: 503,
		},
		{
			body: {
				category: "preference",
				content: "Releases happen every Friday.",
				importance: 4,
				scope: "project",
				scope_id: "atlas",
				tags: ["release", "planning"],
				when_to_use: "When planning a release",
			},
			status: 201,
		},
	]);
	expect(saved.memories[0]).toMatchObject({
		category: "preference",
		content: "Releases happen every Friday.",
		importance: 4,
		scope: "project",
		scope_id: "atlas",
		tags: ["release", "planning"],
		when_to_use: "When planning a release",
	});
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("desktop-memory-library-created.png"),
	});

	await page.reload();
	await expect(
		page.getByText("Releases happen every Friday.", { exact: true })
	).toBeVisible();
	expect((await snapshot(page)).memories[0].scope_id).toBe("atlas");
});

test("cancels an edit without leaking its draft, preserves failed updates, retries, and reloads the saved metadata", async ({
	page,
}) => {
	await openLibrary(page);
	const original = page.getByText("Project Atlas ships on Fridays", {
		exact: true,
	});
	const row = page.locator("li").filter({ has: original });
	await row.getByRole("button", { name: "Edit memory" }).click();
	let dialog = page.getByRole("dialog", { name: "Edit memory" });
	await expect(page.getByLabel("Memory", { exact: true })).toHaveValue(
		"Project Atlas ships on Fridays"
	);
	await page
		.getByLabel("Memory", { exact: true })
		.fill("Discard this edit draft");
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	await row.getByRole("button", { name: "Edit memory" }).click();
	dialog = page.getByRole("dialog", { name: "Edit memory" });
	await expect(page.getByLabel("Memory", { exact: true })).toHaveValue(
		"Project Atlas ships on Fridays"
	);

	await page
		.getByLabel("Memory", { exact: true })
		.fill("Atlas release date is Friday");
	await chooseOption(page, "Scope", "Just me");
	await chooseOption(page, "Category", "Preference");
	await chooseOption(page, "Importance", "4 — High");
	await page.getByLabel("When to use (optional)").fill("");
	await page.getByLabel("Tags (optional)").fill("  work, work, planning ");
	const patch = {
		category: "preference",
		content: "Atlas release date is Friday",
		importance: 4,
		scope: "user",
		scope_id: null,
		tags: ["work", "planning"],
		when_to_use: null,
	};
	await armFailure(page, "PUT", "/api/memory/memory-atlas-release", 503);
	await dialog.getByRole("button", { name: "Save changes" }).click();
	await expect(
		dialog.getByText("/api/memory/memory-atlas-release failed: 503")
	).toBeVisible();
	await expect(page.getByLabel("Memory", { exact: true })).toHaveValue(
		"Atlas release date is Friday"
	);
	await expect(page.getByLabel("Tags (optional)")).toHaveValue(
		"  work, work, planning "
	);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("desktop-memory-library-edit-error-retry.png"),
	});
	await dialog.getByRole("button", { name: "Save changes" }).click();
	await expect(dialog).toBeHidden();
	await expect(
		page.getByText("Atlas release date is Friday", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Project Atlas ships on Fridays", { exact: true })
	).toHaveCount(0);

	let current = await snapshot(page);
	expect(
		current.requests
			.filter(
				(request) =>
					request.path === "/api/memory/memory-atlas-release" &&
					request.method === "PUT"
			)
			.map((request) => ({ body: request.body, status: request.status }))
	).toEqual([
		{ body: patch, status: 503 },
		{ body: patch, status: 200 },
	]);
	expect(
		current.memories.find((memory) => memory.id === "memory-atlas-release")
	).toMatchObject({
		...patch,
	});

	await page.reload();
	await expect(
		page.getByText("Atlas release date is Friday", { exact: true })
	).toBeVisible();
	current = await snapshot(page);
	expect(
		current.memories.find((memory) => memory.id === "memory-atlas-release")
	).toMatchObject({
		...patch,
	});
});

test("keeps a memory when delete is cancelled or fails, then retries the confirmed delete", async ({
	page,
}) => {
	await openLibrary(page);
	const target = page.getByText("Lives near a coastal city", { exact: true });
	const row = page.locator("li").filter({ has: target });
	await row.getByRole("button", { name: "Delete memory" }).click();
	let confirmation = page.getByRole("alertdialog");
	await expect(
		confirmation.getByRole("heading", { name: "Delete this memory?" })
	).toBeVisible();
	await confirmation.getByRole("button", { name: "Cancel" }).click();
	await expect(confirmation).toBeHidden();
	expect(
		(await snapshot(page)).requests.filter(
			(request) => request.method === "DELETE"
		)
	).toHaveLength(0);
	await expect(target).toBeVisible();

	await row.getByRole("button", { name: "Delete memory" }).click();
	confirmation = page.getByRole("alertdialog");
	await armFailure(page, "DELETE", "/api/memory/memory-coastal-city", 503);
	await confirmation.getByRole("button", { name: "Delete" }).click();
	await expect(page.getByText("Couldn't delete that memory")).toBeVisible();
	await expect(target).toBeVisible();

	await row.getByRole("button", { name: "Delete memory" }).click();
	confirmation = page.getByRole("alertdialog");
	await confirmation.getByRole("button", { name: "Delete" }).click();
	await expect(confirmation).toBeHidden();
	await expect(target).toHaveCount(0);

	const current = await snapshot(page);
	expect(
		current.requests
			.filter(
				(request) =>
					request.path === "/api/memory/memory-coastal-city" &&
					request.method === "DELETE"
			)
			.map((request) => ({ body: request.body, status: request.status }))
	).toEqual([
		{ body: null, status: 503 },
		{ body: null, status: 200 },
	]);
	expect(
		current.memories.some((memory) => memory.id === "memory-coastal-city")
	).toBe(false);

	await page.reload();
	await expect(
		page.getByText("Lives near a coastal city", { exact: true })
	).toHaveCount(0);
	expect(
		(await snapshot(page)).memories.some(
			(memory) => memory.id === "memory-coastal-city"
		)
	).toBe(false);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("desktop-memory-library-delete-persisted.png"),
	});
});

test("opens New memory from the empty-state action without persisting a cancelled draft", async ({
	page,
}) => {
	await openLibrary(page, "/memory-library-proof.html?reset=true&empty=true");
	await expect(
		page.getByText("No memories yet", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "New memory" }).last().click();
	const dialog = page.getByRole("dialog", { name: "New memory" });
	await expect(dialog).toBeVisible();
	await page
		.getByLabel("Memory", { exact: true })
		.fill("Draft from the empty state");
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toBeHidden();
	expect(
		(await snapshot(page)).requests.filter(
			(request) => request.path === "/api/memory" && request.method === "POST"
		)
	).toHaveLength(0);
	await expect(
		page.getByText("No memories yet", { exact: true })
	).toBeVisible();
});
