import { expect, type Page, test } from "@playwright/test";

// Appearance → Date & time, driven by keyboard in a real Chromium against the
// existing timezone-picker story (the REAL TimezoneSetting beside a stamp
// formatted by the shared formatDateTime). Covers the "Select time zone"
// popup and the "Time zone" row's live preview, which the story spec does not
// assert: keyboard open/commit/cancel, IANA-id search, the empty state, and the
// preview clock that must keep moving on its own.

const STORY_URL = "/timezone-picker-story.html";
const NOW = new Date("2026-01-15T23:30:00.000Z");
const PREVIEW_OPTIONS = {
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
	month: "short",
	weekday: "short",
} as const;

test.describe.configure({ timeout: 90_000 });

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	pageErrors.set(page, errors);
	page.on("pageerror", (error) => errors.push(error.message));
	await page.clock.install({ time: NOW });
});
test.afterEach(({ page }) => {
	expect(pageErrors.get(page)).toEqual([]);
});

const trigger = (page: Page) =>
	page.locator("[data-slot='combobox-trigger']").first();
const popup = (page: Page) =>
	page.locator("[data-slot='combobox-content'][aria-label='Select time zone']");
const searchBox = (page: Page) =>
	page.getByPlaceholder("Search a city or zone…");

async function load(page: Page) {
	await page.goto(STORY_URL);
	await expect(trigger(page)).toBeVisible();
}

/** What the row must say for `zone` (null = the machine zone) at page time. */
async function expectedPreview(page: Page, zone: string | null) {
	return page.evaluate(
		({ options, timeZone }) => {
			const effective =
				timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
			const stamp = new Intl.DateTimeFormat(undefined, {
				...options,
				timeZone: effective,
			}).format(Date.now());
			return `Timestamps currently read ${stamp} · ${effective.replace(/_/g, " ")}.`;
		},
		{ options: PREVIEW_OPTIONS, timeZone: zone }
	);
}

function preview(page: Page) {
	return page.getByText(/^Timestamps currently read /);
}

async function openByKeyboard(page: Page) {
	await expect(searchBox(page)).toHaveCount(0);
	await trigger(page).focus();
	await page.keyboard.press("ArrowDown");
	await expect(popup(page)).toBeVisible();
	await expect(searchBox(page)).toBeFocused();
}

test("Select time zone opens from the keyboard, finds a zone by its IANA id, commits with Enter, and Escape or a miss leaves the zone unchanged", async ({
	page,
}) => {
	await load(page);
	const stored = () =>
		page.evaluate(() => localStorage.getItem("ryu:timezone"));
	expect(await stored()).toBeNull();

	await openByKeyboard(page);
	// The id as written in configs (underscore) matches the spaced label.
	await page.keyboard.type("los_angeles");
	await expect(popup(page).getByRole("option")).toHaveCount(1);
	await expect(popup(page).getByRole("option")).toHaveText(
		/America\/Los Angeles$/
	);
	await page.keyboard.press("Enter");
	await expect(popup(page)).toHaveCount(0);
	await expect(trigger(page)).toContainText("America/Los Angeles");
	await expect(trigger(page)).toBeFocused();
	expect(await stored()).toBe("America/Los_Angeles");
	await expect(page.getByTestId("sample-stamp")).toContainText("15:30");

	// A query that matches nothing shows the empty state and commits nothing.
	await openByKeyboard(page);
	await page.keyboard.type("atlantis");
	await expect(popup(page).getByText("No time zones found.")).toBeVisible();
	await expect(popup(page).getByRole("option")).toHaveCount(0);
	await page.keyboard.press("Enter");
	await page.keyboard.press("Escape");
	await expect(popup(page)).toHaveCount(0);
	expect(await stored()).toBe("America/Los_Angeles");

	// Escape abandons a highlighted match.
	await openByKeyboard(page);
	await page.keyboard.type("singapore");
	await expect(popup(page).getByRole("option")).toHaveCount(1);
	await page.keyboard.press("Escape");
	await expect(popup(page)).toHaveCount(0);
	await expect(trigger(page)).toContainText("America/Los Angeles");
	expect(await stored()).toBe("America/Los_Angeles");
	await expect(page.getByTestId("sample-stamp")).toContainText("15:30");
});

test("the Time zone row previews the chosen zone, follows a change at once, and keeps its clock moving on its own", async ({
	page,
}) => {
	await load(page);
	await expect(page.getByText("Time zone", { exact: true })).toBeVisible();
	await expect(preview(page)).toHaveText(await expectedPreview(page, null));

	await openByKeyboard(page);
	await page.keyboard.type("tokyo");
	await page.keyboard.press("Enter");
	await expect(trigger(page)).toContainText("(GMT+09:00) Asia/Tokyo");
	const tokyo = await expectedPreview(page, "Asia/Tokyo");
	expect(tokyo).toContain("8:30");
	expect(tokyo).toContain("Asia/Tokyo");
	await expect(preview(page)).toHaveText(tokyo);

	// The preview is a clock: with the tab left open it advances by itself.
	await page.clock.runFor(61_000);
	const later = await expectedPreview(page, "Asia/Tokyo");
	expect(later).toContain("8:31");
	await expect(preview(page)).toHaveText(later);

	// A reload starts from the persisted zone.
	await page.reload();
	await expect(trigger(page)).toContainText("Asia/Tokyo");
	await expect(preview(page)).toHaveText(
		await expectedPreview(page, "Asia/Tokyo")
	);
});
