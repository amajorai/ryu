import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type {
	DatabaseDoc,
	DbView,
	DbViewKind,
} from "../src/lib/realtime/yjs-database.ts";

const STORY_URL = "/view-bar-interactions-proof.html";
const SPACE_ID = "view-bar-proof-space";
const DOCUMENT_ID = "view-bar-proof-database";
const DOCUMENT_PATH = `/api/spaces/${SPACE_ID}/documents/${DOCUMENT_ID}`;
const EVIDENCE_DIR = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

interface CapturedCall {
	body: unknown;
	method: string;
	path: string;
}

interface PersistedDocument {
	source: string;
	title: string;
}

interface ViewBarProofSnapshot {
	activeViewId: string;
	calls: CapturedCall[];
	database: DatabaseDoc;
	persisted: PersistedDocument;
	saveError: string | null;
	saveStatus: string;
}

interface ViewBarProofWindow extends Window {
	__viewBarProof: {
		failNextSave: () => void;
		snapshot: () => ViewBarProofSnapshot;
	};
}

function viewButton(page: Page, name: string) {
	return page.getByRole("button", { name, exact: true });
}

async function readProof(page: Page): Promise<ViewBarProofSnapshot> {
	try {
		return await page.evaluate(() =>
			/* SAFETY: view-bar-interactions-proof.tsx installs __viewBarProof before this proof page is evaluated. */ (
				window as ViewBarProofWindow
			).__viewBarProof.snapshot()
		);
	} catch (error) {
		throw new Error(
			`Could not read ViewBar fixture state at ${page.url()}: ${String(error)}`
		);
	}
}

function putCalls(snapshot: ViewBarProofSnapshot) {
	return snapshot.calls.filter(
		(call) => call.method === "PUT" && call.path === DOCUMENT_PATH
	);
}

function persistedSource(database: DatabaseDoc): string {
	return JSON.stringify({
		columns: database.columns,
		rows: database.rows.map(({ __id, ...row }) => row),
		views: database.views ?? [],
	} satisfies DatabaseDoc);
}

function withView(
	database: DatabaseDoc,
	view: DbView
): DatabaseDoc & { views: DbView[] } {
	return { ...database, views: [...(database.views ?? []), view] };
}

async function openProof(page: Page, query = "") {
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(`${STORY_URL}${query}`);
	await expect(page.getByTestId("save-status")).toHaveText("Saved");
	await expect
		.poll(async () => {
			const snapshot = await readProof(page);
			return snapshot.database.views?.find(
				(view) => view.id === snapshot.activeViewId
			)?.name;
		})
		.toBeTruthy();
	const snapshot = await readProof(page);
	const activeView = snapshot.database.views?.find(
		(view) => view.id === snapshot.activeViewId
	);
	if (!activeView) {
		throw new Error("The database did not load an active view.");
	}
	await expect(viewButton(page, activeView.name)).toHaveAttribute(
		"aria-pressed",
		"true"
	);
}

async function openViewOptions(page: Page) {
	const menu = page.getByRole("menu", { name: "View options", exact: true });
	if (!(await menu.isVisible())) {
		await page
			.getByRole("button", { name: "View options", exact: true })
			.click();
		await expect(menu).toBeVisible();
	}
}

async function chooseLayout(page: Page, kind: string) {
	await openViewOptions(page);
	await page
		.getByRole("menu", { name: "View options", exact: true })
		.getByRole("menuitemradio", { name: kind, exact: true })
		.click();
}

async function expectSavedSource(
	page: Page,
	writeCount: number,
	database: DatabaseDoc
) {
	await expect
		.poll(async () => putCalls(await readProof(page)).length)
		.toBe(writeCount);
	const snapshot = await readProof(page);
	expect(putCalls(snapshot)[writeCount - 1]?.body).toEqual({
		source: persistedSource(database),
		title: "Product roadmap",
	});
}

async function expectActiveAndUnselected(
	page: Page,
	activeName: string,
	unselectedName: string
) {
	await expect(viewButton(page, activeName)).toHaveAttribute(
		"aria-pressed",
		"true"
	);
	await expect(viewButton(page, unselectedName)).toHaveAttribute(
		"aria-pressed",
		"false"
	);
}

