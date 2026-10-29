import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const STORY_URL = "/global-context-menu-proof.html";
const EVIDENCE_DIRECTORY = fileURLToPath(
	new URL(
		"../../../docs/proof/test-coverage-sweep-20260924/evidence/global-context-menu/",
		import.meta.url
	)
);

interface ProofState {
	activeOnContextMenu: string | null;
	clipboardItems: Array<{
		pngBytes: number;
		text: string | null;
		types: string[];
	}>;
	clipboardText: string;
	clipboardTextWrites: string[];
	devtoolsToggles: number;
	execCommands: string[];
	externalOpenRequests: string[];
	fullscreen: boolean;
	fullscreenRequests: number;
	pageLoads: number;
	tauriCalls: Array<{ args: unknown; command: string }>;
	viewportCaptures: number;
}

async function installBrowserFixtures(page: Page) {
	await page.addInitScript(() => {
		interface LocalProofState {
			activeOnContextMenu: string | null;
			clipboardItems: Array<{
				pngBytes: number;
				text: string | null;
				types: string[];
			}>;
			clipboardText: string;
			clipboardTextWrites: string[];
			devtoolsToggles: number;
			execCommands: string[];
			externalOpenRequests: string[];
			fullscreen: boolean;
			fullscreenRequests: number;
			pageLoads: number;
			tauriCalls: Array<{ args: unknown; command: string }>;
			viewportCaptures: number;
		}

		const loadsKey = "__ryu_global_context_menu_page_loads";
		const pageLoads = Number(localStorage.getItem(loadsKey) ?? "0") + 1;
		localStorage.setItem(loadsKey, String(pageLoads));
		const state: LocalProofState = {
			clipboardText: "",
			clipboardTextWrites: [],
			clipboardItems: [],
			externalOpenRequests: [],
			fullscreen: false,
			fullscreenRequests: 0,
			devtoolsToggles: 0,
			pageLoads,
			tauriCalls: [],
			viewportCaptures: 0,
			execCommands: [],
			activeOnContextMenu: null,
		};
		const proofWindow =
			/* SAFETY: This fixture initialization defines __RYU_GLOBAL_CONTEXT_MENU_PROOF__ on its own browser window. */ window as Window & {
				__RYU_GLOBAL_CONTEXT_MENU_PROOF__?: LocalProofState;
				__TAURI_INTERNALS__?: {
					invoke: (
						command: string,
						args?: { url?: string }
					) => Promise<boolean | undefined>;
					transformCallback: (...args: unknown[]) => number;
				};
			};
		proofWindow.__RYU_GLOBAL_CONTEXT_MENU_PROOF__ = state;

		class LocalClipboardItem {
			readonly types: string[];

			constructor(readonly values: Record<string, Blob>) {
				this.types = Object.keys(values);
			}

			getType(type: string): Promise<Blob> {
				const value = this.values[type];
				return value
					? Promise.resolve(value)
					: Promise.reject(new Error(`Missing local clipboard type ${type}`));
			}
		}

		Object.defineProperty(globalThis, "ClipboardItem", {
			configurable: true,
			value: LocalClipboardItem,
		});
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				readText: async () => state.clipboardText,
				writeText: async (text: string) => {
					state.clipboardText = text;
					state.clipboardTextWrites.push(text);
				},
				write: async (items: unknown[]) => {
					for (const item of /* SAFETY: This init script replaces global ClipboardItem with its own complete LocalClipboardItem value holder; mounted GlobalContextMenu creates those actual instances before passing them to this controlled clipboard.write seam. Their native Blob values are inspected here; foreign clipboard objects are not validated. */ items as LocalClipboardItem[]) {
						const textBlob = item.values["text/plain"];
						const image = item.values["image/png"];
						state.clipboardItems.push({
							pngBytes: image?.size ?? 0,
							text: textBlob ? await textBlob.text() : null,
							types: item.types,
						});
					}
				},
			},
		});

		let lastEditor: HTMLInputElement | HTMLTextAreaElement | null = null;
		const rememberEditor = (target: EventTarget | null) => {
			if (
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement
			) {
				lastEditor = target;
				return;
			}
			if (target instanceof HTMLElement && target.closest("[role='menu']")) {
				return;
			}
			lastEditor = null;
		};
		document.addEventListener(
			"focusin",
			(event) => rememberEditor(event.target),
			true
		);
		document.addEventListener(
			"contextmenu",
			(event) => {
				const target = event.target;
				const active = document.activeElement;
				if (
					target instanceof HTMLElement &&
					(target instanceof HTMLInputElement ||
						target instanceof HTMLTextAreaElement)
				) {
					lastEditor = target;
				} else {
					rememberEditor(active);
				}
				state.activeOnContextMenu =
					active instanceof HTMLElement ? active.id || active.tagName : null;
			},
			true
		);

		const readEditorSelection = () => {
			if (!lastEditor?.isConnected) {
				return null;
			}
			const start = lastEditor.selectionStart ?? 0;
			const end = lastEditor.selectionEnd ?? start;
			if (start === end) {
				return null;
			}
			return {
				end,
				start,
				text: lastEditor.value.slice(start, end),
			};
		};

		Object.defineProperty(document, "execCommand", {
			configurable: true,
			value: (command: string, _showUi?: boolean, insertedText?: string) => {
				state.execCommands.push(command);
				if (command === "copy" || command === "cut") {
					const editorSelection = readEditorSelection();
					const text =
						editorSelection?.text ?? window.getSelection()?.toString() ?? "";
					state.clipboardText = text;
					state.clipboardTextWrites.push(text);
					if (command === "cut" && editorSelection && lastEditor) {
						lastEditor.setRangeText(
							"",
							editorSelection.start,
							editorSelection.end,
							"start"
						);
						lastEditor.dispatchEvent(new Event("input", { bubbles: true }));
					}
					return true;
				}
				if (command === "paste") {
					return false;
				}
				if (command === "selectAll") {
					if (lastEditor?.isConnected) {
						lastEditor.focus();
						lastEditor.setSelectionRange(0, lastEditor.value.length);
						return true;
					}
					const selection = window.getSelection();
					const range = document.createRange();
					range.selectNodeContents(document.body);
					selection?.removeAllRanges();
					selection?.addRange(range);
					return true;
				}
				if (
					command === "insertText" &&
					insertedText &&
					lastEditor?.isConnected
				) {
					const start = lastEditor.selectionStart ?? lastEditor.value.length;
					const end = lastEditor.selectionEnd ?? start;
					lastEditor.setRangeText(insertedText, start, end, "end");
					lastEditor.dispatchEvent(new Event("input", { bubbles: true }));
					return true;
				}
				return false;
			},
		});

		let browserFullscreen = false;
		Object.defineProperty(Document.prototype, "fullscreenElement", {
			configurable: true,
			get: () => (browserFullscreen ? document.documentElement : null),
		});
		Object.defineProperty(Element.prototype, "requestFullscreen", {
			configurable: true,
			value: async () => {
				browserFullscreen = true;
				state.fullscreen = true;
				state.fullscreenRequests += 1;
				document.dispatchEvent(new Event("fullscreenchange"));
			},
		});
		Object.defineProperty(Document.prototype, "exitFullscreen", {
			configurable: true,
			value: async () => {
				browserFullscreen = false;
				state.fullscreen = false;
				state.fullscreenRequests += 1;
				document.dispatchEvent(new Event("fullscreenchange"));
			},
		});

		if (new URL(location.href).searchParams.get("native") === "1") {
			proofWindow.__TAURI_INTERNALS__ = {
				invoke: async (command, args) => {
					state.tauriCalls.push({ args: args ?? null, command });
					if (command === "is_fullscreen") {
						return state.fullscreen;
					}
					if (command === "toggle_fullscreen") {
						state.fullscreen = !state.fullscreen;
						return state.fullscreen;
					}
					if (command === "toggle_devtools") {
						state.devtoolsToggles += 1;
						return undefined;
					}
					throw new Error(
						`Unexpected native command in local proof: ${command}`
					);
				},
				transformCallback: () => 0,
			};
		}
	});
}

