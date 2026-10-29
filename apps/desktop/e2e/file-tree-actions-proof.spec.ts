import { writeFile } from "node:fs/promises";
declare global {
	interface Window {
		__fileTreeRuntimeErrors: string[];
		__fileTreeCompletions: { command: string; args: unknown }[];
	}
}
import { expect, type Page, test } from "@playwright/test";
const URL = "/file-tree-actions-proof.html";
const HEADERS = { "x-file-tree-proof": "finite-native-boundary" };
const INITIAL = {
	"src/alpha.ts": "export const alpha = 'original bytes';\n",
	"src/beta.ts": "export const beta = 'untouched sibling';\n",
	"archive/keep.txt": "existing destination bytes\n",
};
interface State {
	secondaryProject: string;
	secondaryFiles: Record<string, string>;
	heldMove: boolean;
	project: string;
	files: Record<string, string>;
	calls: { command: string; args: unknown; outcome: string }[];
	unexpected: unknown[];
}
async function state(page: Page): Promise<State> {
	const r = await page.request.get("/__file-tree/state", { headers: HEADERS });
	expect(r.status()).toBe(200);
	return await r.json();
}
async function control(page: Page, action: string) {
	const r = await page.request.post("/__file-tree/control", {
		headers: HEADERS,
		data: { action },
	});
	expect(r.status()).toBe(200);
	expect(await r.json()).toEqual({ ok: true });
}
const files = (page: Page) => page.getByTestId("files");
const row = (page: Page, name: string) =>
	files(page).locator(
		`[role="treeitem"][data-item-path="${name}"], [role="treeitem"][data-item-path="${name}/"]`
	);
async function expand(page: Page, folder = "src") {
	const r = row(page, folder);
	await expect(r).toBeVisible();
	if ((await r.getAttribute("aria-expanded")) !== "true") await r.click();
}
async function settings(page: Page) {
	await page
		.getByTestId("settings")
		.getByRole("button", { name: "File tree", exact: true })
		.click();
}
const settingSwitch = (page: Page, title: string) =>
	page
		.getByTestId("settings")
		.locator('[data-slot="item"]')
		.filter({ has: page.getByText(title, { exact: true }) })
		.getByRole("switch");
async function enableRename(page: Page) {
	await settings(page);
	await settingSwitch(page, "Inline rename").click();
	await expect(settingSwitch(page, "Inline rename")).toHaveAttribute(
		"aria-checked",
		"true"
	);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					JSON.parse(localStorage.getItem("ryu:file-tree-prefs") ?? "{}")
						.renaming
			)
		)
		.toBe(true);
}
async function rename(page: Page, source: string, leaf: string) {
	await row(page, source).click();
	await page.keyboard.press("F2");
	const input = files(page).locator("[data-item-rename-input]");
	await expect(input).toBeVisible();
	await input.fill(leaf);
	await input.press("Enter");
	await expect(input).toHaveCount(0);
}
async function expectFreshListing(
	page: Page,
	expected: Record<string, string>
) {
	await page.reload();
	await expect(row(page, "src")).toBeVisible();
	await expect.poll(async () => (await state(page)).files).toEqual(expected);
	const s = await state(page);
	expect(
		s.calls.filter((c) => c.command === "list_workspace_files").at(-1)?.args
	).toEqual({ root: s.project });
}
test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => {
		window.__fileTreeRuntimeErrors = [];
		window.addEventListener("error", (event) =>
			window.__fileTreeRuntimeErrors.push(event.message)
		);
		window.addEventListener("unhandledrejection", (event) =>
			window.__fileTreeRuntimeErrors.push(String(event.reason))
		);
	});
	await control(page, "reset");
});
test.afterEach(async ({ page }) => {
	const runtimeErrors = await page.evaluate(
		() => window.__fileTreeRuntimeErrors
	);
	const evidencePath = test
		.info()
		.outputPath("file-tree-physical-state-and-native-ledger.json");
	await writeFile(
		evidencePath,
		JSON.stringify(
			{ physicalStateAndNativeLedger: await state(page), runtimeErrors },
			null,
			2
		)
	);
	await test.info().attach("file-tree-physical-state-and-native-ledger.json", {
		path: evidencePath,
		contentType: "application/json",
	});
	if ((await state(page)).heldMove) await control(page, "release_move");
	await expect
		.poll(async () =>
			(await state(page)).calls.some(
				(call) =>
					call.command === "move_workspace_item" && call.outcome === "pending"
			)
		)
		.toBe(false);
	expect(
		await page.evaluate(() => window.__fileTreeRuntimeErrors)
	).toEqual([]);
	expect((await state(page)).unexpected).toEqual([]);
});