test.describe.configure({ timeout: 90_000 });

test("view chips select the rendered database view without persisting the active tab", async ({
	page,
}) => {
	await openProof(page);
	const before = await readProof(page);
	expect(before.database.views?.map((view) => view.id)).toEqual([
		"view_table",
		"view_board",
	]);
	await expectActiveAndUnselected(page, "All records", "By status");

	await viewButton(page, "By status").click();
	await expectActiveAndUnselected(page, "By status", "All records");
	await expect(page.getByTestId("active-view-heading")).toHaveText("By status");
	await expect(
		page.getByText("In progress", { exact: true }).first()
	).toBeVisible();
	await expect(page.getByText("Done", { exact: true }).first()).toBeVisible();
	expect(putCalls(await readProof(page))).toHaveLength(0);

	await page.reload();
	await openProof(page);
	await expectActiveAndUnselected(page, "All records", "By status");
	expect((await readProof(page)).persisted.source).toBe(
		before.persisted.source
	);
});

test("layout radio updates the rendered view, retries a failed save, and reloads", async ({
	page,
}) => {
	await openProof(page);
	const before = await readProof(page);
	const expectedList = structuredClone(before.database);
	const listView = expectedList.views?.find((view) => view.id === "view_table");
	if (!listView) {
		throw new Error("The proof database is missing its initial table view.");
	}
	listView.kind = "list";

	await page.evaluate(() => {
		/* SAFETY: view-bar-interactions-proof.tsx installs __viewBarProof before this proof page is evaluated. */ (
			window as ViewBarProofWindow
		).__viewBarProof.failNextSave();
	});
	await chooseLayout(page, "List");
	await expect(page.getByTestId("active-view-heading")).toHaveText(
		"All records"
	);
	await expect(page.getByRole("button", { name: /Atlas/ })).toBeVisible();
	await expect(page.getByRole("button", { name: /Beacon/ })).toBeVisible();
	await expect(viewButton(page, "All records")).toHaveAttribute(
		"aria-pressed",
		"true"
	);
	await expect(page.getByRole("alert")).toContainText(
		`${DOCUMENT_PATH} failed: 503`
	);
	const failed = await readProof(page);
	expect(failed.persisted.source).toBe(before.persisted.source);
	expect(putCalls(failed)).toHaveLength(1);
	expect(putCalls(failed)[0]?.body).toEqual({
		source: persistedSource(expectedList),
		title: "Product roadmap",
	});
	await mkdir(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE_DIR, "desktop-view-bar-layout-save-error.png"),
	});

	const expectedGallery = structuredClone(expectedList);
	expectedGallery.views?.forEach((view) => {
		if (view.id === "view_table") {
			view.kind = "gallery";
		}
	});
	await chooseLayout(page, "Gallery");
	await expect(page.getByText("Atlas", { exact: true })).toBeVisible();
	await expect(page.getByText("Beacon", { exact: true })).toBeVisible();
	await expectSavedSource(page, 2, expectedGallery);

	await page.reload();
	await openProof(page);
	await expect(page.getByText("Atlas", { exact: true })).toBeVisible();
	await expect(page.getByText("Beacon", { exact: true })).toBeVisible();
	expect((await readProof(page)).persisted.source).toBe(
		persistedSource(expectedGallery)
	);
});

test("board grouping saves the exact select-field configuration and survives reload", async ({
	page,
}) => {
	await openProof(page);
	await viewButton(page, "By status").click();
	await expectActiveAndUnselected(page, "By status", "All records");
	const before = await readProof(page);
	const expectedTags = structuredClone(before.database);
	const tagsView = expectedTags.views?.find((view) => view.id === "view_board");
	if (!tagsView) {
		throw new Error("The proof database is missing its initial board view.");
	}
	tagsView.groupByColumnId = "tags";

	await openViewOptions(page);
	await page.getByRole("menuitem", { name: "Group by", exact: true }).click();
	await page.getByRole("menuitemradio", { name: "Tags", exact: true }).click();
	await expect(page.getByText("Design", { exact: true }).first()).toBeVisible();
	await expect(
		page.getByText("Release", { exact: true }).first()
	).toBeVisible();
	await expect(page.getByText("Urgent", { exact: true }).first()).toBeVisible();
	await mkdir(EVIDENCE_DIR, { recursive: true });
	await expectSavedSource(page, 1, expectedTags);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE_DIR, "desktop-view-bar-board-grouping-draft.png"),
	});

	await page.reload();
	await openProof(page);
	await viewButton(page, "By status").click();
	await expect(page.getByText("Design", { exact: true }).first()).toBeVisible();
	const reloaded = await readProof(page);
	expect(reloaded.persisted.source).toBe(persistedSource(expectedTags));
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(
			EVIDENCE_DIR,
			"desktop-view-bar-board-grouping-readback.png"
		),
	});
});