async function globalState(page: Page): Promise<ProofState> {
	return page.evaluate(() => {
		const proofWindow =
			/* SAFETY: This fixture initialization defines __RYU_GLOBAL_CONTEXT_MENU_PROOF__ on its own browser window. */ window as Window & {
				__RYU_GLOBAL_CONTEXT_MENU_PROOF__: ProofState;
			};
		return proofWindow.__RYU_GLOBAL_CONTEXT_MENU_PROOF__;
	});
}

async function openMenu(page: Page, target = "menu-target") {
	if (target === "menu-target") {
		await page.mouse.click(40, 40, { button: "right" });
	} else {
		const element = page.getByTestId(target);
		const box = await element.boundingBox();
		if (!box) {
			throw new Error(`Context menu target did not render: ${target}`);
		}
		const x = target === "editor" ? Math.min(60, box.width / 2) : 4;
		await page.mouse.click(box.x + x, box.y + box.height / 2, {
			button: "right",
		});
	}
	await expect(page.getByRole("menu")).toBeVisible();
}

async function selectAppearanceOption(
	page: Page,
	option: "Light" | "Dark" | "System" | "Appearance settings"
) {
	await openMenu(page);
	await page.getByRole("menuitem", { name: "Appearance", exact: true }).hover();
	await page.getByRole("menuitem", { name: new RegExp(`^${option}`) }).click();
}

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
