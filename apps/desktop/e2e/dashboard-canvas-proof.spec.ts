import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import type { ProofJsonRecord } from "./fixture-json.ts";

const STORY_URL = "/dashboard-canvas-proof.html";
const STATE_KEY = "dashboard-canvas-proof-state";
const PROOF_PATH = "/tmp/ryu-dashboard-canvas-proof.png";
const LAYOUT_PROOF_PATH = "/tmp/ryu-dashboard-canvas-layout-proof.png";

interface ProofState {
	calls: { name: string; payload: ProofJsonRecord }[];
	center: { x: number; y: number } | null;
	widgets: {
		canvas?: { h: number; w: number; x: number; y: number } | null;
		id: string;
	}[];
}

async function readRenderedState(page: Page): Promise<ProofState> {
	return z
		.object({
			calls: z.array(
				z.object({ name: z.string(), payload: z.record(z.string(), z.json()) })
			),
			center: z.object({ x: z.number(), y: z.number() }).nullable(),
			widgets: z.array(
				z.object({
					id: z.string(),
					canvas: z
						.object({
							h: z.number(),
							w: z.number(),
							x: z.number(),
							y: z.number(),
						})
						.nullable()
						.optional(),
				})
			),
		})
		.parse(
			JSON.parse(
				(await page.getByTestId("canvas-proof-state").textContent()) ?? "{}"
			)
		);
}

async function getZoom(page: Page): Promise<number> {
	return page.locator(".react-flow__viewport").evaluate((element) => {
		const transform = getComputedStyle(element).transform;
		return transform === "none" ? 1 : new DOMMatrixReadOnly(transform).a;
	});
}

test("the shared widget menu opens and recovers in the production Grid surface", async ({
	page,
}) => {
	await page.goto(`${STORY_URL}?surface=grid`);
	await expect(
		page.getByRole("heading", { name: "Dashboard Canvas" })
	).toBeVisible();
	const trigger = page.getByRole("button", {
		name: "Widget actions for Canvas proof widget",
	});
	await expect(trigger).toBeVisible();
	await trigger.click();
	await expect(trigger).toHaveAttribute("aria-expanded", "true");
	const refreshItem = page.getByRole("menuitem", {
		name: "Refresh",
		exact: true,
	});
	await expect(refreshItem).toBeVisible();
	await refreshItem.click();
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
	await expect(
		page.getByText("Refreshed fixture result", { exact: true })
	).toBeVisible();
	await trigger.click();
	await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
	await expect(page.locator(".react-grid-item")).toHaveCount(0);
	await expect
		.poll(async () => (await readRenderedState(page)).calls.at(-1))
		.toEqual({
			name: "remove",
			payload: { widgetId: "canvas-proof-widget" },
		});
});

test("Canvas widget action menu opens from the real node header", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	const trigger = page.getByRole("button", {
		name: "Widget actions for Canvas proof widget",
	});
	await expect(trigger).toBeVisible();
	await trigger.focus();
	await page.keyboard.press("Enter");
	await expect(trigger).toHaveAttribute("aria-expanded", "true");
	const refreshItem = page.getByRole("menuitem", {
		name: "Refresh",
		exact: true,
	});
	await expect(refreshItem).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(refreshItem).toBeHidden();
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
	await trigger.click();
	await expect(trigger).toHaveAttribute("aria-expanded", "true");
	await expect(refreshItem).toBeVisible();
	await expect(page.locator('[data-slot="dropdown-menu-content"]')).toHaveClass(
		/is-open/
	);
	await page.screenshot({ fullPage: true, path: PROOF_PATH });
});