test("rename trims valid names, rejects blank names, commits on blur, and cancels with Escape", async ({
	page,
}) => {
	await mkdir(EVIDENCE_DIR, { recursive: true });
	await openProof(page);
	const before = await readProof(page);

	await openViewOptions(page);
	await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
	const blankName = page.getByRole("textbox", {
		name: "Rename view All records",
	});
	await blankName.fill("   ");
	await blankName.press("Enter");
	await expect(blankName).toHaveCount(0);
	await expect(viewButton(page, "All records")).toBeVisible();
	expect(putCalls(await readProof(page))).toHaveLength(0);

	await openViewOptions(page);
	await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
	const renamed = page.getByRole("textbox", {
		name: "Rename view All records",
	});
	await renamed.fill("  Product ideas  ");
	await renamed.press("Enter");
	await expect(viewButton(page, "Product ideas")).toHaveAttribute(
		"aria-pressed",
		"true"
	);
	const afterEnter = structuredClone(before.database);
	const firstView = afterEnter.views?.find((view) => view.id === "view_table");
	if (!firstView) {
		throw new Error("The proof database is missing its initial table view.");
	}
	firstView.name = "Product ideas";
	await expectSavedSource(page, 1, afterEnter);

	await viewButton(page, "By status").dblclick();
	const cancelledRename = page.getByRole("textbox", {
		name: "Rename view By status",
	});
	await cancelledRename.fill("Discard this rename");
	await cancelledRename.press("Escape");
	await expect(cancelledRename).toHaveCount(0);
	await expect(viewButton(page, "By status")).toHaveAttribute(
		"aria-pressed",
		"true"
	);
	expect(
		(await readProof(page)).database.views?.find(
			(view) => view.id === "view_board"
		)?.name
	).toBe("By status");
	expect(putCalls(await readProof(page))).toHaveLength(1);

	await viewButton(page, "By status").dblclick();
	const blurRename = page.getByRole("textbox", {
		name: "Rename view By status",
	});
	await blurRename.fill("Delivery");
	await page.getByTestId("active-view-heading").click();
	await expect(viewButton(page, "Delivery")).toHaveAttribute(
		"aria-pressed",
		"true"
	);
	const afterBlur = structuredClone(afterEnter);
	afterBlur.views?.forEach((view) => {
		if (view.id === "view_board") {
			view.name = "Delivery";
		}
	});
	await expectSavedSource(page, 2, afterBlur);

	await page.reload();
	await openProof(page);
	await expect(viewButton(page, "Product ideas")).toHaveAttribute(
		"aria-pressed",
		"true"
	);
	await expect(viewButton(page, "Delivery")).toBeVisible();
	expect((await readProof(page)).persisted.source).toBe(
		persistedSource(afterBlur)
	);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE_DIR, "desktop-view-bar-renamed-and-reloaded.png"),
	});
});