test("disabled inline rename blocks F2; enabled Escape cancellation never changes real project bytes", async ({
	page,
}) => {
	await page.goto(URL);
	await expand(page);
	await row(page, "src/alpha.ts").click();
	await page.keyboard.press("F2");
	await expect(files(page).locator("[data-item-rename-input]")).toHaveCount(0);
	await enableRename(page);
	await expand(page);
	await row(page, "src/alpha.ts").click();
	await page.keyboard.press("F2");
	const input = files(page).locator("[data-item-rename-input]");
	await input.fill("cancelled.ts");
	await input.press("Escape");
	await expect(input).toHaveCount(0);
	await expect(row(page, "src/alpha.ts")).toBeVisible();
	expect((await state(page)).files).toEqual(INITIAL);
	await expectFreshListing(page, INITIAL);
	await expand(page);
	await expect(row(page, "src/alpha.ts")).toBeVisible();
	await expect(row(page, "src/cancelled.ts")).toHaveCount(0);
});

test("committed inline rename updates the real project file and remains renamed after a fresh native listing", async ({
	page,
}) => {
	await page.goto(URL);
	await enableRename(page);
	await expand(page);
	await rename(page, "src/alpha.ts", "renamed.ts");
	const expected = {
		"src/renamed.ts": INITIAL["src/alpha.ts"],
		"src/beta.ts": INITIAL["src/beta.ts"],
		"archive/keep.txt": INITIAL["archive/keep.txt"],
	};
	// Read physical project bytes independently of Pierre's optimistic model.
	await expect.poll(async () => (await state(page)).files).toEqual(expected);
	await nativeMoveSettled(page, 1);
	const persisted = await state(page);
	expect(
		persisted.calls.filter((call) => call.command === "move_workspace_item")
	).toEqual([
		{
			command: "move_workspace_item",
			args: {
				root: persisted.project,
				sourcePath: "src/alpha.ts",
				destinationPath: "src/renamed.ts",
			},
			outcome: "accepted",
		},
	]);
	// Do not expand the parent again: a same-folder native refresh must keep
	// the actual user's expanded tree open after the physical rename completes.
	await expect(row(page, "src")).toHaveAttribute("aria-expanded", "true");
	await expect(row(page, "src/renamed.ts")).toBeVisible();
	await expect(row(page, "src/alpha.ts")).toHaveCount(0);
	await expectFreshListing(page, expected);
	await expand(page);
	await expect(row(page, "src/renamed.ts")).toBeVisible();
	await expect(row(page, "src/alpha.ts")).toHaveCount(0);
});

test("renaming a folder persists every child without changing file bytes or sibling folders", async ({
	page,
}) => {
	await page.goto(URL);
	await enableRename(page);
	await rename(page, "src", "source");
	await expect(row(page, "source")).toBeVisible();
	const expected = {
		"source/alpha.ts": INITIAL["src/alpha.ts"],
		"source/beta.ts": INITIAL["src/beta.ts"],
		"archive/keep.txt": INITIAL["archive/keep.txt"],
	};
	await expect.poll(async () => (await state(page)).files).toEqual(expected);
	await page.reload();
	await expect(row(page, "source")).toBeVisible();
	await expect(row(page, "src")).toHaveCount(0);
	await expand(page, "source");
	await expect(row(page, "source/alpha.ts")).toBeVisible();
	expect((await state(page)).files).toEqual(expected);
});

test("actual pointer drag into another folder moves the physical file and survives reopening", async ({
	page,
}) => {
	await page.goto(URL);
	await settings(page);
	await settingSwitch(page, "Drag and drop").click();
	await expect(settingSwitch(page, "Drag and drop")).toHaveAttribute(
		"aria-checked",
		"true"
	);
	await expand(page);
	const from = await row(page, "src/alpha.ts").boundingBox();
	const to = await row(page, "archive").boundingBox();
	if (!from || !to)
		throw new Error("Real source or destination row unavailable");
	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
		steps: 20,
	});
	await page.mouse.up();
	await expand(page, "archive");
	await expect(row(page, "archive/alpha.ts")).toBeVisible();
	const expected = {
		"archive/alpha.ts": INITIAL["src/alpha.ts"],
		"src/beta.ts": INITIAL["src/beta.ts"],
		"archive/keep.txt": INITIAL["archive/keep.txt"],
	};
	await expect.poll(async () => (await state(page)).files).toEqual(expected);
	await expectFreshListing(page, expected);
	await expand(page, "archive");
	await expect(row(page, "archive/alpha.ts")).toBeVisible();
	await expand(page);
	await expect(row(page, "src/alpha.ts")).toHaveCount(0);
});

