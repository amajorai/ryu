import { expect, test } from "@playwright/test";
import { z } from "zod";
import { openWorkspace, readSealedValue } from "./tab-tearout-proof.helpers.ts";

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
				if (!(event instanceof DragEvent)) {
					return;
				}
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
	if (!(source && target)) {
		throw new Error("Missing source or target tab");
	}
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
				if (parsed.success) {
					resolve(parsed.data);
				} else {
					reject(parsed.error);
				}
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
				session: (() => {
					const read = Reflect.get(window, "__readSealedLocalStorage");
					return typeof read === "function" ? read("ryu_session_tabs") : null;
				})(),
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
		.poll(async () =>
			z
				.object({ tabs: z.array(z.object({ path: z.string() })) })
				.parse(
					JSON.parse(
						(await readSealedValue(page, "ryu_session_tabs")) ?? '{"tabs":[]}'
					)
				)
				.tabs.map((tab) => tab.path)
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
	if (!(source && pane)) {
		throw new Error("Missing physical drag source or pane");
	}
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
	if (!overlay) {
		throw new Error("Content drag target did not mount");
	}
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
		const raw = await readSealedValue(page, "ryu_workbench_layout_v2");
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
