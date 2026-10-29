import type { ComponentProps } from "react";
import type { TabsContext } from "../src/contexts/TabsContext.tsx";

type NativeTabOptions = Parameters<
	NonNullable<ComponentProps<typeof TabsContext.Provider>["value"]>["openTab"]
>[1];

import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
	status: number;
}

interface TeamWire {
	coordination: string;
	created_at: number;
	description: string | null;
	id: string;
	lead_agent_id: string | null;
	members: string[];
	name: string;
	updated_at: number;
}

interface LibraryCollectionsSnapshot {
	conversations: Array<{ id: string; title: string | null }>;
	teams: TeamWire[];
}

interface LibraryCollectionsFixture {
	armFailure: (method: string, path: string, status?: number) => void;
	openedTabs: Array<{ options: NativeTabOptions; path: string }>;
	requests: CapturedRequest[];
	snapshot: () => LibraryCollectionsSnapshot;
}

interface LibraryCollectionsWindow extends Window {
	__libraryCollectionsFixture: LibraryCollectionsFixture;
}

const CHAT_ID = "library-collections-chat";
const AGENT_ID = "library-collections-agent";
const TEAM_ID = "library-collections-team";
const TEAM_NAME = "Release Review Group";
const RENAMED_TEAM = "Platform Readiness Group";
const TEAM_DESCRIPTION = "Reviews release changes";
const EVIDENCE_DIR = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

async function openLibrary(page: Page): Promise<void> {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	await page.goto("/library-collections-proof.html");
	await page.waitForFunction(
		() =>
			Boolean(
				/* SAFETY: library-collections-proof.tsx installs __libraryCollectionsFixture before this proof page is evaluated. */ (
					window as LibraryCollectionsWindow
				).__libraryCollectionsFixture
			),
		undefined,
		{ timeout: 10_000 }
	);
	if (
		!(await page
			.getByRole("tab", { name: "Recents" })
			.isVisible()
			.catch(() => false))
	) {
		throw new Error(
			`Library did not render Recents. Body: ${await page.locator("body").innerText()}; browser errors: ${browserErrors.join(" | ")}`
		);
	}
	await expect(page.getByRole("tab", { name: "Recents" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Regression chat from Library/ })
	).toBeVisible();
	if (browserErrors.length > 0) {
		throw new Error(
			`Library collections route errors: ${browserErrors.join(" | ")}`
		);
	}
}

async function fixtureSnapshot(page: Page): Promise<{
	fixture: LibraryCollectionsFixture;
	snapshot: LibraryCollectionsSnapshot;
}> {
	return await page.evaluate(() => {
		const fixture =
			/* SAFETY: library-collections-proof.tsx installs __libraryCollectionsFixture before this proof page is evaluated. */ (
				window as LibraryCollectionsWindow
			).__libraryCollectionsFixture;
		return { fixture, snapshot: fixture.snapshot() };
	});
}

async function armFailure(
	page: Page,
	method: string,
	requestPath: string,
	status = 503
): Promise<void> {
	await page.evaluate(
		({ method, requestPath, status }) =>
			/* SAFETY: library-collections-proof.tsx installs __libraryCollectionsFixture before this proof page is evaluated. */ (
				window as LibraryCollectionsWindow
			).__libraryCollectionsFixture.armFailure(method, requestPath, status),
		{ method, requestPath, status }
	);
}

async function capture(page: Page, filename: string): Promise<void> {
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE_DIR, filename),
	});
}

function searchBox(page: Page) {
	return page.getByRole("searchbox", { name: "Search your library…" });
}

function teamCard(page: Page, name = TEAM_NAME) {
	return page
		.getByRole("button")
		.filter({ has: page.getByText(name, { exact: true }) })
		.first();
}

async function openTeamMenu(page: Page, name: string): Promise<void> {
	await teamCard(page, name).click({ button: "right" });
	await expect(
		page.getByRole("menuitem", { name: "Delete", exact: true })
	).toBeVisible();
}

async function slideDelete(page: Page, label: string): Promise<void> {
	const slider = page.getByRole("slider", { name: label });
	await slider.focus();
	for (let step = 0; step < 5; step += 1) {
		await slider.press("ArrowRight");
	}
}

test.describe.configure({ timeout: 60_000 });

