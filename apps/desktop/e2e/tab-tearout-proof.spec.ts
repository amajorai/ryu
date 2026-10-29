import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";

declare global {
	interface Window {
		__tabTearoutClaimCommands: string[];
		__tabTearoutDragEvents: string[];
		__tabTearoutDragDiagnostics: Array<{
			type: string;
			defaultPrevented: boolean;
			buttons: number;
			effectAllowed: string | null;
			dropEffect: string | null;
			transferTypes: string[];
		}>;
		__tabTearoutSourceRemoved: boolean;
		__tabTearoutSplitSourceState: () => {
			connected: boolean;
			dragEnds: number;
		};
	}
}

async function openWorkspace(page: Page) {
	await page.goto("/", { waitUntil: "domcontentloaded" });
	const notice = page.getByRole("button", { name: "Got it", exact: true });
	if (await notice.count()) {
		await notice.click();
	}
	await expect(
		page.locator('[data-tab-appearance][draggable="true"]')
	).toHaveCount(3);
}

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

test("ordinary drag reorders tabs without removing them", async ({
	page,
}, testInfo) => {
	await openWorkspace(page);
	const tabs = page.locator('[data-tab-appearance][draggable="true"]');
	await page.evaluate(() => {
		window.__tabTearoutDragEvents = [];
		window.__tabTearoutDragDiagnostics = [];
		window.__tabTearoutSourceRemoved = false;
		const source = document.querySelector(
			'[data-tab-appearance][draggable="true"]'
		);
		const observer = new MutationObserver(() => {
			if (source && !source.isConnected) {
				window.__tabTearoutSourceRemoved = true;
				observer.disconnect();
			}
		});
		observer.observe(document, { childList: true, subtree: true });
		for (const type of ["dragstart", "drop", "dragend"]) {
			document.addEventListener(
				type,
				() => window.__tabTearoutDragEvents.push(type),
				true
			);
			document.addEventListener(type, (event) => {
				if (!(event instanceof DragEvent)) return;
				window.__tabTearoutDragDiagnostics.push({
					type: event.type,
					defaultPrevented: event.defaultPrevented,
					buttons: event.buttons,
					effectAllowed: event.dataTransfer?.effectAllowed ?? null,
					dropEffect: event.dataTransfer?.dropEffect ?? null,
					transferTypes: [...(event.dataTransfer?.types ?? [])],
				});
			});
		}
	});
	const source = await tabs.nth(0).boundingBox();
	const target = await tabs.nth(2).boundingBox();
	if (!source || !target) throw new Error("Missing source or target tab");
	const protocol = await page.context().newCDPSession(page);
	const dragDataSchema = z.object({
		items: z.array(
			z.object({
				mimeType: z.string(),
				data: z.string(),
				title: z.string().optional(),
				baseURL: z.string().optional(),
			})
		),
		files: z.array(z.string()).optional(),
		dragOperationsMask: z.number(),
	});
	const interceptedDrag = new Promise<z.infer<typeof dragDataSchema>>(
		(resolve, reject) => {
			protocol.once("Input.dragIntercepted", (event) => {
				const parsed = dragDataSchema.safeParse(event.data);
				if (parsed.success) resolve(parsed.data);
				else reject(parsed.error);
			});
		}
	);
	try {
		// Keep Chromium interception enabled until its actual native payload is
		// received; the mouse adapter's transient interception can strand its
		// pending drag promise after the browser cancels the drag.
		await protocol.send("Input.setInterceptDrags", { enabled: true });
		const sourceX = source.x + source.width / 2;
		const sourceY = source.y + source.height / 2;
		await test.step(
			"position and press on source tab",
			async () => {
				await protocol.send("Input.dispatchMouseEvent", {
					type: "mouseMoved",
					x: sourceX,
					y: sourceY,
				});
				await protocol.send("Input.dispatchMouseEvent", {
					type: "mousePressed",
					x: sourceX,
					y: sourceY,
					button: "left",
					buttons: 1,
					clickCount: 1,
				});
			},
			{ timeout: 10_000 }
		);
		const data = await test.step(
			"capture browser native tab drag payload",
			async () => {
				await protocol.send("Input.dispatchMouseEvent", {
					type: "mouseMoved",
					x: sourceX + 8,
					y: sourceY,
					button: "left",
					buttons: 1,
				});
				// Keep the pointer held and moving while Chromium starts its native
				// drag. The payload below must come from the browser interception,
				// including the application's real dragstart handlers.
				await protocol.send("Input.dispatchMouseEvent", {
					type: "mouseMoved",
					x: sourceX + 16,
					y: sourceY,
					button: "left",
					buttons: 1,
				});
				return await interceptedDrag;
			},
			{ timeout: 10_000 }
		);
		expect(
			data.items.some(
				(item) =>
					item.mimeType === "application/x-ryu-tab" && item.data.length > 0
			)
		).toBe(true);
		const targetX = target.x + target.width - 8;
		const targetY = target.y + target.height / 2;
		await test.step(
			"move native drag over target tab",
			async () => {
				await protocol.send("Input.dispatchDragEvent", {
					type: "dragEnter",
					x: targetX,
					y: targetY,
					data,
				});
				await protocol.send("Input.dispatchDragEvent", {
					type: "dragOver",
					x: targetX - 1,
					y: targetY,
					data,
				});
			},
			{ timeout: 10_000 }
		);
		await test.step(
			"release native drag on target tab",
			async () => {
				await protocol.send("Input.dispatchDragEvent", {
					type: "drop",
					x: targetX - 1,
					y: targetY,
					data,
				});
			},
			{ timeout: 10_000 }
		);
	} catch (error) {
		const diagnostic = await page
			.evaluate(() => ({
				events: window.__tabTearoutDragEvents,
				dragDetails: window.__tabTearoutDragDiagnostics,
				sourceRemoved: window.__tabTearoutSourceRemoved,
				tabs: [
					...document.querySelectorAll(
						'[data-tab-appearance][draggable="true"]'
					),
				].map((element) => ({
					title: element.textContent,
					connected: element.isConnected,
					bounds: element.getBoundingClientRect().toJSON(),
				})),
				session: localStorage.getItem("ryu_session_tabs"),
			}))
			.catch((diagnosticError: Error) => ({ error: diagnosticError.message }));
		await testInfo.attach("native-tab-drag-state", {
			body: JSON.stringify(diagnostic, null, 2),
			contentType: "application/json",
		});
		throw error;
	} finally {
		await protocol
			.send("Input.setInterceptDrags", { enabled: false })
			.catch(() => undefined);
		await protocol.detach();
	}
	await expect(tabs).toHaveCount(3);
	await expect(tabs.last()).toContainText("Workspace overview");
	await expect
		.poll(() => page.evaluate(() => window.__tabTearoutDragEvents))
		.toEqual(["dragstart", "drop", "dragend"]);
	await expect
		.poll(() =>
			page.evaluate(() =>
				JSON.parse(localStorage.getItem("ryu_session_tabs") ?? "{}").tabs.map(
					(tab: { path: string }) => tab.path
				)
			)
		)
		.toEqual(["/artifact/notes", "/artifact/checklist", "/artifact/overview"]);
});

