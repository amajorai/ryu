// Real-browser spec for the sidebar overflow popover story (`e2e/harness/
// overflow-story.{html,tsx}`), which mounts the REAL `SectionOverflowPopover`
// exported from `src/components/layout/AppSidebar.tsx` with 55 mock rows. This is
// the "sidebar renders" slice of the desktop shell that IS reachable in isolation:
// the popover is a self-contained, prop-driven component (client-side search +
// in-memory windowing), so no Core, Tauri, or seed data is needed.
//
// The component's contract (from AppSidebar.tsx):
//   • trigger reads "Show <remaining> more" (story: remaining = 55 - 10 = 45);
//   • opening resets the query and autofocuses the search field;
//   • the search input filters by case-insensitive substring of `getSearchText`;
//   • an empty result set renders "No matches";
//   • rows carry `data-testid="row"`.
//
// HARNESS LIMIT: the popover's infinite-scroll WINDOW (30 rows/step, grown by an
// IntersectionObserver on a sentinel) is NOT asserted here. The window only stays
// capped while the `max-h-80` + `overflow-y-auto` container actually clips and
// scrolls, but this bare harness ships no Tailwind plugin, so those utilities are
// never generated: `scrollHeight === clientHeight`, the sentinel is always in
// view, and the observer floods the window to the full list. The SEARCH behavior
// (what the popover exists for) is independent of the window and fully covered;
// the window-growth path belongs to a full-app run.
//
// It navigates to its OWN story page, so it waits on the trigger button rather
// than the cert harness's `__ryuCert` readiness signal.

import { expect, test } from "@playwright/test";

// The story pulls the full AppSidebar module graph; vite compiles it on first
// navigation, so allow headroom over the 30s default for cold-start CI runs.
test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/overflow-story.html";
const TOTAL_ROWS = 55;

async function openPopover(page: import("@playwright/test").Page) {
	await page.goto(STORY_URL);
	const trigger = page.getByRole("button", { name: /Show \d+ more/ });
	await expect(trigger).toBeVisible();
	await trigger.click();
	// The search field is the popover's primary action and autofocuses on open.
	await expect(page.getByPlaceholder("Search items")).toBeVisible();
}

test.describe("sidebar overflow popover — real component in isolation", () => {
	test("trigger advertises the remaining count", async ({ page }) => {
		await page.goto(STORY_URL);
		// 55 total, first page shows 10 → 45 remaining.
		await expect(
			page.getByRole("button", { name: "Show 45 more" })
		).toBeVisible();
	});

	test("opening the popover renders the section's rows", async ({ page }) => {
		await openPopover(page);
		// The first row of the section is present, and the count never exceeds the
		// backing list.
		await expect(page.getByTestId("row").first()).toHaveText("Item 00");
		const count = await page.getByTestId("row").count();
		expect(count).toBeGreaterThan(0);
		expect(count).toBeLessThanOrEqual(TOTAL_ROWS);
	});

	test("search filters rows by case-insensitive substring", async ({
		page,
	}) => {
		await openPopover(page);
		// "Item 42" is a single unique row; the query is lower-case, the row Title-case.
		await page.getByPlaceholder("Search items").fill("item 42");
		await expect(page.getByTestId("row")).toHaveCount(1);
		await expect(page.getByTestId("row")).toHaveText("Item 42");
	});

	test("a prefix matches every row sharing it", async ({ page }) => {
		await openPopover(page);
		// "Item 1" matches Item 10–19 → exactly 10 rows.
		await page.getByPlaceholder("Search items").fill("Item 1");
		await expect(page.getByTestId("row")).toHaveCount(10);
	});

	test("a non-matching query shows the empty state", async ({ page }) => {
		await openPopover(page);
		await page.getByPlaceholder("Search items").fill("no-such-row-zzz");
		await expect(page.getByTestId("row")).toHaveCount(0);
		await expect(page.getByText("No matches")).toBeVisible();
	});

	test("clearing the query brings filtered-out rows back", async ({ page }) => {
		await openPopover(page);
		const search = page.getByPlaceholder("Search items");
		await search.fill("Item 42");
		// While filtered, a non-matching row is gone.
		await expect(page.getByTestId("row")).toHaveCount(1);
		await expect(page.getByText("Item 00", { exact: true })).toHaveCount(0);
		// Clearing restores the full unfiltered list, so "Item 00" is back.
		await search.fill("");
		await expect(page.getByText("Item 00", { exact: true })).toBeVisible();
	});
});
