// Real-browser spec for the shared command palette story (`e2e/harness/
// command-palette-story.{html,tsx}`), which mounts the REAL `@ryu/command/
// CommandPalette` — the same component the desktop's Cmd+K modal renders. The
// story frames it as a controlled dialog behind an open button, so this spec
// certifies the component's own behavior: dialog open, grouped rows, cmdk fuzzy
// filtering, empty state, and `onSelect`.
//
// SCOPE: the Cmd+K *keybinding* is owned by the desktop wrapper (useHotkey +
// contexts) and is NOT under test here — an isolated shared component can't carry
// it. The open button stands in for whatever the host wires the hotkey to.
//
// It navigates to its OWN story page (not the cert harness), so it waits on the
// story's open button rather than the cert's `__ryuCert` readiness signal.

import { expect, test } from "@playwright/test";

// The story pulls a large module graph; vite compiles it on first navigation, so
// allow generous headroom over the 30s default for cold-start CI runs.
test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/command-palette-story.html";

async function openPalette(page: import("@playwright/test").Page) {
	await page.goto(STORY_URL);
	await page.getByTestId("open-palette").click();
	await expect(
		page.getByPlaceholder("Search or run a command...")
	).toBeVisible();
}

test.describe("shared command palette — real component in isolation", () => {
	test("the palette is closed until the trigger opens it", async ({ page }) => {
		await page.goto(STORY_URL);
		await expect(
			page.getByPlaceholder("Search or run a command...")
		).toHaveCount(0);
		await page.getByTestId("open-palette").click();
		await expect(
			page.getByPlaceholder("Search or run a command...")
		).toBeVisible();
	});

	test("actions render under their first-seen group headings", async ({
		page,
	}) => {
		await openPalette(page);
		await expect(page.getByText("Navigation")).toBeVisible();
		await expect(page.getByText("Chat", { exact: true })).toBeVisible();
		await expect(page.getByText("Appearance")).toBeVisible();
		await expect(
			page.getByRole("option", { name: "Open Settings" })
		).toBeVisible();
		await expect(page.getByRole("option", { name: "Dark Mode" })).toBeVisible();
	});

	test("typing filters the rows via cmdk", async ({ page }) => {
		await openPalette(page);
		await page
			.getByPlaceholder("Search or run a command...")
			.fill("marketplace");
		await expect(
			page.getByRole("option", { name: "Open Marketplace" })
		).toBeVisible();
		// A row that does not match the query is filtered out.
		await expect(
			page.getByRole("option", { name: "New Chat" })
		).not.toBeVisible();
	});

	test("a query matching nothing shows the empty label", async ({ page }) => {
		await openPalette(page);
		await page
			.getByPlaceholder("Search or run a command...")
			.fill("zzz-no-such-command");
		await expect(page.getByText("No results.")).toBeVisible();
	});

	test("selecting a row invokes its onSelect", async ({ page }) => {
		await openPalette(page);
		const input = page.getByPlaceholder("Search or run a command...");
		await input.fill("settings");
		// cmdk auto-highlights the sole match; it is keyboard-first (the dialog's
		// inert backdrop intercepts synthetic clicks), so commit with Enter.
		await expect(
			page.getByRole("option", { name: "Open Settings" })
		).toBeVisible();
		await input.press("Enter");
		await expect(page.getByTestId("last-selected")).toHaveText("settings");
	});
});
