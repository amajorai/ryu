import { expect, test } from "@playwright/test";
import { openWorkspace } from "./tab-tearout-proof.helpers.ts";

test("a source tab waits for destination readiness, then moves without entering closed-tab history", async ({
	page,
}) => {
	await page.addInitScript(() => {
		const state =
			/* SAFETY: This fixture initialization defines __TAURI_INTERNALS__ on its own browser window. */ window as Window & {
				__TAURI_INTERNALS__: unknown;
				finishMove: () => void;
				moveArgs: unknown;
			};
		Object.defineProperty(state, "__TAURI_INTERNALS__", {
			value: {
				metadata: {
					currentWindow: { label: "main" },
					currentWebview: { label: "main" },
				},
				transformCallback: () => 1,
				unregisterCallback: () => undefined,
				invoke: <CapturedArgs>(command: string, args: CapturedArgs) => {
					if (command === "open_tab_window") {
						state.moveArgs = args;
						return new Promise((resolve) => {
							state.finishMove = () => resolve(true);
						});
					}
					return Promise.resolve(null);
				},
			},
		});
	});
	await openWorkspace(page);
	await page
		.getByRole("button", { name: "Tab tear-out notes", exact: true })
		.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Move tab to new window", exact: true })
		.click();
	await expect(
		page.locator('[data-tab-appearance][draggable="true"]')
	).toHaveCount(3);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					/* SAFETY: These tests author the private raw move capture, numeric move counter, and native-command resolver callbacks on their own Window. Callback reads follow the corresponding open_tab_window poll or completed dragstart command publication; native invoke calls the fixture synchronously before its Promise await. This does not describe the full Tauri SDK. */ (
						window as typeof window & { moveArgs: unknown }
					).moveArgs
			)
		)
		.toMatchObject({
			dragOut: false,
			transfer: {
				version: 1,
				tab: { path: "/artifact/notes", title: "Tab tear-out notes" },
				artifact: { id: "notes", title: "Tab tear-out notes" },
			},
		});
	await page.evaluate(() =>
		/* SAFETY: These tests author the private raw move capture, numeric move counter, and native-command resolver callbacks on their own Window. Callback reads follow the corresponding open_tab_window poll or completed dragstart command publication; native invoke calls the fixture synchronously before its Promise await. This does not describe the full Tauri SDK. */ (
			window as typeof window & { finishMove: () => void }
		).finishMove()
	);
	await expect(
		page.locator('[data-tab-appearance][draggable="true"]')
	).toHaveCount(2);
	await expect(
		page.getByRole("button", { name: "Tab tear-out notes", exact: true })
	).toHaveCount(0);
	await page
		.getByRole("button", { name: "Release checklist", exact: true })
		.click({ button: "right" });
	await expect(
		page.getByRole("menuitem", { name: "Restore closed tab", exact: true })
	).toBeDisabled();
});

test("a failed native move keeps all tabs and reports the failure", async ({
	page,
}) => {
	await page.addInitScript(() => {
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: {
				metadata: {
					currentWindow: { label: "main" },
					currentWebview: { label: "main" },
				},
				transformCallback: () => 1,
				unregisterCallback: () => undefined,
				invoke: (command: string) =>
					command === "open_tab_window"
						? Promise.reject("Destination unavailable")
						: Promise.resolve(null),
			},
		});
	});
	await openWorkspace(page);
	await page
		.getByRole("button", { name: "Tab tear-out notes", exact: true })
		.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Move tab to new window", exact: true })
		.click();
	await expect(
		page.getByText("Couldn't move this tab. It is still open in this window.", {
			exact: true,
		})
	).toBeVisible();
	await expect(
		page.locator('[data-tab-appearance][draggable="true"]')
	).toHaveCount(3);
});

