import { mkdir, writeFile } from "node:fs/promises";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	installCanvasIdleNetwork,
	LAUNCHPAD_DRAFT,
	LAUNCHPAD_SEND_TIME,
} from "./canvas-idle-network.ts";
import type { UnexpectedChatProofRequest } from "./harness/chat-page-proof-http.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

const evidence = proofEvidencePath(
	"test-coverage-sweep-20260924/parallel/desktop-shell-flows/canvas"
);
const pageErrorsByPage = new WeakMap<Page, string[]>();
const fallbackCallsByPage = new WeakMap<Page, UnexpectedChatProofRequest[]>();
const backgroundByPage = new WeakMap<Page, () => unknown>();
test.beforeEach(({ page }) => {
	const errors: string[] = [];
	pageErrorsByPage.set(page, errors);
	fallbackCallsByPage.set(page, []);
	page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
});
test.afterEach(async ({ page }, testInfo) => {
	const ledgerPath = testInfo.outputPath(
		"shell-canvas-bootstrap-errors-and-unimplemented-dtos.json"
	);
	await writeFile(
		ledgerPath,
		JSON.stringify(
			{
				pageErrors: pageErrorsByPage.get(page) ?? [],
				unimplementedDtos: fallbackCallsByPage.get(page) ?? [],
				background: backgroundByPage.get(page)?.() ?? null,
			},
			null,
			2
		),
		"utf8"
	);
	await testInfo.attach(
		"shell-canvas-bootstrap-errors-and-unimplemented-dtos",
		{
			path: ledgerPath,
			contentType: "application/json",
		}
	);
	expect(
		pageErrorsByPage.get(page) ?? [],
		"The actual Layout must remain mounted without uncaught errors"
	).toEqual([]);
	expect(
		fallbackCallsByPage.get(page) ?? [],
		"All actual Canvas bootstrap requests must have finite source contracts"
	).toEqual([]);
});
const canvasKey = "ryu:tab-canvas-layout:v1";
async function setup(page: Page, empty = false) {
	await page.emulateMedia({ reducedMotion: "reduce" });
	const unknown = fallbackCallsByPage.get(page);
	if (!unknown) {
		throw new Error("Canvas HTTP ledger missing");
	}
	backgroundByPage.set(page, await installCanvasIdleNetwork(page, unknown));
	await page.addInitScript(
		({ empty }) => {
			if (sessionStorage.getItem("canvas-proof-seeded")) {
				return;
			}
			sessionStorage.setItem("canvas-proof-seeded", "true");
			localStorage.setItem("ryu_tab_layout", "canvas");
			localStorage.setItem("ryu_startup_behavior", "restore");
			localStorage.setItem(
				"ryu_session_tabs",
				JSON.stringify({
					tabs: empty
						? []
						: [
								{ path: "/channels", title: "Channels" },
								{ path: "/settings", title: "Settings" },
							],
					activeIndex: 0,
				})
			);
		},
		{ empty }
	);
	await page.goto("/desktop-shell-canvas-proof.html");
	if (!empty) {
		await expect(page.getByTestId("infinite-tabs-canvas")).toBeVisible();
		await expect(page.locator(".react-flow__node-tab")).toHaveCount(2);
	}
}
/** `ryu_session_tabs` through the app's sealed reader: content-seal.ts stores it
 *  sealed, so the plaintext key only ever held the seed. */
async function sealedSession(
	page: Page
): Promise<{ tabs: Array<{ path: string }> }> {
	const raw = await page.evaluate(() =>
		Reflect.apply(Reflect.get(window, "__readSealedLocalStorage"), window, [
			"ryu_session_tabs",
		])
	);
	return JSON.parse(typeof raw === "string" ? raw : '{"tabs":[]}');
}
async function stored(page: Page) {
	return page.evaluate(
		(key) => JSON.parse(localStorage.getItem(key) ?? "null"),
		canvasKey
	);
}
/** The element's computed transform as numbers. Chrome serializes a computed
 *  matrix to six significant digits, so a stored float such as 104.41025641
 *  reads back as 104.41; compare with closeTo, not the raw string. */
function computedMatrix(locator: Locator) {
	return locator.evaluate((element) =>
		(
			getComputedStyle(element).transform.match(
				/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g
			) ?? []
		).map(Number)
	);
}
/** translate (< 1000 px) to 0.005 px and scale to 0.00005: both looser than the
 *  six-significant-digit serialization error, far tighter than a pixel. */
function expectedMatrix(zoom: number, x: number, y: number) {
	return [
		expect.closeTo(zoom, 4),
		0,
		0,
		expect.closeTo(zoom, 4),
		expect.closeTo(x, 2),
		expect.closeTo(y, 2),
	];
}
async function dragNode(page: Page) {
	const header = page.locator("[data-tab-view-header]").first();
	const box = await header.boundingBox();
	if (!box) {
		throw new Error("Missing real canvas header");
	}
	await page.mouse.move(box.x + 8, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + 88, box.y + box.height / 2 + 50, { steps: 8 });
	await page.mouse.up();
}

