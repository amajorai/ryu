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

// The universal InputBar pulls a large module graph; Vite compiles it on first
// navigation, so allow generous headroom for cold-start CI runs.
test.describe.configure({ timeout: 180_000 });

const STORY_URL = "/command-palette-story.html";

async function openPalette(page: import("@playwright/test").Page) {
	await page.goto(STORY_URL);
	await page.getByTestId("open-palette").click();
	await expect(page.getByPlaceholder("Search or run a command…")).toBeVisible();
}

test.describe("shared command palette — real component in isolation", () => {
	test("the palette is closed until the trigger opens it", async ({ page }) => {
		await page.goto(STORY_URL);
		await expect(page.getByPlaceholder("Search or run a command…")).toHaveCount(
			0
		);
		await page.getByTestId("open-palette").click();
		await expect(
			page.getByPlaceholder("Search or run a command…")
		).toBeVisible();
	});

	test("actions render under their first-seen group headings", async ({
		page,
	}, testInfo) => {
		await openPalette(page);
		await expect(page.getByText("Navigation")).toBeVisible();
		await expect(page.getByText("Chat", { exact: true })).toBeVisible();
		await expect(page.getByText("Appearance")).toBeVisible();
		await expect(
			page.getByRole("option", { name: "Open Settings" })
		).toBeVisible();
		await expect(page.getByRole("option", { name: "Dark Mode" })).toBeVisible();
		await page.screenshot({
			path: testInfo.outputPath("command-palette-proof.png"),
			fullPage: true,
		});
	});

	test("result tabs filter built-ins and app-contributed sections", async ({
		page,
	}) => {
		await openPalette(page);
		const tabList = page.getByRole("tablist", {
			name: "Search result types",
		});
		await expect(tabList).toHaveAttribute("data-variant", "muted-pills");
		await expect(page.getByRole("tab", { name: "Spaces" })).toBeVisible();
		await expect(page.getByRole("tab", { name: "Canvas" })).toBeVisible();

		await page.getByRole("tab", { name: "Spaces" }).click();
		await expect(
			page.getByRole("option", { name: "Product Roadmap" })
		).toBeVisible();
		await expect(
			page.getByRole("option", { name: "New Chat" })
		).not.toBeVisible();

		await page.getByRole("tab", { name: "Canvas" }).click();
		await expect(
			page.getByRole("option", { name: "Launch Canvas" })
		).toBeVisible();
		await expect(
			page.getByRole("option", { name: "Product Roadmap" })
		).not.toBeVisible();
	});

	test("typing filters the rows via cmdk", async ({ page }) => {
		await openPalette(page);
		await page.getByPlaceholder("Search or run a command…").fill("marketplace");
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
			.getByPlaceholder("Search or run a command…")
			.fill("zzz-no-such-command");
		await expect(page.getByText("No results.")).toBeVisible();
	});

	test("selecting a row invokes its onSelect", async ({ page }) => {
		await openPalette(page);
		const input = page.getByPlaceholder("Search or run a command…");
		await input.fill("settings");
		// cmdk auto-highlights the sole match; it is keyboard-first (the dialog's
		// inert backdrop intercepts synthetic clicks), so commit with Enter.
		await expect(
			page.getByRole("option", { name: "Open Settings" })
		).toBeVisible();
		await input.press("Enter");
		await expect(page.getByTestId("last-selected")).toHaveText("settings");
	});

	test("Tab switches to Compose and the composer sends the draft", async ({
		page,
	}, testInfo) => {
		await openPalette(page);
		const searchTab = page.getByRole("tab", { name: "Search" });
		const composeTab = page.getByRole("tab", { name: "Compose" });
		const input = page.getByPlaceholder("Search or run a command…");

		await input.press("Tab");
		await expect(composeTab).toHaveAttribute("aria-selected", "true");
		const composer = page.getByPlaceholder("Write a message…");
		await expect(page.locator('[data-composer-layout="full"]')).toBeVisible();
		const dialog = page.getByRole("dialog");
		const dialogTop = await dialog.evaluate(
			(element) => element.getBoundingClientRect().top
		);
		const entryTop = await dialog
			.locator(".composer-container")
			.evaluate((element) => element.getBoundingClientRect().top);
		const topInset = entryTop - dialogTop;
		expect(topInset).toBeGreaterThanOrEqual(9);
		expect(topInset).toBeLessThanOrEqual(10.5);
		await composer.focus();
		await expect(composer).toBeFocused();
		const sendHint = page.getByTestId("compose-send-shortcut");
		const sendButton = page.getByRole("button", { name: "Send" });
		await expect(sendHint).toBeVisible();
		await expect(sendButton).toBeVisible();
		const sendHintLeft = await sendHint.evaluate(
			(element) => element.getBoundingClientRect().left
		);
		const sendButtonLeft = await sendButton.evaluate(
			(element) => element.getBoundingClientRect().left
		);
		expect(sendHintLeft).toBeLessThan(sendButtonLeft);
		await composer.fill("Plan the next release");
		await expect(sendButton).toBeEnabled();
		const proofPath = process.env.RYU_GLOBAL_SEARCH_COMPOSE_PROOF_PATH;
		await page.screenshot({
			path: proofPath ?? testInfo.outputPath("global-search-compose-proof.png"),
			fullPage: true,
		});

		await composer.press("Tab");
		await expect(searchTab).toHaveAttribute("aria-selected", "true");
		await expect(input).toBeFocused();
		await input.press("Tab");
		await expect(composeTab).toHaveAttribute("aria-selected", "true");
		await expect(composer).toHaveValue("Plan the next release");
		await composer.press("Enter");
		await expect(page.getByTestId("last-selected")).toHaveText(
			"compose:Plan the next release"
		);

		await page.getByTestId("open-palette").click();
		await page.getByRole("tab", { name: "Compose" }).click();
		await composer.fill("Send from the button");
		await expect(sendButton).toBeEnabled();
		await sendButton.click();
		await expect(page.getByTestId("last-selected")).toHaveText(
			"compose:Send from the button"
		);
	});

	test("the Compose attachment action invokes its handler", async ({
		page,
	}) => {
		await openPalette(page);
		await page.getByRole("tab", { name: "Compose" }).click();
		const addButton = page.getByRole("button", { exact: true, name: "Add" });
		await expect(addButton).toBeVisible();
		await addButton.click();
		const attachAction = page.getByRole("option", {
			exact: true,
			name: "Files and images",
		});
		await expect(attachAction).toBeVisible();
		await attachAction.click();
		await expect(page.getByTestId("last-selected")).toHaveText(
			"compose:attach"
		);
	});
});