test("refused real git listing exposes Retry and never turns failure into an empty project", async ({
	page,
}) => {
	await control(page, "refuse_list_once");
	await page.goto(URL);
	await expect(files(page).getByRole("alert")).toHaveText(
		"Fixture project listing refused"
	);
	await expect(files(page).getByText(/No files found/)).toHaveCount(0);
	await files(page).getByRole("button", { name: "Retry file listing" }).click();
	await expand(page);
	await expect(row(page, "src/alpha.ts")).toBeVisible();
	const s = await state(page);
	expect(s.files).toEqual(INITIAL);
	expect(s.calls.filter((c) => c.command === "list_workspace_files")).toEqual([
		{
			command: "list_workspace_files",
			args: { root: s.project },
			outcome: "refused",
		},
		{
			command: "list_workspace_files",
			args: { root: s.project },
			outcome: "accepted",
		},
	]);
});

test("file Open refusal is visible; explicit retry and Reveal use the exact existing file and project root", async ({
	page,
}) => {
	await page.goto(URL);
	await expand(page);
	await control(page, "refuse_open_once");
	await row(page, "src/alpha.ts").click({ button: "right" });
	await page.getByRole("menuitem", { name: "Open", exact: true }).click();
	await expect(
		page.getByText("Couldn't open that workspace item", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Fixture native opener refused", { exact: true })
	).toBeVisible();
	await row(page, "src/alpha.ts").click({ button: "right" });
	await page.getByRole("menuitem", { name: "Open", exact: true }).click();
	await expect
		.poll(
			async () =>
				(await state(page)).calls.filter(
					(c) => c.command === "open_workspace_item"
				).length
		)
		.toBe(2);
	await row(page, "src/alpha.ts").click({ button: "right" });
	await page.getByRole("menuitem", { name: /^Reveal in / }).click();
	await expect
		.poll(
			async () =>
				(await state(page)).calls.filter(
					(c) => c.command === "reveal_workspace_item"
				).length
		)
		.toBe(1);
	const s = await state(page);
	const args = { editor: null, path: "src/alpha.ts", root: s.project };
	expect(
		s.calls.filter((c) =>
			["open_workspace_item", "reveal_workspace_item"].includes(c.command)
		)
	).toEqual([
		{ command: "open_workspace_item", args, outcome: "refused" },
		{ command: "open_workspace_item", args, outcome: "accepted" },
		{ command: "reveal_workspace_item", args, outcome: "accepted" },
	]);
	expect(s.files).toEqual(INITIAL);
});

test("renaming a tracked file persists real bytes and a fresh listing omits the deleted cached source", async ({
	page,
}) => {
	await control(page, "track_initial");
	await page.goto(URL);
	await enableRename(page);
	await expand(page);
	await rename(page, "src/alpha.ts", "tracked-renamed.ts");
	const expected = {
		"src/tracked-renamed.ts": INITIAL["src/alpha.ts"],
		"src/beta.ts": INITIAL["src/beta.ts"],
		"archive/keep.txt": INITIAL["archive/keep.txt"],
	};
	await expect.poll(async () => (await state(page)).files).toEqual(expected);
	await expectFreshListing(page, expected);
	await expand(page);
	await expect(row(page, "src/tracked-renamed.ts")).toBeVisible();
	await expect(row(page, "src/alpha.ts")).toHaveCount(0);
});

test("actual folder drag moves every descendant byte into the destination and survives fresh reopening", async ({
	page,
}) => {
	await page.goto(URL);
	await settings(page);
	await settingSwitch(page, "Drag and drop").click();
	await expect(settingSwitch(page, "Drag and drop")).toHaveAttribute(
		"aria-checked",
		"true"
	);
	const from = await row(page, "src").boundingBox();
	const to = await row(page, "archive").boundingBox();
	if (!from || !to)
		throw new Error("Actual folder source/destination unavailable");
	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
		steps: 20,
	});
	await page.mouse.up();
	await expand(page, "archive");
	await expect(row(page, "archive/src")).toBeVisible();
	const expected = {
		"archive/src/alpha.ts": INITIAL["src/alpha.ts"],
		"archive/src/beta.ts": INITIAL["src/beta.ts"],
		"archive/keep.txt": INITIAL["archive/keep.txt"],
	};
	await expect.poll(async () => (await state(page)).files).toEqual(expected);
	await page.reload();
	await expand(page, "archive");
	await expand(page, "archive/src");
	await expect(row(page, "archive/src/alpha.ts")).toBeVisible();
	await expect(row(page, "archive/src/beta.ts")).toBeVisible();
	await expect(row(page, "src")).toHaveCount(0);
	expect((await state(page)).files).toEqual(expected);
});

