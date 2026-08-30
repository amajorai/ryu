// Real-browser spec for the cowork-sources story (`e2e/harness/
// cowork-sources-story.{html,tsx}`), which mounts the REAL `CoworkContextPanel`
// over a fabricated message stream.
//
// The contract under test:
//   • each connector row states HOW MANY things it touched and expands to the
//     list — the old section rendered the connector name and nothing else;
//   • the items are the concrete things: file basenames, the shell command, the
//     search pattern, and the web LINKS a search returned (which live in the tool
//     OUTPUT, not the input, so a query-only implementation fails here);
//   • a `dynamic-tool` MCP call is attributed to its server rather than dropped,
//     which is how MCP tools arrive over the ACP bridge;
//   • expanding a group grows the enclosing accordion section instead of
//     clipping — the reason this is a browser spec at all.

import { expect, type Page, test } from "@playwright/test";

// Cold Vite compiles the whole panel module graph on first navigation.
test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/cowork-sources-story.html";

async function openSources(page: Page) {
	await page.goto(STORY_URL);
	const group = page.getByRole("button", { name: /^Local files/ });
	await expect(group).toBeVisible();
	return group;
}

test("connector rows carry a count and expand to what was touched", async ({
	page,
}) => {
	const group = await openSources(page);
	// Grep pattern + two files + one command.
	await expect(group).toHaveAttribute("aria-expanded", "false");
	await group.click();
	await expect(group).toHaveAttribute("aria-expanded", "true");
	const pinned = page.getByTestId("pinned-summary");

	await expect(
		pinned.getByText("effort-slider-row.tsx", { exact: true })
	).toBeVisible();
	await expect(
		pinned.getByText("effort-colors.ts", { exact: true })
	).toBeVisible();
	await expect(
		pinned.getByText("bun test src/lib/effort-colors.test.ts")
	).toBeVisible();
	await expect(pinned.getByText("effortFillColor")).toBeVisible();
	// The full path is the secondary line, so the row is unambiguous when two
	// files share a basename.
	await expect(
		pinned.getByText("/repo/apps/desktop/src/lib/effort-colors.ts")
	).toBeVisible();
});

test("summary headers keep counts beside the title and actions on the right", async ({
	page,
}) => {
	const sources = await openSources(page);
	const action = page.getByRole("button", { name: "Open all sources" });
	await expect(action).toBeVisible();
	await expect(
		page.locator(
			'[data-testid="pinned-summary"] [data-slot="bouncy-accordion-item-icon"]'
		)
	).toHaveCount(0);
	await expect(
		page.locator(
			'[data-testid="pinned-summary"] [data-slot="cowork-section-count"]'
		)
	).toHaveCount(1);
	await expect(page.getByRole("button", { name: /^Sources 4/ })).toBeVisible();

	const header = await sources.boundingBox();
	const actionBox = await action.boundingBox();
	expect(header).not.toBeNull();
	expect(actionBox).not.toBeNull();
	if (!(header && actionBox)) {
		return;
	}
	expect(actionBox.x).toBeGreaterThan(header.x + header.width - 80);
	await action.click();
	await expect(page.locator("body")).toHaveAttribute(
		"data-sources-opened",
		"true"
	);
	await expect(sources).toHaveAttribute("aria-expanded", "false");
});

test("pinned and workspace source lists use colored file-format icons", async ({
	page,
}) => {
	await openSources(page);
	const attachmentGroup = page.getByRole("button", {
		name: /^Chat attachments/,
	});
	await attachmentGroup.click();

	const pinned = page.getByTestId("pinned-summary");
	await expect(
		pinned.locator(
			'[data-file-path="Startup Runway v2.0.pdf"] svg.text-red-500'
		)
	).toHaveCount(1);
	await expect(
		pinned.locator(
			'[data-file-path="Startup_Runway_Weekly_Template_v2_Original.pptx"] svg.text-orange-600'
		)
	).toHaveCount(1);

	const workspace = page.getByTestId("workspace-sources-proof");
	await expect(
		workspace.locator(
			'[data-file-path="Startup Runway v2.0.pdf"] svg.text-red-500'
		)
	).toHaveCount(1);
	await expect(
		workspace.locator(
			'[data-file-path="Startup_Runway_Weekly_Template_v2_Original.pptx"] svg.text-orange-600'
		)
	).toHaveCount(1);
	await page.screenshot({
		fullPage: true,
		path: "test-results/cowork-sources-file-icons-proof.png",
	});
});

test("web sources list the links a search returned, not just the query", async ({
	page,
}) => {
	await openSources(page);
	const web = page.getByRole("button", { name: /^Web search/ });
	await web.click();
	const pinned = page.getByTestId("pinned-summary");

	await expect(pinned.getByText("Colour interpolation in CSS")).toBeVisible();
	await expect(pinned.getByText("Gamut mapping explained")).toBeVisible();
	await expect(
		pinned.getByText("https://evilmartians.com/gamut-mapping")
	).toBeVisible();
	// The fetched page and the query itself are both still accounted for.
	await expect(pinned.getByText("https://oklch.com/")).toBeVisible();
	await expect(
		pinned.getByText("oklch interpolation gamut clipping")
	).toBeVisible();
	// The pinned summary stops at five rows and provides the route to the complete
	// workspace-tab inventory rather than becoming an unbounded sidebar.
	await expect(pinned.getByText("+1 more items")).toBeVisible();
	await expect(pinned.getByText("OKLCH browser support")).not.toBeVisible();
});

test("an MCP call arriving as a dynamic tool is attributed to its server", async ({
	page,
}) => {
	await openSources(page);
	const linear = page.getByRole("button", { name: /^Linear/ });
	await expect(linear).toBeVisible();
	await linear.click();
	const pinned = page.getByTestId("pinned-summary");
	await expect(pinned.getByText("create issue")).toBeVisible();
	await expect(pinned.getByText("Brighten the dark-mode ramp")).toBeVisible();
});

test("expanding a group grows the section instead of clipping the list", async ({
	page,
}) => {
	const group = await openSources(page);
	const section = page.locator('[role="region"]').first();
	const before = await section.boundingBox();
	await group.click();
	await expect(
		page
			.getByTestId("pinned-summary")
			.getByText("effort-colors.ts", { exact: true })
	).toBeVisible();
	// The accordion measures its open height with a ResizeObserver; a nested
	// scroller would pin it and the new rows would be invisible below the fold.
	await expect
		.poll(async () => (await section.boundingBox())?.height ?? 0)
		.toBeGreaterThan(before?.height ?? 0);
});
