import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
	globalState,
	installBrowserFixtures,
	openMenu,
	type ProofState,
	selectAppearanceOption,
} from "./global-context-menu-proof.fixture.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

const STORY_URL = "/global-context-menu-proof.html";
const EVIDENCE_DIRECTORY = `${proofEvidencePath("test-coverage-sweep-20260924/evidence/global-context-menu")}/`;

test.beforeEach(async ({ page }) => {
	await mkdir(EVIDENCE_DIRECTORY, { recursive: true });
	await installBrowserFixtures(page);
	await page.setViewportSize({ width: 1440, height: 1000 });
});

test("right-click opens the real global menu, suppresses the browser menu, and closes on Escape", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await page.getByTestId("plain-copy-source").selectText();
	await expect
		.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ""))
		.toBe("Select this proof sentence to copy page text from the browser.");
	await page.evaluate(() => {
		const proofWindow =
			/* SAFETY: This fixture initialization defines __proofContextMenuPrevented on its own browser window. */ window as Window & {
				__proofContextMenuPrevented?: boolean;
			};
		document.addEventListener(
			"contextmenu",
			(event) => {
				proofWindow.__proofContextMenuPrevented = event.defaultPrevented;
			},
			{ capture: true, once: true }
		);
	});

	await openMenu(page, "plain-copy-source");
	await expect
		.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ""))
		.toBe("Select this proof sentence to copy page text from the browser.");
	await expect(
		page.getByRole("menuitem", { name: /^Copy Ctrl/ })
	).toBeEnabled();
	await expect(page.getByRole("menuitem", { name: /^Cut/ })).toBeDisabled();
	await expect(page.getByRole("menuitem", { name: /^Paste/ })).toBeDisabled();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: global-context-menu-proof.spec.ts installs __proofContextMenuPrevented before this proof page is evaluated. */ (
						window as Window & { __proofContextMenuPrevented?: boolean }
					).__proofContextMenuPrevented
			)
		)
		.toBe(true);
	await page.screenshot({
		fullPage: true,
		path: `${EVIDENCE_DIRECTORY}/global-context-menu-open.png`,
	});

	await page.keyboard.press("Escape");
	await expect(page.getByRole("menu")).toHaveCount(0);
});