test("global Library search filters teams and resets search and type state across app tabs", async ({
	page,
}) => {
	await openLibrary(page);
	await expect(
		page.getByRole("button", { name: /Atlas Research Agent/ })
	).toBeVisible();

	// A non-empty query searches all collections, including the team records
	// surfaced by the page's shared Core data even though Groups owns a contributed
	// tab of its own.
	await searchBox(page).fill("Release Review");
	await expect(teamCard(page)).toBeVisible();
	await page.getByRole("button", { name: "Group", exact: true }).click();
	await expect(teamCard(page)).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Regression chat from Library/ })
	).toHaveCount(0);
	await capture(page, "desktop-library-collections-search-group-filter.png");

	// The Teams app now owns a source-backed Groups tab. Switching from Recents to
	// this app tab used to leave the query and selected type filter stuck because
	// the built-in section stand-in remained "recents" on both sides.
	await page.getByRole("tab", { name: "Groups" }).click();
	await expect(searchBox(page)).toHaveValue("");
	await expect(teamCard(page)).toBeVisible();
	await capture(page, "desktop-library-collections-groups-tab-reset.png");

	await page.getByRole("tab", { name: "Recents" }).click();
	await expect(searchBox(page)).toHaveValue("");
	await expect(
		page.getByRole("button", { name: /Regression chat from Library/ })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Atlas Research Agent/ })
	).toBeVisible();
	await capture(page, "desktop-library-collections-recents-filter-reset.png");

	const { fixture } = await fixtureSnapshot(page);
	expect(fixture.requests).toContainEqual({
		body: null,
		method: "GET",
		path: "/api/ext/@ryu/teams/",
		status: 200,
	});
});

test("the Recents create action opens a new chat with the expected tab intent", async ({
	page,
}) => {
	await openLibrary(page);
	await capture(page, "desktop-library-collections-recents-cta.png");
	await page.getByRole("button", { name: "New chat", exact: true }).click();
	await expect
		.poll(async () => (await fixtureSnapshot(page)).fixture.openedTabs)
		.toContainEqual({ options: { forceNew: true }, path: "/chat" });
});

test("editing a searched Group retries the Core save, and confirmed delete persists after reload", async ({
	page,
}) => {
	await openLibrary(page);
	await searchBox(page).fill("Release Review");
	const groupCard = teamCard(page);
	await expect(groupCard).toBeVisible();
	await groupCard.click();
	const dialog = page.getByRole("dialog", { name: "Edit group" });
	await expect(dialog).toBeVisible();
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(TEAM_NAME);
	await page.getByLabel("Name", { exact: true }).fill(RENAMED_TEAM);
	await armFailure(page, "PATCH", `/api/teams/${TEAM_ID}`);
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(dialog.getByText(/503/)).toBeVisible();
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		RENAMED_TEAM
	);
	await capture(page, "desktop-library-team-edit-error-draft.png");
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await searchBox(page).fill(RENAMED_TEAM);
	await expect(teamCard(page, RENAMED_TEAM)).toBeVisible();
	await expect
		.poll(async () => (await fixtureSnapshot(page)).snapshot.teams)
		.toContainEqual(
			expect.objectContaining({ id: TEAM_ID, name: RENAMED_TEAM })
		);
	const updateRequests = (await fixtureSnapshot(page)).fixture.requests.filter(
		(request) =>
			request.method === "PATCH" && request.path === `/api/teams/${TEAM_ID}`
	);
	expect(updateRequests.map((request) => request.status)).toEqual([503, 200]);
	expect(updateRequests.map((request) => request.body)).toEqual([
		{
			name: RENAMED_TEAM,
			description: TEAM_DESCRIPTION,
			members: [AGENT_ID],
			coordination: "broadcast",
			lead_agent_id: null,
		},
		{
			name: RENAMED_TEAM,
			description: TEAM_DESCRIPTION,
			members: [AGENT_ID],
			coordination: "broadcast",
			lead_agent_id: null,
		},
	]);

	await openTeamMenu(page, RENAMED_TEAM);
	await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
	let deleteDialog = page.getByRole("alertdialog", { name: "Delete group?" });
	await expect(deleteDialog).toBeVisible();
	await deleteDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(deleteDialog).toHaveCount(0);
	expect(
		(await fixtureSnapshot(page)).fixture.requests.filter(
			(request) =>
				request.method === "DELETE" && request.path === `/api/teams/${TEAM_ID}`
		)
	).toHaveLength(0);

	await openTeamMenu(page, RENAMED_TEAM);
	await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
	deleteDialog = page.getByRole("alertdialog", { name: "Delete group?" });
	await armFailure(page, "DELETE", `/api/teams/${TEAM_ID}`);
	await slideDelete(page, `Delete ${RENAMED_TEAM}`);
	await expect(deleteDialog.getByRole("alert")).toHaveText(
		`Couldn't delete ${RENAMED_TEAM}`
	);
	await expect(deleteDialog).toBeVisible();
	await expect(
		deleteDialog.getByRole("slider", { name: `Delete ${RENAMED_TEAM}` })
	).toHaveAttribute("aria-valuenow", "0");
	await expect
		.poll(async () => (await fixtureSnapshot(page)).snapshot.teams)
		.toContainEqual(
			expect.objectContaining({ id: TEAM_ID, name: RENAMED_TEAM })
		);
	await capture(page, "desktop-library-team-delete-error-retry.png");
	await expect(page.getByText(RENAMED_TEAM, { exact: true })).toBeVisible();

	await deleteDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(deleteDialog).toHaveCount(0);
	await openTeamMenu(page, RENAMED_TEAM);
	await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
	deleteDialog = page.getByRole("alertdialog", { name: "Delete group?" });
	await expect(deleteDialog.getByRole("alert")).toHaveCount(0);
	await slideDelete(page, `Delete ${RENAMED_TEAM}`);
	await expect(deleteDialog).toHaveCount(0);
	await expect
		.poll(async () => (await fixtureSnapshot(page)).snapshot.teams)
		.toEqual([]);
	await expect(page.getByText(RENAMED_TEAM, { exact: true })).toHaveCount(0);
	const deleteRequests = (await fixtureSnapshot(page)).fixture.requests.filter(
		(request) =>
			request.method === "DELETE" && request.path === `/api/teams/${TEAM_ID}`
	);
	expect(deleteRequests.map((request) => request.status)).toEqual([503, 200]);
	expect(deleteRequests.map((request) => request.body)).toEqual([null, null]);
	expect((await fixtureSnapshot(page)).snapshot.teams).toEqual([]);
	await page.reload();
	await expect(searchBox(page)).toHaveValue("");
	await searchBox(page).fill(RENAMED_TEAM);
	await expect(page.getByText("No results", { exact: true })).toBeVisible();
	await capture(page, "desktop-library-team-delete-readback.png");
});

