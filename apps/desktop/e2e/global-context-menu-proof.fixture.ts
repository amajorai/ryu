// Browser fixtures and menu helpers shared by global-context-menu-proof.spec.ts:
// the clipboard/fullscreen/Tauri stand-ins, the proof state reader and the
// right-click and Appearance submenu drivers.

import { expect, type Page } from "@playwright/test";

export interface ProofState {
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

export async function installBrowserFixtures(page: Page) {
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

export async function globalState(page: Page): Promise<ProofState> {
	return page.evaluate(() => {
		const proofWindow =
			/* SAFETY: This fixture initialization defines __RYU_GLOBAL_CONTEXT_MENU_PROOF__ on its own browser window. */ window as Window & {
				__RYU_GLOBAL_CONTEXT_MENU_PROOF__: ProofState;
			};
		return proofWindow.__RYU_GLOBAL_CONTEXT_MENU_PROOF__;
	});
}

export async function openMenu(page: Page, target = "menu-target") {
	if (target === "menu-target") {
		// Right-click only once the story has rendered its menu surface: a click
		// that lands before React commits reaches no context-menu handler.
		await expect(page.getByTestId("menu-target")).toBeVisible();
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

export async function selectAppearanceOption(
	page: Page,
	option: "Light" | "Dark" | "System" | "Appearance settings"
) {
	await openMenu(page);
	await page.getByRole("menuitem", { name: "Appearance", exact: true }).hover();
	await page.getByRole("menuitem", { name: new RegExp(`^${option}`) }).click();
}