test("copy, cut, paste, select-all, and edit-action gates follow real text selection", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await page.getByTestId("plain-copy-source").selectText();
	await expect
		.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ""))
		.toBe("Select this proof sentence to copy page text from the browser.");
	await openMenu(page, "plain-copy-source");
	await expect
		.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ""))
		.toBe("Select this proof sentence to copy page text from the browser.");
	await page.getByRole("menuitem", { name: /^Copy Ctrl/ }).click();
	await expect
		.poll(async () => (await globalState(page)).clipboardText)
		.toBe("Select this proof sentence to copy page text from the browser.");

	const editor = page.getByTestId("editor");
	await page.evaluate(() => {
		const input = document.querySelector<HTMLInputElement>("#proof-editor");
		if (!input) {
			throw new Error("Text editor did not render");
		}
		input.focus();
		input.setSelectionRange(6, 10);
	});
	await openMenu(page, "editor");
	const editMenuDiagnostics = await page.evaluate(() => {
		const proofWindow =
			/* SAFETY: This fixture initialization defines __RYU_GLOBAL_CONTEXT_MENU_PROOF__ on its own browser window. */ window as Window & {
				__RYU_GLOBAL_CONTEXT_MENU_PROOF__: ProofState;
			};
		const input = document.querySelector<HTMLInputElement>("#proof-editor");
		return {
			activeElement:
				document.activeElement instanceof HTMLElement
					? document.activeElement.id || document.activeElement.tagName
					: null,
			activeOnContextMenu:
				proofWindow.__RYU_GLOBAL_CONTEXT_MENU_PROOF__.activeOnContextMenu,
			inputRange: input ? [input.selectionStart, input.selectionEnd] : null,
			windowSelection: window.getSelection()?.toString() ?? "",
		};
	});
	expect(editMenuDiagnostics.activeOnContextMenu).toBe("proof-editor");
	expect(editMenuDiagnostics.inputRange).toEqual([6, 10]);
	await expect(page.getByRole("menuitem", { name: /^Cut/ })).toBeEnabled();
	await expect(
		page.getByRole("menuitem", { name: /^Copy Ctrl/ })
	).toBeEnabled();
	await expect(page.getByRole("menuitem", { name: /^Paste/ })).toBeEnabled();
	await page.getByRole("menuitem", { name: /^Copy Ctrl/ }).click();
	await expect
		.poll(async () => (await globalState(page)).clipboardText)
		.toBe("beta");

	await page.evaluate(() => {
		const input = document.querySelector<HTMLInputElement>("#proof-editor");
		if (!input) {
			throw new Error("Text editor did not render");
		}
		input.focus();
		input.setSelectionRange(6, 10);
	});
	await openMenu(page, "editor");
	await page.getByRole("menuitem", { name: /^Cut/ }).click();
	await expect(editor).toHaveValue("alpha  gamma");
	await expect
		.poll(async () => (await globalState(page)).clipboardText)
		.toBe("beta");

	await page.evaluate(() => {
		const input = document.querySelector<HTMLInputElement>("#proof-editor");
		if (!input) {
			throw new Error("Text editor did not render");
		}
		input.focus();
		input.setSelectionRange(6, 6);
	});
	await openMenu(page, "editor");
	const pasteState = await page.evaluate(() => {
		const input = document.querySelector<HTMLInputElement>("#proof-editor");
		const proofWindow =
			/* SAFETY: This fixture initialization defines __RYU_GLOBAL_CONTEXT_MENU_PROOF__ on its own browser window. */ window as Window & {
				__RYU_GLOBAL_CONTEXT_MENU_PROOF__: ProofState;
			};
		if (!input) {
			throw new Error("Text editor did not render");
		}
		return {
			clipboardText:
				proofWindow.__RYU_GLOBAL_CONTEXT_MENU_PROOF__.clipboardText,
			end: input.selectionEnd ?? input.value.length,
			start: input.selectionStart ?? input.value.length,
			value: input.value,
		};
	});
	await page.getByRole("menuitem", { name: /^Paste/ }).click();
	await expect(editor).toHaveValue(
		pasteState.value.slice(0, pasteState.start) +
			pasteState.clipboardText +
			pasteState.value.slice(pasteState.end)
	);

	await page.evaluate(() => {
		const input = document.querySelector<HTMLInputElement>("#proof-editor");
		if (!input) {
			throw new Error("Text editor did not render");
		}
		input.focus();
		input.setSelectionRange(1, 2);
	});
	await openMenu(page, "editor");
	await page.getByRole("menuitem", { name: /^Select All/ }).click();
	await expect
		.poll(() =>
			editor.evaluate((el) => {
				if (!(el instanceof HTMLInputElement)) {
					throw new Error("Expected proof element to be an HTMLInputElement.");
				}
				return el.selectionStart;
			})
		)
		.toBe(0);
	await expect
		.poll(() =>
			editor.evaluate((el) => {
				if (!(el instanceof HTMLInputElement)) {
					throw new Error("Expected proof element to be an HTMLInputElement.");
				}
				return el.selectionEnd;
			})
		)
		.toBe("alpha beta gamma".length);
	const state = await globalState(page);
	expect(state.execCommands).toEqual(
		expect.arrayContaining(["copy", "cut", "paste", "selectAll"])
	);
});

test("zoom clamps at both bounds, resets, and restores the stored value after reload", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await page.evaluate(() => localStorage.setItem("ryu_ui_scale", "1.95"));
	await page.reload();
	await expect(page.locator("html")).toHaveCSS("zoom", "1.95");

	await openMenu(page);
	await page.getByRole("menuitem", { name: /^Zoom In/ }).click();
	await expect(page.locator("html")).toHaveCSS("zoom", "2");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_ui_scale")))
		.toBe("2");
	await openMenu(page);
	await page.getByRole("menuitem", { name: /^Zoom In/ }).click();
	await expect(page.locator("html")).toHaveCSS("zoom", "2");

	await page.reload();
	await expect(page.locator("html")).toHaveCSS("zoom", "2");
	await openMenu(page);
	await page.getByRole("menuitem", { name: /^Zoom Out/ }).click();
	await expect(page.locator("html")).toHaveCSS("zoom", "1.95");

	await page.evaluate(() => localStorage.setItem("ryu_ui_scale", "0.51"));
	await page.reload();
	await expect(page.locator("html")).toHaveCSS("zoom", "0.51");
	await openMenu(page);
	await page.getByRole("menuitem", { name: /^Zoom Out/ }).click();
	await expect(page.locator("html")).toHaveCSS("zoom", "0.5");
	await openMenu(page);
	await page.getByRole("menuitem", { name: /^Zoom Out/ }).click();
	await expect(page.locator("html")).toHaveCSS("zoom", "0.5");
	await openMenu(page);
	await page.getByRole("menuitem", { name: /^Actual Size/ }).click();
	await expect(page.locator("html")).toHaveCSS("zoom", "1");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_ui_scale")))
		.toBe("1");
});