test("the shared chat rename dialog cancels without writes and retains a failed draft for Enter retry", async ({
	page,
}) => {
	await openLibrary(page);
	const chat = page.getByRole("button", {
		name: /Regression chat from Library/,
	});
	await chat.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Rename…", exact: true }).click();
	let dialog = page.getByRole("dialog", {
		name: "Rename Regression chat from Library",
	});
	await expect(
		dialog.getByRole("heading", {
			name: "Rename Regression chat from Library",
		})
	).toBeVisible();
	await page.getByPlaceholder("Name").fill("Abandoned rename draft");
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	expect(
		(await fixtureSnapshot(page)).fixture.requests.filter(
			(request) =>
				request.method === "POST" &&
				request.path === `/api/conversations/${CHAT_ID}/title`
		)
	).toHaveLength(0);

	await chat.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Rename…", exact: true }).click();
	dialog = page.getByRole("dialog", {
		name: "Rename Regression chat from Library",
	});
	const input = page.getByPlaceholder("Name");
	await input.fill("Renamed chat from collections");
	await armFailure(page, "POST", `/api/conversations/${CHAT_ID}/title`);
	await dialog.getByRole("button", { name: "Rename", exact: true }).click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Couldn't rename Regression chat from Library"
	);
	await expect(dialog).toBeVisible();
	await expect(input).toHaveValue("Renamed chat from collections");
	await capture(page, "desktop-library-collections-rename-error-draft.png");
	await input.press("Enter");
	await expect(dialog).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: /Renamed chat from collections/ })
	).toBeVisible();
	const renameRequests = (await fixtureSnapshot(page)).fixture.requests.filter(
		(request) =>
			request.method === "POST" &&
			request.path === `/api/conversations/${CHAT_ID}/title`
	);
	expect(renameRequests.map((request) => request.status)).toEqual([503, 200]);
	expect(renameRequests.map((request) => request.body)).toEqual([
		{ title: "Renamed chat from collections" },
		{ title: "Renamed chat from collections" },
	]);
	await page.reload();
	await expect(
		page.getByRole("button", { name: /Renamed chat from collections/ })
	).toBeVisible();
	await capture(page, "desktop-library-collections-rename-readback.png");
});

declare global {
	interface Window {
		__libraryCollectionsFixture: LibraryCollectionsFixture;
	}
}