test("pressing the Canvas widget actions trigger opens the menu instead of dragging the node", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	const node = page.locator('.react-flow__node[data-id="canvas-proof-widget"]');
	await expect(node).toBeVisible();
	const trigger = node.getByRole("button", {
		name: "Widget actions for Canvas proof widget",
	});
	// React Flow's drag filter skips presses inside `.nodrag`; without it
	// d3-drag stops the mousedown the menu trigger opens on.
	await expect(node.locator("[data-widget-actions]")).toHaveClass(
		/\bnodrag\b.*\bnopan\b/
	);
	const nodeBefore = await node.boundingBox();
	const triggerBox = await trigger.boundingBox();
	expect(nodeBefore).not.toBeNull();
	expect(triggerBox).not.toBeNull();
	const start = {
		x: (triggerBox?.x ?? 0) + (triggerBox?.width ?? 0) / 2,
		y: (triggerBox?.y ?? 0) + (triggerBox?.height ?? 0) / 2,
	};
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await expect(trigger).toHaveAttribute("aria-expanded", "true");
	await page.mouse.move(start.x + 90, start.y + 55, { steps: 6 });
	await page.mouse.up();
	const nodeAfter = await node.boundingBox();
	expect(Math.abs((nodeAfter?.x ?? 0) - (nodeBefore?.x ?? 0))).toBeLessThan(1);
	expect(Math.abs((nodeAfter?.y ?? 0) - (nodeBefore?.y ?? 0))).toBeLessThan(1);
	expect(
		(await readRenderedState(page)).calls.filter(
			(call) => call.name === "persist"
		)
	).toEqual([]);
});