test("Appearance choices update and persist theme state, and appearance settings opens the correct section", async ({
	page,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await page.goto(STORY_URL);
	await expect(page.getByTestId("theme-state")).toHaveAttribute(
		"data-theme",
		"system"
	);
	await expect(page.getByTestId("theme-state")).toHaveAttribute(
		"data-resolved-theme",
		"dark"
	);

	await openMenu(page);
	await page.getByRole("menuitem", { name: "Appearance", exact: true }).hover();
	await expect(page.getByRole("menuitem", { name: /^Light/ })).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: `${EVIDENCE_DIRECTORY}/global-context-menu-appearance.png`,
	});
	await page.getByRole("menuitem", { name: /^Light/ }).click();
	await expect(page.getByTestId("theme-state")).toHaveAttribute(
		"data-theme",
		"light"
	);
	await expect(page.getByTestId("theme-state")).toHaveAttribute(
		"data-resolved-theme",
		"light"
	);

	await selectAppearanceOption(page, "Dark");
	await expect(page.getByTestId("theme-state")).toHaveAttribute(
		"data-theme",
		"dark"
	);
	await expect(page.getByTestId("theme-state")).toHaveAttribute(
		"data-resolved-theme",
		"dark"
	);
	await selectAppearanceOption(page, "System");
	await expect(page.getByTestId("theme-state")).toHaveAttribute(
		"data-theme",
		"system"
	);
	await expect(page.getByTestId("theme-state")).toHaveAttribute(
		"data-resolved-theme",
		"dark"
	);
	await page.reload();
	await expect(page.getByTestId("theme-state")).toHaveAttribute(
		"data-theme",
		"system"
	);
	await expect(page.getByTestId("theme-state")).toHaveAttribute(
		"data-resolved-theme",
		"dark"
	);

	await selectAppearanceOption(page, "Appearance settings");
	await expect(page.getByTestId("settings-state")).toHaveAttribute(
		"data-open",
		"true"
	);
	await expect(page.getByTestId("settings-state")).toHaveAttribute(
		"data-section",
		"appearance"
	);
});

test("Settings opens the default General section", async ({ page }) => {
	await page.goto(STORY_URL);
	await openMenu(page);
	await page.getByRole("menuitem", { name: /^Settings/ }).click();
	await expect(page.getByTestId("settings-state")).toHaveAttribute(
		"data-open",
		"true"
	);
	await expect(page.getByTestId("settings-state")).toHaveAttribute(
		"data-section",
		"general"
	);
});

test("fullscreen and DevTools stay inside browser and Tauri-local boundaries", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await openMenu(page);
	await page.getByRole("menuitem", { name: "Enter Full Screen" }).click();
	const fullscreenDiagnostics = await page.evaluate(() => {
		const proofWindow =
			/* SAFETY: This fixture initialization defines __RYU_GLOBAL_CONTEXT_MENU_PROOF__ on its own browser window. */ window as Window & {
				__RYU_GLOBAL_CONTEXT_MENU_PROOF__: ProofState;
				__TAURI_INTERNALS__?: unknown;
			};
		return {
			fullscreen: proofWindow.__RYU_GLOBAL_CONTEXT_MENU_PROOF__.fullscreen,
			fullscreenRequests:
				proofWindow.__RYU_GLOBAL_CONTEXT_MENU_PROOF__.fullscreenRequests,
			hasTauriBridge: Boolean(proofWindow.__TAURI_INTERNALS__),
			requestFullscreen: String(document.documentElement.requestFullscreen),
		};
	});
	if (fullscreenDiagnostics.fullscreenRequests !== 1) {
		throw new Error(
			`Browser fullscreen fixture was not called: ${JSON.stringify(fullscreenDiagnostics)}`
		);
	}
	await expect
		.poll(async () => (await globalState(page)).fullscreenRequests)
		.toBe(1);
	await expect(page.getByTestId("fullscreen-state")).toHaveAttribute(
		"data-fullscreen",
		"true"
	);
	await openMenu(page);
	await page.getByRole("menuitem", { name: "Exit Full Screen" }).click();
	await expect(page.getByTestId("fullscreen-state")).toHaveAttribute(
		"data-fullscreen",
		"false"
	);
	await expect
		.poll(async () => (await globalState(page)).fullscreenRequests)
		.toBe(2);
	await openMenu(page);
	await page.getByRole("menuitem", { name: "Toggle DevTools" }).click();
	await expect(
		page.getByText("DevTools are only available in the desktop app.")
	).toBeVisible();
	expect((await globalState(page)).tauriCalls).toEqual([]);
});