test("Add view creates every layout with saved defaults; deleting views selects the fallback and protects the last one", async ({
	page,
}) => {
	await mkdir(EVIDENCE_DIR, { recursive: true });
	await openProof(page);
	let expected = structuredClone((await readProof(page)).database);
	const added: DbView[] = [];
	const kinds: Array<{ kind: DbViewKind; name: string }> = [
		{ kind: "table", name: "Table" },
		{ kind: "board", name: "Board" },
		{ kind: "gallery", name: "Gallery" },
		{ kind: "list", name: "List" },
	];

	for (let index = 0; index < kinds.length; index += 1) {
		const option = kinds[index];
		if (!option) {
			throw new Error("A view kind option was missing.");
		}
		await page.getByRole("button", { name: "Add view", exact: true }).click();
		for (const { name } of kinds) {
			await expect(
				page.getByRole("menuitem", { name, exact: true })
			).toBeVisible();
		}
		await page
			.getByRole("menuitem", { name: option.name, exact: true })
			.click();
		const nextView = (await readProof(page)).database.views?.at(-1);
		if (
			!nextView ||
			nextView.kind !== option.kind ||
			nextView.name !== option.name
		) {
			throw new Error(
				`The ${option.name} view did not use its saved defaults.`
			);
		}
		added.push(nextView);
		expected = withView(expected, nextView);
		await expect(viewButton(page, option.name)).toHaveAttribute(
			"aria-pressed",
			"true"
		);
		await expectSavedSource(page, index + 1, expected);
		if (option.kind === "gallery") {
			await openViewOptions(page);
			await expect(
				page.getByRole("menuitem", { name: "Group by" })
			).toHaveCount(0);
			await page.keyboard.press("Escape");
		}
	}

	await viewButton(page, "Board").click();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE_DIR, "desktop-view-bar-added-layouts.png"),
	});

	let writeCount = kinds.length;
	for (const view of [...added].reverse()) {
		await viewButton(page, view.name).click();
		await openViewOptions(page);
		await expect(
			page.getByRole("menuitem", { name: "Delete view" })
		).toBeEnabled();
		await page.getByRole("menuitem", { name: "Delete view" }).click();
		expected = {
			...expected,
			views: (expected.views ?? []).filter(
				(savedView) => savedView.id !== view.id
			),
		};
		writeCount += 1;
		await expect(viewButton(page, view.name)).toHaveCount(0);
		await expect(viewButton(page, "All records")).toHaveAttribute(
			"aria-pressed",
			"true"
		);
		await expectSavedSource(page, writeCount, expected);
	}

	await viewButton(page, "By status").click();
	await openViewOptions(page);
	await page.getByRole("menuitem", { name: "Delete view" }).click();
	expected = {
		...expected,
		views: (expected.views ?? []).filter((view) => view.id !== "view_board"),
	};
	writeCount += 1;
	await expect(viewButton(page, "By status")).toHaveCount(0);
	await expectSavedSource(page, writeCount, expected);

	await openViewOptions(page);
	const deleteLastView = page.getByRole("menuitem", {
		name: "Delete view",
		exact: true,
	});
	await expect(deleteLastView).toBeDisabled();
	await page.keyboard.press("Escape");
	expect(putCalls(await readProof(page))).toHaveLength(writeCount);

	await page.reload();
	await openProof(page);
	await expect(viewButton(page, "All records")).toHaveAttribute(
		"aria-pressed",
		"true"
	);
	expect((await readProof(page)).persisted.source).toBe(
		persistedSource(expected)
	);
});

test("board grouping shows a disabled No Select property entry when the database has no select columns", async ({
	page,
}) => {
	await openProof(page, "?noSelect=true");
	await viewButton(page, "By status").click();
	await expect(
		page.getByText("Pick a Select property to group cards by in the view menu.")
	).toBeVisible();
	await openViewOptions(page);
	await page.getByRole("menuitem", { name: "Group by", exact: true }).click();
	const noSelect = page.getByRole("menuitem", {
		name: "No Select property",
		exact: true,
	});
	await expect(noSelect).toBeVisible();
	await expect(noSelect).toBeDisabled();
	expect(putCalls(await readProof(page))).toHaveLength(0);
	await page.keyboard.press("Escape");
});

test("read-only databases allow switching views but hide editing and creation controls", async ({
	page,
}) => {
	await openProof(page, "?readOnly=true");
	await expect(
		page.getByRole("button", { name: "View options", exact: true })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Add view", exact: true })
	).toHaveCount(0);

	await viewButton(page, "All records").dblclick();
	await expect(
		page.getByRole("textbox", { name: "Rename view All records" })
	).toHaveCount(0);
	await viewButton(page, "By status").click();
	await expectActiveAndUnselected(page, "By status", "All records");
	expect(putCalls(await readProof(page))).toHaveLength(0);
});