test("the destination restores only its transferred artifact and keeps the sidebar closed", async ({
	page,
}) => {
	await page.addInitScript(() => {
		const transfer = {
			version: 1,
			node: "local",
			tab: {
				id: "moved-notes",
				path: "/artifact/notes",
				title: "Tab tear-out notes",
			},
			artifact: {
				id: "notes",
				kind: "html",
				title: "Tab tear-out notes",
				sourceMessageId: "fixture",
				content: "<h1>Unchanged artifact content</h1><p>RYU-TABS-042</p>",
			},
		};
		window.__tabTearoutClaimCommands = [];
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: {
				metadata: {
					currentWindow: { label: "transferred-notes" },
					currentWebview: { label: "transferred-notes" },
				},
				transformCallback: () => 1,
				unregisterCallback: () => undefined,
				invoke: async (command: string) => {
					if (
						command === "claim_tab_transfer" ||
						command === "tab_transfer_ready"
					) {
						window.__tabTearoutClaimCommands.push(command);
					}
					return command === "claim_tab_transfer" ? transfer : null;
				},
			},
		});
		localStorage.setItem("ryu_tab_layout", "canvas");
	});
	await page.goto("/?window=tab&detached=1", { waitUntil: "domcontentloaded" });
	const notice = page.getByRole("button", { name: "Got it", exact: true });
	if (await notice.count()) {
		await notice.click();
	}
	await expect(
		page.locator('[data-tab-appearance][draggable="true"]')
	).toHaveCount(1);
	await expect(
		page.getByRole("button", { name: "Open navigation", exact: true })
	).toBeVisible();
	await expect(
		page
			.frameLocator('iframe[title="Tab tear-out notes"]')
			.getByText("RYU-TABS-042")
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Workspace overview", exact: true })
	).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(() => window.__tabTearoutClaimCommands))
		.toEqual(["claim_tab_transfer", "tab_transfer_ready"]);
	expect(
		await page.evaluate(() => Object.hasOwn(window, "__RYU_TAB_TRANSFER__"))
	).toBe(false);
});

for (const cancelled of [false, true]) {
	test(`native release recovery ${cancelled ? "honors Escape" : "handles a missing dragend"}`, async ({
		page,
	}) => {
		await page.addInitScript(() => {
			const state =
				/* SAFETY: These tests author the private raw move capture, numeric move counter, and native-command resolver callbacks on their own Window. Callback reads follow the corresponding open_tab_window poll or completed dragstart command publication; native invoke calls the fixture synchronously before its Promise await. This does not describe the full Tauri SDK. */ window as typeof window & {
					finishNativeDrag: (outside: boolean) => void;
					moveCount: number;
				};
			state.moveCount = 0;
			Object.defineProperty(window, "__TAURI_INTERNALS__", {
				value: {
					metadata: {
						currentWindow: { label: "main" },
						currentWebview: { label: "main" },
					},
					transformCallback: () => 1,
					unregisterCallback: () => undefined,
					invoke: (command: string) => {
						if (command === "watch_tab_drag") {
							return new Promise((resolve) => {
								state.finishNativeDrag = resolve;
							});
						}
						if (command === "open_tab_window") {
							state.moveCount += 1;
							return Promise.resolve(true);
						}
						return Promise.resolve(null);
					},
				},
			});
		});
		await openWorkspace(page);
		const tabs = page.locator('[data-tab-appearance][draggable="true"]');
		const source = tabs.nth(1);
		const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
		await source.dispatchEvent("dragstart", { dataTransfer });
		await expect(source).toHaveClass(/opacity-40/);
		if (cancelled) {
			await page.keyboard.press("Escape");
		}
		await page.evaluate(() =>
			/* SAFETY: These tests author the private raw move capture, numeric move counter, and native-command resolver callbacks on their own Window. Callback reads follow the corresponding open_tab_window poll or completed dragstart command publication; native invoke calls the fixture synchronously before its Promise await. This does not describe the full Tauri SDK. */ (
				window as typeof window & {
					finishNativeDrag: (outside: boolean) => void;
				}
			).finishNativeDrag(true)
		);
		if (cancelled) {
			await expect(source).not.toHaveClass(/opacity-40/);
			await expect(tabs).toHaveCount(3);
		} else {
			await expect(tabs).toHaveCount(2);
		}
		expect(
			await page.evaluate(
				() =>
					/* SAFETY: These tests author the private raw move capture, numeric move counter, and native-command resolver callbacks on their own Window. Callback reads follow the corresponding open_tab_window poll or completed dragstart command publication; native invoke calls the fixture synchronously before its Promise await. This does not describe the full Tauri SDK. */ (
						window as typeof window & { moveCount: number }
					).moveCount
			)
		).toBe(cancelled ? 0 : 1);
	});
}