async function nativeMoveSettled(page: Page, count: number) {
	await expect
		.poll(
			async () =>
				(await state(page)).calls.filter(
					(call) =>
						call.command === "move_workspace_item" && call.outcome !== "pending"
				).length
		)
		.toBe(count);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.__fileTreeCompletions.filter(
						(call) => call.command === "move_workspace_item"
					).length
			)
		)
		.toBe(count);
	// Actual bridge Promise is consumed before the next frame. No synthetic event
	// or arbitrary delay stands in for the old production continuation.
	await page.evaluate(
		() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	);
}

test("real exclusive native collision keeps original and destination bytes, restores the tree, and identical retry succeeds", async ({
	page,
}) => {
	await page.goto(URL);
	await enableRename(page);
	await expand(page);
	// The independent filesystem changes after Pierre's listing, so the real
	// native helper, rather than an in-memory model, must reject this collision.
	await control(page, "create_collision");
	await rename(page, "src/alpha.ts", "blocked.ts");
	await expect(
		page.getByText("Couldn't move that workspace item", { exact: true })
	).toBeVisible();
	await page
		.getByText("Couldn't move that workspace item", { exact: true })
		.hover();
	await expect(page.getByText(/Workspace move refused/)).toBeVisible();
	await nativeMoveSettled(page, 1);
	await expand(page);
	await expect(row(page, "src/alpha.ts")).toBeVisible();
	expect((await state(page)).files).toEqual({
		...INITIAL,
		"src/blocked.ts": "collision bytes remain intact\n",
	});
	await control(page, "remove_collision");
	// The destination changed outside Ryu. Reopen the real Files panel to read
	// the current disk state before retrying the identical refused operation.
	await page.getByRole("button", { name: "Close Files", exact: true }).click();
	await page.getByRole("button", { name: "Reopen Files", exact: true }).click();
	await expand(page);
	await rename(page, "src/alpha.ts", "blocked.ts");
	const expected = {
		"src/blocked.ts": INITIAL["src/alpha.ts"],
		"src/beta.ts": INITIAL["src/beta.ts"],
		"archive/keep.txt": INITIAL["archive/keep.txt"],
	};
	await expect.poll(async () => (await state(page)).files).toEqual(expected);
	await nativeMoveSettled(page, 2);
	const snapshot = await state(page);
	const args = {
		root: snapshot.project,
		sourcePath: "src/alpha.ts",
		destinationPath: "src/blocked.ts",
	};
	expect(
		snapshot.calls.filter((call) => call.command === "move_workspace_item")
	).toEqual([
		{ command: "move_workspace_item", args, outcome: "refused" },
		{ command: "move_workspace_item", args, outcome: "accepted" },
	]);
	await expectFreshListing(page, expected);
	await expand(page);
	await expect(row(page, "src/blocked.ts")).toBeVisible();
});