test("a physical tab drag still creates a content split and restores its pane membership", async ({
	page,
}, testInfo) => {
	await openWorkspace(page);
	const center = page.locator('section[data-region="center"]');
	const source = await page
		.locator('[data-tab-appearance][draggable="true"]')
		.first()
		.boundingBox();
	const pane = await center.boundingBox();
	if (!source || !pane) throw new Error("Missing physical drag source or pane");
	await page.evaluate(() => {
		window.__tabTearoutDragEvents = [];
		const original = document.querySelector(
			'[data-tab-appearance][draggable="true"]'
		);
		let dragEnds = 0;
		original?.addEventListener("dragend", () => {
			dragEnds += 1;
		});
		window.__tabTearoutSplitSourceState = () => ({
			connected: original?.isConnected ?? false,
			dragEnds,
		});
		for (const type of ["dragstart", "drop", "dragend"]) {
			document.addEventListener(
				type,
				() => window.__tabTearoutDragEvents.push(type),
				true
			);
		}
	});
	// Physical pointer movement starts the shipping drag handlers. No transfer
	// object or DOM drop event is constructed by the test.
	const x = source.x + source.width / 2;
	const y = source.y + source.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + 8, y);
	await page.mouse.move(x + 16, y);
	await expect(page.locator("[data-tab-drop-overlay]")).toBeVisible();
	const overlay = await page.locator("[data-tab-drop-overlay]").boundingBox();
	if (!overlay) throw new Error("Content drag target did not mount");
	// The newly mounted target must not cover the pressed titlebar source.
	expect(overlay.y).toBeGreaterThanOrEqual(source.y + source.height);
	const targetX = pane.x + 8;
	const targetY = pane.y + pane.height / 2;
	await page.mouse.move(targetX, targetY);
	await page.mouse.move(targetX + 1, targetY);
	await expect(page.locator('[data-drop-preview="left"]')).toBeVisible();
	await page.mouse.up();
	await expect(center.locator(":scope > [data-group-id]")).toHaveCount(2);
	await expect(page.locator("[data-tab-drop-overlay]")).toHaveCount(0);
	// Splitting moves the focused titlebar to another pane and can detach the
	// original chip. Its dragend need not bubble through the document; the
	// successful native drop and cleared drag state are the user contract.
	await expect
		.poll(() => page.evaluate(() => window.__tabTearoutDragEvents.slice(0, 2)))
		.toEqual(["dragstart", "drop"]);
	await testInfo.attach("native-split-drag-state", {
		body: JSON.stringify(
			await page.evaluate(() => ({
				events: window.__tabTearoutDragEvents,
				source: window.__tabTearoutSplitSourceState(),
			}))
		),
		contentType: "application/json",
	});
	const snapshotSchema = z.object({
		centerTree: z.object({
			type: z.literal("branch"),
			orientation: z.literal("columns"),
		}),
		items: z.array(
			z.object({
				id: z.string(),
				source: z.object({ kind: z.string(), path: z.string().optional() }),
			})
		),
		groups: z.array(
			z.object({
				id: z.string(),
				region: z.string(),
				itemIds: z.array(z.string()),
			})
		),
	});
	async function readPaneMembership() {
		const raw = await page.evaluate(() =>
			localStorage.getItem("ryu_workbench_layout_v2")
		);
		const state = snapshotSchema.parse(JSON.parse(raw ?? "{}"));
		return state.groups
			.filter((group) => group.region === "center")
			.map((group) =>
				group.itemIds
					.map((id) => state.items.find((item) => item.id === id)?.source.path)
					.sort()
			)
			.sort((left, right) => String(left).localeCompare(String(right)));
	}
	const expected = [
		["/artifact/checklist", "/artifact/notes"],
		["/artifact/overview"],
	];
	await expect.poll(readPaneMembership).toEqual(expected);
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(center.locator(":scope > [data-group-id]")).toHaveCount(2);
	await expect.poll(readPaneMembership).toEqual(expected);
	await expect(
		page
			.frameLocator('iframe[title="Workspace overview"]')
			.getByRole("heading", { name: "Workspace overview", exact: true })
	).toBeVisible();
	await expect(
		page
			.frameLocator('iframe[title="Tab tear-out notes"]')
			.getByRole("heading", { name: "Tab tear-out notes", exact: true })
	).toBeVisible();
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