test("Canvas controls report add, refresh, and remove against the real widget node", async ({
	page,
}) => {
	const consoleErrors: string[] = [];
	const pageErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => pageErrors.push(error.message));

	await page.goto(STORY_URL);
	await expect(page).toHaveTitle("Dashboard canvas proof");
	await expect(
		page.getByRole("heading", { name: "Dashboard Canvas" })
	).toBeVisible();
	const canvas = page.locator(".react-flow");
	await expect(canvas).toBeVisible();
	await expect(
		page.getByText("Canvas proof widget", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Fixture source is temporarily unavailable", { exact: true })
	).toBeVisible();
	await expect(page.locator(".react-flow__controls")).toBeVisible();
	await expect(page.locator(".react-flow__minimap")).toBeVisible();

	await expect
		.poll(async () => (await readRenderedState(page)).center)
		.not.toBeNull();
	const initialCenter = (await readRenderedState(page)).center;
	expect(initialCenter).not.toBeNull();

	const addWidgetButton = page.getByRole("button", { name: "Add widget" });
	await addWidgetButton.click();
	await expect
		.poll(async () => (await readRenderedState(page)).calls.at(-1))
		.toEqual({ name: "add-widget", payload: {} });
	const firstDialog = page.getByRole("dialog", { name: "Add widget" });
	await expect(firstDialog).toBeVisible();
	await firstDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(firstDialog).toBeHidden();
	expect(
		(await readRenderedState(page)).calls.some(
			(call) => call.name === "create-widget"
		)
	).toBe(false);

	await addWidgetButton.click();
	const createDialog = page.getByRole("dialog", { name: "Add widget" });
	await expect(createDialog).toBeVisible();
	await createDialog.getByLabel("Title").fill("Canvas metric");
	await createDialog
		.getByRole("button", { name: "Add widget", exact: true })
		.click();
	await expect(createDialog).toBeHidden();
	await expect(page.getByText("Canvas metric", { exact: true })).toBeVisible();
	await expect(page.getByText("42", { exact: true })).toBeVisible();
	const afterCreate = await readRenderedState(page);
	const createdWidget = afterCreate.widgets.find(
		(widget: { id: string }) => widget.id === "canvas-proof-created-1"
	);
	const existingWidget = afterCreate.widgets.find(
		(widget: { id: string }) => widget.id === "canvas-proof-widget"
	);
	expect(createdWidget?.canvas).toBeDefined();
	expect(existingWidget?.canvas).toBeDefined();
	const createdRect = createdWidget?.canvas;
	const existingRect = existingWidget?.canvas;
	if (!(createdRect && existingRect && initialCenter)) {
		throw new Error(
			"Canvas widget creation did not persist both node rectangles"
		);
	}
	expect(createdRect).toEqual({
		h: 240,
		w: 320,
		x: initialCenter.x + 184,
		y: initialCenter.y - 120,
	});
	const overlapsExisting =
		createdRect.x < existingRect.x + existingRect.w &&
		createdRect.x + createdRect.w > existingRect.x &&
		createdRect.y < existingRect.y + existingRect.h &&
		createdRect.y + createdRect.h > existingRect.y;
	expect(overlapsExisting).toBe(false);
	expect(afterCreate.calls.at(-1)).toEqual({
		name: "create-widget",
		payload: {
			canvas: createdRect,
			input: {
				config: {},
				kind: "stat",
				layout: { h: 3, w: 3, x: 0, y: 0 },
				refresh_interval: "30s",
				source: {
					endpoint: "connections",
					selector: null,
					type: "core_endpoint",
				},
				title: "Canvas metric",
			},
		},
	});
	const existingActionTrigger = page.getByRole("button", {
		name: "Widget actions for Canvas proof widget",
	});
	await existingActionTrigger.click();
	await expect(existingActionTrigger).toHaveAttribute("aria-expanded", "true");
	const refreshItem = page.getByRole("menuitem", {
		name: "Refresh",
		exact: true,
	});
	await expect(refreshItem).toBeVisible();
	await refreshItem.click();
	await expect(existingActionTrigger).toHaveAttribute("aria-expanded", "false");
	await expect
		.poll(async () => (await readRenderedState(page)).calls.at(-1))
		.toEqual({
			name: "refresh",
			payload: { widgetId: "canvas-proof-widget" },
		});
	await expect(
		page.getByText("Refreshed fixture result", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Fixture source is temporarily unavailable", { exact: true })
	).toBeHidden();
	await expect(refreshItem).toBeHidden();
	await page.screenshot({ fullPage: true, path: PROOF_PATH });

	await page
		.getByRole("button", { name: "Widget actions for Canvas proof widget" })
		.click();
	await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
	await expect(
		page.getByText("Canvas proof widget", { exact: true })
	).toBeHidden();
	await expect
		.poll(async () => (await readRenderedState(page)).calls.at(-1))
		.toEqual({
			name: "remove",
			payload: { widgetId: "canvas-proof-widget" },
		});
	await expect
		.poll(() =>
			page.evaluate((key) => {
				const saved = localStorage.getItem(key);
				return saved
					? JSON.parse(saved).widgets.map((widget: { id: string }) => widget.id)
					: null;
			}, STATE_KEY)
		)
		.toEqual(["canvas-proof-created-1"]);
	await page.reload();
	await expect(
		page.locator('.react-flow__node[data-id="canvas-proof-widget"]')
	).toHaveCount(0);
	await expect(
		page.locator('.react-flow__node[data-id="canvas-proof-created-1"]')
	).toBeVisible();
	await expect(page.getByText("Canvas metric", { exact: true })).toBeVisible();

	expect(consoleErrors, "application console errors").toEqual([]);
	expect(pageErrors, "uncaught page errors").toEqual([]);
});

test("React Flow zoom, fit, minimap, and pan controls update the visible viewport", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await expect(
		page.getByText("Canvas proof widget", { exact: true })
	).toBeVisible();
	const controls = page.locator(".react-flow__controls");
	const initialZoom = await getZoom(page);
	await controls.getByRole("button", { name: /zoom in/i }).click();
	await expect.poll(() => getZoom(page)).toBeGreaterThan(initialZoom);
	const zoomedIn = await getZoom(page);
	await controls.getByRole("button", { name: /zoom out/i }).click();
	await expect.poll(() => getZoom(page)).toBeLessThan(zoomedIn);

	// Fit operates on measured node bounds; it need not restore the mount zoom.
	// Displace the real canvas first so a no-op Fit cannot satisfy containment.
	const flow = page.locator(".react-flow");
	const readFitGeometry = () =>
		flow.evaluate((element) => {
			const node = element.querySelector(
				'.react-flow__node[data-id="canvas-proof-widget"]'
			);
			if (!node) {
				throw new Error("Canvas widget is missing during viewport proof");
			}
			const viewport = element.getBoundingClientRect();
			const box = node.getBoundingClientRect();
			return {
				contained:
					box.left >= viewport.left &&
					box.right <= viewport.right &&
					box.top >= viewport.top &&
					box.bottom <= viewport.bottom,
				centered:
					Math.abs(
						(box.left + box.right) / 2 - (viewport.left + viewport.right) / 2
					) <= 2 &&
					Math.abs(
						(box.top + box.bottom) / 2 - (viewport.top + viewport.bottom) / 2
					) <= 2,
			};
		});
	const viewportBounds = await flow.boundingBox();
	if (!viewportBounds) {
		throw new Error("Canvas viewport is not visible");
	}
	await page.mouse.move(
		viewportBounds.x + viewportBounds.width * 0.1,
		viewportBounds.y + viewportBounds.height * 0.1
	);
	await page.mouse.down();
	await page.mouse.move(
		viewportBounds.x + viewportBounds.width * 0.9,
		viewportBounds.y + viewportBounds.height * 0.9,
		{ steps: 5 }
	);
	await page.mouse.up();
	await expect
		.poll(async () => (await readFitGeometry()).contained)
		.toBe(false);
	await controls.getByRole("button", { name: /fit view/i }).click();
	await expect
		.poll(readFitGeometry)
		.toEqual({ contained: true, centered: true });

	// Fit may legitimately reach the maximum zoom. Make physical headroom
	// before requiring the minimap wheel to zoom in.
	const fittedZoom = await getZoom(page);
	await controls.getByRole("button", { name: /zoom out/i }).click();
	await expect.poll(() => getZoom(page)).toBeLessThan(fittedZoom);

	const beforeMinimapZoom = await getZoom(page);
	await page.locator(".react-flow__minimap").hover();
	await page.mouse.wheel(0, -140);
	await expect.poll(() => getZoom(page)).toBeGreaterThan(beforeMinimapZoom);

	const centerBeforeMinimapPan = (await readRenderedState(page)).center;
	const minimapNode = page.locator(".react-flow__minimap-node").first();
	await expect(minimapNode).toBeVisible();
	const minimapNodeBounds = await minimapNode.boundingBox();
	expect(minimapNodeBounds).not.toBeNull();
	const minimapStart = {
		x: (minimapNodeBounds?.x ?? 0) + (minimapNodeBounds?.width ?? 0) / 2,
		y: (minimapNodeBounds?.y ?? 0) + (minimapNodeBounds?.height ?? 0) / 2,
	};
	await page.mouse.move(minimapStart.x, minimapStart.y);
	await page.mouse.down();
	await page.mouse.move(minimapStart.x + 28, minimapStart.y + 18, { steps: 4 });
	await page.mouse.up();
	await expect
		.poll(async () => (await readRenderedState(page)).center)
		.not.toEqual(centerBeforeMinimapPan);

	const stateBeforePan = await readRenderedState(page);
	const pane = page.locator(".react-flow__pane");
	const paneBounds = await pane.boundingBox();
	expect(paneBounds).not.toBeNull();
	const start = {
		x: (paneBounds?.x ?? 0) + 120,
		y: (paneBounds?.y ?? 0) + 330,
	};
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(start.x + 100, start.y + 70, { steps: 5 });
	await page.mouse.up();
	await expect
		.poll(async () => {
			const state = await readRenderedState(page);
			return state.center;
		})
		.not.toEqual(stateBeforePan.center);

	await page.screenshot({ fullPage: true, path: LAYOUT_PROOF_PATH });
});