test("actual Layout canvas focus, native-keyboard button activation, new chat and close persist survivors", async ({
	page,
}) => {
	await setup(page);
	const headers = page.locator("[data-tab-view-header]");
	await headers
		.nth(1)
		.getByRole("button", { name: "Settings", exact: true })
		.focus();
	await page.keyboard.press("Enter");
	await expect(
		page.locator('[data-tab-view-pane][data-focused="true"]')
	).toHaveAttribute(
		"data-tab-view-pane",
		(await headers.nth(1).getAttribute("data-tab-view-header")) ?? ""
	);
	await page.getByRole("button", { name: "New chat tab", exact: true }).click();
	await expect(page.locator(".react-flow__node-tab")).toHaveCount(3);
	await page
		.getByRole("button", { name: "Close Settings", exact: true })
		.click();
	await expect(page.locator(".react-flow__node-tab")).toHaveCount(2);
	await expect
		.poll(() =>
			sealedSession(page).then((session) => session.tabs.map((tab) => tab.path))
		)
		.toEqual(["/channels", "/chat"]);
	await mkdir(evidence, { recursive: true });
	await page.screenshot({ path: `${evidence}/canvas-live-tabs-completed.png` });
});

test("drag flushes on responsive unmount and same-window readback restores geometry", async ({
	page,
}) => {
	await setup(page);
	const node = page.locator(".react-flow__node-tab").first();
	const id = (await node.getAttribute("data-id"))?.replace(/^tab:/, "");
	const before = await node.getAttribute("style");
	await dragNode(page);
	await expect(node).not.toHaveAttribute("style", before ?? "");
	await page.setViewportSize({ width: 650, height: 820 });
	await expect(page.getByTestId("infinite-tabs-canvas")).toHaveCount(0);
	const snapshot = await stored(page);
	expect(snapshot.tabs[id ?? ""].x).toBeGreaterThan(24);
	expect(snapshot.tabs[id ?? ""].y).toBeGreaterThan(64);
	await page.setViewportSize({ width: 1180, height: 820 });
	await expect(page.getByTestId("infinite-tabs-canvas")).toBeVisible();
	await expect
		.poll(() =>
			computedMatrix(page.locator(`.react-flow__node[data-id="tab:${id}"]`))
		)
		.toEqual(
			expectedMatrix(1, snapshot.tabs[id ?? ""].x, snapshot.tabs[id ?? ""].y)
		);
});

test("saved pan and zoom survive reload instead of automatic fit and Fit all remains explicit", async ({
	page,
}) => {
	await setup(page);
	// React Flow's Controls label (title-cased by @xyflow/react).
	await page.getByRole("button", { name: "Zoom Out", exact: true }).click();
	await expect
		.poll(async () => (await stored(page))?.viewport.zoom)
		.toBeLessThan(1);
	const saved = (await stored(page)).viewport;
	await page.reload();
	await expect(page.getByTestId("infinite-tabs-canvas")).toBeVisible();
	await expect
		.poll(() => computedMatrix(page.locator(".react-flow__viewport")))
		.toEqual(expectedMatrix(saved.zoom, saved.x, saved.y));
	await page.getByRole("button", { name: "Fit all", exact: true }).click();
	await expect
		.poll(async () => (await stored(page)).viewport)
		.not.toEqual(saved);
	await page.screenshot({
		path: `${evidence}/canvas-viewport-readback-completed.png`,
	});
});

test("malformed stored layout recovers and the real empty Layout branch exposes the shared composer", async ({
	page,
}) => {
	await setup(page);
	await page.evaluate((key) => localStorage.setItem(key, "{broken"), canvasKey);
	await page.reload();
	await expect(page.locator(".react-flow__node-tab")).toHaveCount(2);
	for (const name of ["Close Settings", "Close Channels"]) {
		await page.getByRole("button", { name, exact: true }).click();
	}
	await expect(page.getByTestId("infinite-tabs-canvas")).toHaveCount(0);
	const composer = page.getByPlaceholder("What do you want to do?");
	await expect(composer).toBeVisible();
	await composer.fill(LAUNCHPAD_DRAFT);
	await expect(
		page.getByRole("button", { name: "Send", exact: true })
	).toBeEnabled();
	await page.screenshot({
		path: `${evidence}/launchpad-composer-completed.png`,
	});
	await page.clock.setFixedTime(LAUNCHPAD_SEND_TIME);
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await expect(page.getByTestId("infinite-tabs-canvas")).toBeVisible();
	await expect(page.locator(".react-flow__node-tab")).toHaveCount(1);
	await expect
		.poll(() => sealedSession(page).then((session) => session.tabs[0]?.path))
		.toBe("/chat");
});