test("a held physical move blocks a second actual F2 rename until the acknowledged filesystem result is listed", async ({
	page,
}) => {
	await page.goto(URL);
	await enableRename(page);
	await expand(page);
	await control(page, "hold_move_once");
	await rename(page, "src/alpha.ts", "pending.ts");
	await expect.poll(async () => (await state(page)).heldMove).toBe(true);
	expect((await state(page)).files).toEqual(INITIAL);
	await row(page, "src/beta.ts").click();
	await page.keyboard.press("F2");
	await expect(files(page).locator("[data-item-rename-input]")).toHaveCount(0);
	await page.evaluate(
		() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
	);
	expect(
		(await state(page)).calls.filter(
			(call) => call.command === "move_workspace_item"
		)
	).toHaveLength(1);
	await control(page, "release_move");
	await nativeMoveSettled(page, 1);
	await expand(page);
	await expect(row(page, "src/pending.ts")).toBeVisible();
	expect((await state(page)).files).toEqual({
		"src/pending.ts": INITIAL["src/alpha.ts"],
		"src/beta.ts": INITIAL["src/beta.ts"],
		"archive/keep.txt": INITIAL["archive/keep.txt"],
	});
});

test("old-folder move completion cannot replace or refresh the newly selected project", async ({
	page,
}) => {
	await page.goto(URL);
	await enableRename(page);
	await expand(page);
	await control(page, "hold_move_once");
	await rename(page, "src/alpha.ts", "old-project.ts");
	await expect.poll(async () => (await state(page)).heldMove).toBe(true);
	await page
		.getByRole("button", { name: "Open alternate project", exact: true })
		.click();
	await expand(page);
	await expect(row(page, "src/other.ts")).toBeVisible();
	const before = await state(page);
	const reads = before.calls.filter(
		(call) =>
			call.command === "list_workspace_files" &&
			(call.args as { root: string }).root === before.secondaryProject
	).length;
	expect(reads).toBe(1);
	await control(page, "release_move");
	await nativeMoveSettled(page, 1);
	await expect(row(page, "src/other.ts")).toBeVisible();
	await expect(row(page, "src/old-project.ts")).toHaveCount(0);
	const after = await state(page);
	expect(after.secondaryFiles).toEqual({
		"src/other.ts": "alternate project bytes\n",
	});
	expect(
		after.calls.filter(
			(call) =>
				call.command === "list_workspace_files" &&
				(call.args as { root: string }).root === after.secondaryProject
		)
	).toHaveLength(reads);
	expect(after.files).toEqual({
		"src/old-project.ts": INITIAL["src/alpha.ts"],
		"src/beta.ts": INITIAL["src/beta.ts"],
		"archive/keep.txt": INITIAL["archive/keep.txt"],
	});
});

test("web surface cannot list, probe native editors, rename or move local project files", async ({
	page,
}) => {
	await page.goto(`${URL}?web=1`);
	await expect(
		files(page).getByText(
			"Project files require the local Desktop filesystem.",
			{ exact: true }
		)
	).toBeVisible();
	await settings(page);
	await settingSwitch(page, "Inline rename").click();
	await settingSwitch(page, "Drag and drop").click();
	await expect(files(page).getByRole("tree")).toHaveCount(0);
	const snapshot = await state(page);
	expect(
		snapshot.calls.filter((call) => !call.command.startsWith("plugin:store|"))
	).toEqual([]);
	expect(snapshot.files).toEqual(INITIAL);
});

test("a refused native move from an unmounted Files panel cannot leak an error into the reopened panel", async ({
	page,
}) => {
	await page.goto(URL);
	await enableRename(page);
	await expand(page);
	await control(page, "create_collision");
	await control(page, "hold_move_once");
	await rename(page, "src/alpha.ts", "blocked.ts");
	await expect.poll(async () => (await state(page)).heldMove).toBe(true);
	await page.getByRole("button", { name: "Close Files", exact: true }).click();
	await expect(files(page).getByRole("tree")).toHaveCount(0);
	await page.getByRole("button", { name: "Reopen Files", exact: true }).click();
	await expand(page);
	await expect(row(page, "src/alpha.ts")).toBeVisible();
	const before = await state(page);
	const readCount = before.calls.filter(
		(call) => call.command === "list_workspace_files"
	).length;
	await control(page, "release_move");
	await nativeMoveSettled(page, 1);
	await expect(
		page.getByText("Couldn't move that workspace item", { exact: true })
	).toHaveCount(0);
	await expect(row(page, "src/alpha.ts")).toBeVisible();
	const after = await state(page);
	expect(
		after.calls.filter((call) => call.command === "list_workspace_files")
	).toHaveLength(readCount);
	expect(after.files).toEqual({
		...INITIAL,
		"src/blocked.ts": "collision bytes remain intact\n",
	});
});

