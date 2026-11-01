// Real-browser spec for the contributed-sidebar-section story (`e2e/harness/
// contributed-section-story.{html,tsx}`), which mounts the REAL
// `DynamicSidebarSection` with the Agent Status app's "Working" spec against a
// stubbed `/api/runs`.
//
// What it certifies, none of which a type-check can see:
//   • `source.filter` really slices the endpoint (the `completed` run is absent,
//     so Working and Done can be two sections over one feed);
//   • a row whose mapped subtitle resolves shows it in its hover preview, and a
//     row whose does not shows none (rows are one line since 306ce31b7f);
//   • `subtitleTransform: "basename"` shows the PROJECT (`ryu-closed`), not the
//     absolute folder path;
//   • an `itemTarget` carrying an allowlisted query parameter opens a
//     conversation — `openTab("/chat", { conversationId })` — which is otherwise
//     unreachable from a manifest, since `/chat` is the only registered route.

import { expect, test } from "@playwright/test";

// The story pulls the full AppSidebar module graph; vite compiles it on first
// navigation, so allow headroom over the 30s default for cold-start CI runs.
test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/contributed-section-story.html";

/** The clickable row element for a run title (the row div owns the height). */
function row(page: import("@playwright/test").Page, title: string) {
	return page.locator('div[role="button"]', { hasText: title }).first();
}

test.describe("app-contributed sidebar section — real component in isolation", () => {
	test("renders only the rows its filter keeps", async ({ page }) => {
		await page.goto(STORY_URL);
		await expect(page.getByText("Working")).toBeVisible();
		await expect(page.getByText("Fix the flaky auth test")).toBeVisible();
		await expect(page.getByText("Draft the release notes")).toBeVisible();
		// `run_status: "completed"` — filtered out, so Done can list it instead.
		await expect(page.getByText("Ship the sidebar")).toHaveCount(0);
	});

	test("shows the project in the row's hover preview, and only when there is one", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		// Since 306ce31b7f (P2) every contributed row is one h-8 line and its
		// subtitle moves into the hover preview, so both rows share a height and
		// the project shows only once its row is hovered.
		const withProject = row(page, "Fix the flaky auth test");
		const withoutProject = row(page, "Draft the release notes");
		const tall = await withProject.boundingBox();
		const short = await withoutProject.boundingBox();
		expect(tall?.height ?? 0).toBe(short?.height ?? -1);
		await expect(page.getByText("ryu-closed", { exact: true })).toHaveCount(0);

		const preview = page.locator('[data-slot="hover-card-content"]');
		await page.getByText("Fix the flaky auth test").hover();
		// The basename of `/Users/dev/code/ryu-closed`, not the whole path.
		await expect(
			preview.getByText("ryu-closed", { exact: true })
		).toBeVisible();
		await expect(preview).not.toContainText("/Users/dev/code");

		await page.mouse.move(0, 0);
		await expect(preview).toHaveCount(0);
		await page.getByText("Draft the release notes").hover();
		await expect(preview).toContainText("Draft the release notes");
		await expect(preview.getByText("ryu-closed", { exact: true })).toHaveCount(
			0
		);
	});

	test("clicking a row opens its conversation, not a blank chat", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await row(page, "Fix the flaky auth test").click();
		await expect(page.getByTestId("opened")).toHaveText("/chat :: run-alpha");
	});
});