test("Tauri fixture receives fullscreen and DevTools commands without native APIs", async ({
	page,
}) => {
	await page.goto(`${STORY_URL}?native=1`);
	await openMenu(page);
	await page.getByRole("menuitem", { name: "Toggle DevTools" }).click();
	await expect
		.poll(async () => (await globalState(page)).devtoolsToggles)
		.toBe(1);
	await openMenu(page);
	await page.getByRole("menuitem", { name: "Enter Full Screen" }).click();
	await expect(page.getByTestId("fullscreen-state")).toHaveAttribute(
		"data-fullscreen",
		"true"
	);
	const nativeCommands = (await globalState(page)).tauriCalls.map(
		({ command }) => command
	);
	expect(nativeCommands).toContain("toggle_devtools");
	expect(nativeCommands).toContain("toggle_fullscreen");
});

test("Reload reloads the rendered surface and preserves local appearance preferences", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await selectAppearanceOption(page, "Dark");
	await expect(page.getByTestId("theme-state")).toHaveAttribute(
		"data-theme",
		"dark"
	);
	const before = (await globalState(page)).pageLoads;
	await openMenu(page);
	const navigated = page.waitForEvent("framenavigated");
	await page.getByRole("menuitem", { name: /^Reload/ }).click();
	await navigated;
	await expect
		.poll(async () => (await globalState(page)).pageLoads)
		.toBe(before + 1);
	await expect(page.getByTestId("theme-state")).toHaveAttribute(
		"data-theme",
		"dark"
	);
	await expect(page.getByTestId("theme-state")).toHaveAttribute(
		"data-resolved-theme",
		"dark"
	);
});

test("Copy console reports an empty buffer and copies captured local output", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await openMenu(page);
	await page
		.getByRole("menuitem", { name: "Copy console", exact: true })
		.click();
	await expect(page.getByText("Console buffer is empty.")).toBeVisible();

	await page.evaluate(() =>
		console.info("global-context-menu fixture console line")
	);
	await openMenu(page);
	await page
		.getByRole("menuitem", { name: "Copy console", exact: true })
		.click();
	await expect
		.poll(async () => (await globalState(page)).clipboardText)
		.toContain("INFO global-context-menu fixture console line");
	await expect(page.getByText("Console copied")).toBeVisible();
});

test("Report a bug copies screenshot and route context, then opens only the local UserJot fixture", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await openMenu(page);
	await page
		.getByRole("menuitem", { name: "Report a bug…", exact: true })
		.click();
	await expect(page.getByText("Report a bug", { exact: true })).toBeVisible();
	await expect(
		page.getByText(/Screenshot and page context are on the clipboard/)
	).toBeVisible();
	await expect
		.poll(async () => (await globalState(page)).viewportCaptures)
		.toBe(1);
	await expect
		.poll(async () => (await globalState(page)).externalOpenRequests)
		.toEqual(["https://ryuhq.userjot.com/"]);
	const proof = await globalState(page);
	const reportClipboardItem = proof.clipboardItems.find(
		(item) =>
			item.types.includes("image/png") && item.types.includes("text/plain")
	);
	expect(reportClipboardItem).toBeDefined();
	expect(reportClipboardItem?.pngBytes).toBeGreaterThan(0);
	expect(reportClipboardItem?.text).toContain("Ryu bug report context");
	expect(reportClipboardItem?.text).toContain(
		"Route: Global Context Menu Proof (/proof/global-context-menu)"
	);
	expect(reportClipboardItem?.text).toContain(
		"URL: http://127.0.0.1:5447/global-context-menu-proof.html"
	);
	await page.screenshot({
		fullPage: true,
		path: `${EVIDENCE_DIRECTORY}/global-context-menu-report-toast.png`,
	});
});