async function dragSelectedFiles(page: Page) {
	await settings(page);
	await settingSwitch(page, "Drag and drop").click();
	await expect(settingSwitch(page, "Drag and drop")).toHaveAttribute(
		"aria-checked",
		"true"
	);
	await expand(page);
	await row(page, "src/alpha.ts").click();
	await row(page, "src/beta.ts").click({ modifiers: ["Control"] });
	await expect(row(page, "src/alpha.ts")).toHaveAttribute(
		"aria-selected",
		"true"
	);
	await expect(row(page, "src/beta.ts")).toHaveAttribute(
		"aria-selected",
		"true"
	);
	const from = await row(page, "src/alpha.ts").boundingBox();
	const to = await row(page, "archive").boundingBox();
	if (!from || !to)
		throw new Error("Real selected source or destination unavailable");
	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
		steps: 20,
	});
	await page.mouse.up();
}

test("actual multi-selection pointer drag persists both selected files and survives a fresh listing", async ({
	page,
}) => {
	await page.goto(URL);
	await dragSelectedFiles(page);
	const expected = {
		"archive/alpha.ts": INITIAL["src/alpha.ts"],
		"archive/beta.ts": INITIAL["src/beta.ts"],
		"archive/keep.txt": INITIAL["archive/keep.txt"],
	};
	await expect.poll(async () => (await state(page)).files).toEqual(expected);
	await nativeMoveSettled(page, 2);
	const s = await state(page);
	expect(
		s.calls
			.filter((c) => c.command === "move_workspace_item")
			.map(({ args, outcome }) => ({ args, outcome }))
	).toEqual([
		{
			args: {
				root: s.project,
				sourcePath: "src/alpha.ts",
				destinationPath: "archive/alpha.ts",
			},
			outcome: "accepted",
		},
		{
			args: {
				root: s.project,
				sourcePath: "src/beta.ts",
				destinationPath: "archive/beta.ts",
			},
			outcome: "accepted",
		},
	]);
	await page.reload();
	await expand(page, "archive");
	await expect(row(page, "archive/alpha.ts")).toBeVisible();
	await expect(row(page, "archive/beta.ts")).toBeVisible();
	await expect(row(page, "src")).toHaveCount(0);
	expect((await state(page)).files).toEqual(expected);
});

test("multi-file drag preserves the successful move and refuses an occupied destination without overwriting bytes", async ({
	page,
}) => {
	await page.goto(URL);
	await expect(row(page, "src")).toBeVisible();
	// Create a real collision after the model has read its initial paths.
	await control(page, "create_drag_collision");
	await dragSelectedFiles(page);
	await nativeMoveSettled(page, 2);
	const error = page.getByText("Couldn't move that workspace item", {
		exact: true,
	});
	await expect(error).toBeVisible();
	await error.hover();
	await expect(
		page.getByText(/src\/alpha\.ts:.*Workspace move refused/)
	).toBeVisible();
	const expected = {
		"src/alpha.ts": INITIAL["src/alpha.ts"],
		"archive/beta.ts": INITIAL["src/beta.ts"],
		"archive/alpha.ts": "destination collision bytes\n",
		"archive/keep.txt": INITIAL["archive/keep.txt"],
	};
	await expect.poll(async () => (await state(page)).files).toEqual(expected);
	await expand(page);
	await expect(row(page, "src/alpha.ts")).toBeVisible();
	await expect(row(page, "src/beta.ts")).toHaveCount(0);
	await expand(page, "archive");
	await expect(row(page, "archive/alpha.ts")).toBeVisible();
	await expect(row(page, "archive/beta.ts")).toBeVisible();
	const s = await state(page);
	expect(
		s.calls
			.filter((c) => c.command === "move_workspace_item")
			.map(({ args, outcome }) => ({ args, outcome }))
	).toEqual([
		{
			args: {
				root: s.project,
				sourcePath: "src/alpha.ts",
				destinationPath: "archive/alpha.ts",
			},
			outcome: "refused",
		},
		{
			args: {
				root: s.project,
				sourcePath: "src/beta.ts",
				destinationPath: "archive/beta.ts",
			},
			outcome: "accepted",
		},
	]);
	await page.reload();
	await expand(page);
	await expect(row(page, "src/alpha.ts")).toBeVisible();
	await expand(page, "archive");
	await expect(row(page, "archive/alpha.ts")).toBeVisible();
	await expect(row(page, "archive/beta.ts")).toBeVisible();
	expect((await state(page)).files).toEqual(expected);
});