test("node drag and resize persist exact canvas geometry through a reload and Delete cannot remove a node", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	const node = page.locator('.react-flow__node[data-id="canvas-proof-widget"]');
	await expect(node).toBeVisible();
	await page.getByRole("button", { name: /zoom in/i }).click();
	await page.getByRole("button", { name: /fit view/i }).click();
	const nodeBox = await node.boundingBox();
	expect(nodeBox).not.toBeNull();
	const start = {
		x: (nodeBox?.x ?? 0) + 100,
		y: (nodeBox?.y ?? 0) + 12,
	};
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(start.x + 90, start.y + 55, { steps: 6 });
	await page.mouse.up();

	await expect
		.poll(
			async () =>
				(await readRenderedState(page)).calls.filter(
					(call) => call.name === "persist"
				).length
		)
		.toBe(1);
	const afterDrag = await readRenderedState(page);
	const persistedCall = afterDrag.calls.find((call) => call.name === "persist");
	expect(persistedCall).toMatchObject({
		name: "persist",
		payload: {
			widgetId: "canvas-proof-widget",
			rect: { h: 240, w: 320 },
		},
	});
	const draggedRect = z
		.object({ h: z.number(), w: z.number(), x: z.number(), y: z.number() })
		.parse(persistedCall?.payload.rect);
	expect(draggedRect.x).toBeGreaterThan(160);
	expect(draggedRect.y).toBeGreaterThan(120);
	await expect
		.poll(async () => {
			const nodeTransform = await node.getAttribute("style");
			return nodeTransform;
		})
		.toContain(`translate(${draggedRect.x}px, ${draggedRect.y}px)`);

	const resizeHandle = node.locator(
		".react-flow__resize-control.handle.bottom.right"
	);
	await node.click();
	await expect(node).toBeVisible();
	await expect(resizeHandle).toBeVisible();
	const handleBox = await resizeHandle.boundingBox();
	expect(handleBox).not.toBeNull();
	const priorPersistCalls = afterDrag.calls.filter(
		(call) => call.name === "persist"
	).length;
	const handleStart = {
		x: (handleBox?.x ?? 0) + (handleBox?.width ?? 0) / 2,
		y: (handleBox?.y ?? 0) + (handleBox?.height ?? 0) / 2,
	};
	await page.mouse.move(handleStart.x, handleStart.y);
	await page.mouse.down();
	await page.mouse.move(handleStart.x + 90, handleStart.y + 60, { steps: 6 });
	await page.mouse.up();
	await expect
		.poll(
			async () =>
				(await readRenderedState(page)).calls.filter(
					(call) => call.name === "persist"
				).length
		)
		.toBe(priorPersistCalls + 1);
	const afterResize = await readRenderedState(page);
	const resizedCall = afterResize.calls.at(-1);
	expect(resizedCall?.name).toBe("persist");
	expect(resizedCall?.payload).toMatchObject({
		widgetId: "canvas-proof-widget",
	});
	const resizedRect = z
		.object({ h: z.number(), w: z.number(), x: z.number(), y: z.number() })
		.parse(resizedCall?.payload.rect);
	expect(resizedRect.x).toBe(draggedRect.x);
	expect(resizedRect.y).toBe(draggedRect.y);
	expect(resizedRect.w).toBeGreaterThan(320);
	expect(resizedRect.h).toBeGreaterThan(240);
	expect(afterResize.widgets[0]?.canvas).toEqual(resizedRect);

	await node.click();
	await page.keyboard.press("Delete");
	await expect(node).toBeVisible();
	expect((await readRenderedState(page)).widgets).toHaveLength(1);
	expect(
		(await readRenderedState(page)).calls.some((call) => call.name === "remove")
	).toBe(false);

	await page.reload();
	const restoredNode = page.locator(
		'.react-flow__node[data-id="canvas-proof-widget"]'
	);
	await expect(restoredNode).toBeVisible();
	await expect
		.poll(async () => {
			const saved = await page.evaluate((key) => {
				const raw = localStorage.getItem(key);
				return raw ? JSON.parse(raw).widgets[0]?.canvas : null;
			}, STATE_KEY);
			return saved;
		})
		.toEqual(resizedRect);
	await expect(restoredNode).toHaveAttribute(
		"style",
		new RegExp(`translate\\(${resizedRect.x}px, ${resizedRect.y}px\\)`)
	);
	await page.screenshot({ fullPage: true, path: LAYOUT_PROOF_PATH });
});
