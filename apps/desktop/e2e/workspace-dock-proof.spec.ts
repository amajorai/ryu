import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

const committedProofDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-panels/workspace-dock"
);
// Ordinary runs write screenshots and ledgers to this test's Playwright output
// directory so the committed proof is never rewritten as a side effect. Set
// RYU_REFRESH_DOCK_PROOF=1 to deliberately regenerate the committed proof.
const refreshCommittedProof = process.env.RYU_REFRESH_DOCK_PROOF === "1";
const proofPath = (fileName: string) =>
	refreshCommittedProof
		? path.join(committedProofDir, fileName)
		: test.info().outputPath(fileName);

import type { WorkspaceDockProofKernel } from "./harness/workspace-dock-proof.tsx";

declare const window: Window & { dockProof: WorkspaceDockProofKernel };

const snapshot = (page: Page) =>
	page.evaluate(() => window.dockProof.snapshot());
async function expectDeclaredContracts(page: Page) {
	const state = await snapshot(page);
	expect(state.unexpectedNativeCommands).toEqual([]);
	expect(state.unexpectedRoutes).toEqual([]);
}
function requireWorkspaceSession(
	tab: ReturnType<WorkspaceDockProofKernel["snapshot"]>["tabs"][number]
) {
	const session = tab.workspaceSession;
	if (!session) {
		throw new TypeError(
			"WorkspaceDock fixture requires an active workspace session"
		);
	}
	return session;
}

const terminal = (page: Page) => page.locator('input[autocapitalize="none"]');
async function menu(page: Page, tab: string, action: string) {
	await page
		.locator('[data-slot="context-menu-trigger"]')
		.getByRole("button", { name: tab, exact: true })
		.click({ button: "right" });
	await page.getByRole("menuitem", { name: action, exact: true }).click();
}
let workspaceErrors: string[] = [];
const pendingRequests = new Set<string>();
test.beforeEach(async ({ page }) => {
	if (refreshCommittedProof) {
		await mkdir(committedProofDir, { recursive: true });
	}
	workspaceErrors = [];
	pendingRequests.clear();
	page.on("pageerror", (error) => workspaceErrors.push(error.message));
	page.on("request", (request) => pendingRequests.add(request.url()));
	page.on("requestfinished", (request) =>
		pendingRequests.delete(request.url())
	);
	page.on("requestfailed", (request) => pendingRequests.delete(request.url()));
	await page.goto("workspace-dock-proof.html", {
		waitUntil: "domcontentloaded",
	});
	await expect(page.getByText("Workspace dock", { exact: true })).toBeVisible({
		timeout: 30_000,
	});
});
test.afterEach(async ({ page }, info) => {
	const state = await snapshot(page);
	const name = info.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
	await writeFile(
		proofPath(`${name}-browser.json`),
		JSON.stringify(
			{
				errors: workspaceErrors,
				pending: [...pendingRequests],
				unexpectedNativeCommands: state.unexpectedNativeCommands,
				unexpectedRoutes: state.unexpectedRoutes,
				status: info.status,
			},
			null,
			2
		)
	);
	if (info.status === "passed") {
		expect(workspaceErrors).toEqual([]);
		await expectDeclaredContracts(page);
	} else if (!page.isClosed()) {
		await page
			.screenshot({ path: proofPath(`${name}-failure.png`) })
			.catch(() => {});
	}
});

test("registered Browser fallback navigates safely while the separate app roster is pending", async ({
	page,
}) => {
	const frameRequests: string[] = [];
	await page.route(/^https:\/\//, async (route) => {
		frameRequests.push(route.request().url());
		await route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><html><body><h1>Fixture page loaded</h1></body></html>",
		});
	});
	await page.goto("/workspace-dock-proof.html?iframe=1", {
		waitUntil: "domcontentloaded",
	});
	await page
		.getByRole("button", { name: "Show bottom panel", exact: true })
		.click();
	await page.getByRole("button", { name: "Browser", exact: true }).click();
	const input = page.getByPlaceholder("Enter URL…");
	await expect(input).toBeVisible();
	await input.fill("fixture.invalid/docs");
	await input.press("Enter");
	const frame = page.locator('iframe[title="Browser"]');
	await expect(frame).toHaveAttribute("src", "https://fixture.invalid/docs");
	await expect(frame).toHaveAttribute(
		"sandbox",
		"allow-scripts allow-forms allow-popups"
	);
	await writeFile(
		test.info().outputPath("ryu-iframe-diagnostic.json"),
		JSON.stringify(
			{
				requests: frameRequests,
				frames: await Promise.all(
					page.frames().map(async (item) => ({
						url: item.url(),
						html: await item.content().catch(() => "unavailable"),
					}))
				),
			},
			null,
			2
		)
	);
	await expect(
		page
			.frameLocator('iframe[title="Browser"]')
			.getByRole("heading", { name: "Fixture page loaded" })
	).toBeVisible();
	await input.fill("javascript:window.alert(1)");
	await input.press("Enter");
	await expect(frame).toHaveAttribute("src", "https://fixture.invalid/docs");
	await input.fill("https://fixture.invalid/retry");
	await input.press("Enter");
	await expect(frame).toHaveAttribute("src", "https://fixture.invalid/retry");
	await expect(
		page
			.frameLocator('iframe[title="Browser"]')
			.getByRole("heading", { name: "Fixture page loaded" })
	).toBeVisible();
	expect(frameRequests).toContain("https://fixture.invalid/retry");
	expect(frameRequests.some((url) => url.startsWith("javascript:"))).toBe(
		false
	);
	// Capture settled panel placement after the dock spring completes.
	await page.waitForTimeout(700);
	await page.screenshot({
		path: proofPath("dock-iframe-safe-navigation.png"),
	});
});

test("manifest-contributed Simulator reaches native panel and retries exact device actions", async ({
	page,
}) => {
	await page.locator("header button").nth(2).click();
	await page.getByRole("button", { name: "Simulator", exact: true }).click();
	await expect(page.getByText("Fixture node has no iOS runtime")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Boot", exact: true })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Android fixture Android 15" })
		.click();
	const beforeRefresh = (await snapshot(page)).httpRequests.length;
	await page
		.getByRole("button", { name: "Boot", exact: true })
		.locator("..")
		.locator("button")
		.last()
		.click();
	await expect
		.poll(async () => (await snapshot(page)).httpRequests.length)
		.toBeGreaterThan(beforeRefresh);
	await page.evaluate(() => window.dockProof.failAction());
	await page.getByRole("button", { name: "Boot", exact: true }).click();
	await expect(page.getByText("503", { exact: true })).toBeVisible();
	expect((await snapshot(page)).deviceState).toBe("shutdown");
	await page.getByRole("button", { name: "Boot", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Shutdown", exact: true })
	).toBeVisible();
	const image = page.getByAltText("Device screen");
	await expect(image).toBeVisible();
	const shotBounds = await image.boundingBox();
	expect(shotBounds).not.toBeNull();
	if (!shotBounds) {
		throw new Error("Device screen geometry was unavailable.");
	}
	const tapPoint = {
		x: Math.round(shotBounds.x + 60),
		y: Math.round(shotBounds.y + 100),
	};
	await page.mouse.click(tapPoint.x, tapPoint.y);
	await page.getByRole("button", { name: "Home", exact: true }).click();
	await page.getByRole("button", { name: "Back", exact: true }).click();
	// Each device action is an asynchronous HTTP POST; wait for the fixture to
	// acknowledge all five before asserting their exact order and bodies.
	await expect
		.poll(
			async () =>
				(await snapshot(page)).httpRequests.filter((r) => r.method === "POST")
					.length
		)
		.toBe(5);
	const posts = (await snapshot(page)).httpRequests.filter(
		(r) => r.method === "POST"
	);
	expect(posts.map((r) => [r.path, r.status])).toEqual([
		["/api/ext/@ryu/simulator/devices/android%20fixture%2F1/boot", 503],
		["/api/ext/@ryu/simulator/devices/android%20fixture%2F1/boot", 200],
		["/api/ext/@ryu/simulator/devices/android%20fixture%2F1/tap", 200],
		["/api/ext/@ryu/simulator/devices/android%20fixture%2F1/key", 200],
		["/api/ext/@ryu/simulator/devices/android%20fixture%2F1/key", 200],
	]);
	expect(
		posts.every((r) => r.authorization === "Bearer dock-fixture-token")
	).toBe(true);
	expect(posts[2].body).toEqual({
		x: Math.round(((tapPoint.x - shotBounds.x) / shotBounds.width) * 240),
		y: Math.round(((tapPoint.y - shotBounds.y) / shotBounds.height) * 400),
	});
	expect(posts[3].body).toEqual({ key: "home" });
	expect(posts[4].body).toEqual({ key: "back" });
	// Capture settled panel placement after the dock spring completes.
	await page.waitForTimeout(700);
	await page.screenshot({
		path: proofPath("dock-simulator-booted-actions.png"),
	});
	await expectDeclaredContracts(page);
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Shutdown", exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Shutdown", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Boot", exact: true })
	).toBeVisible();
	expect((await snapshot(page)).deviceState).toBe("shutdown");
});

test("real dock launchpad, terminal failure/retry/history, pin/move and session readback", async ({
	page,
}) => {
	// PanelToggleButtons shipping tooltip trigger has no aria-label; choose by its tooltip.
	await page.locator("header button").nth(2).click();
	await page
		.getByRole("button", { name: "Terminal", exact: true })
		.first()
		.click();
	await expect(terminal(page)).toBeVisible();
	await terminal(page)
		.locator("../..")
		.click({ position: { x: 100, y: 30 } });
	await expect(terminal(page)).toBeFocused();
	await terminal(page).fill("fixture status");
	await terminal(page).press("Enter");
	await expect(
		page.getByText("Fixture command completed", { exact: true })
	).toBeVisible();
	expect(
		(await snapshot(page)).requests.filter((r) => r.command === "shell_execute")
	).toEqual([
		{
			command: "shell_execute",
			args: { command: "fixture status", cwd: "/fixture/project", shell: null },
		},
	]);
	await terminal(page).press("ArrowUp");
	await expect(terminal(page)).toHaveValue("fixture status");
	await terminal(page).press("ArrowDown");
	await expect(terminal(page)).toHaveValue("");
	await page.evaluate(() => window.dockProof.failShell());
	await terminal(page).fill("fixture retry");
	await terminal(page).press("Enter");
	await expect(
		page.getByText("Error: Fixture shell unavailable", { exact: true })
	).toBeVisible();
	await terminal(page).press("ArrowUp");
	await terminal(page).press("Enter");
	await expect(terminal(page)).toBeEnabled();
	expect(
		(await snapshot(page)).requests.filter((r) => r.command === "shell_execute")
	).toEqual([
		{
			command: "shell_execute",
			args: { command: "fixture status", cwd: "/fixture/project", shell: null },
		},
		{
			command: "shell_execute",
			args: { command: "fixture retry", cwd: "/fixture/project", shell: null },
		},
		{
			command: "shell_execute",
			args: { command: "fixture retry", cwd: "/fixture/project", shell: null },
		},
	]);
	await expect(page.getByText("Fixture stderr", { exact: true })).toHaveCount(
		2
	);
	await menu(page, "Terminal", "Pin tab");
	await expect
		.poll(
			async () => (await snapshot(page)).projects["/fixture/project"][0].pinned
		)
		.toBe(true);
	const uid = (await snapshot(page)).projects["/fixture/project"][0].uid;
	await menu(page, "Terminal", "Move to right panel");
	await expect
		.poll(
			async () =>
				requireWorkspaceSession((await snapshot(page)).tabs[0]).rightOpen
		)
		.toBe(true);
	await expect(terminal(page)).toBeVisible();
	expect((await snapshot(page)).projects["/fixture/project"][0]).toMatchObject({
		uid,
		side: "right",
		pinned: true,
	});
	await expect(page.getByText("Fixture stderr", { exact: true })).toHaveCount(
		2
	);
	await expect
		.poll(
			async () =>
				JSON.parse(String((await snapshot(page)).storage))?.tabs?.[0]
					?.workspaceSession?.right?.tabs?.[0]?.uid
		)
		.toBe(uid);
	await expectDeclaredContracts(page);
	await page.reload();
	await expect(terminal(page)).toBeVisible();
	expect((await snapshot(page)).projects["/fixture/project"]).toHaveLength(1);
	expect((await snapshot(page)).projects["/fixture/project"][0]).toMatchObject({
		uid,
		side: "right",
		pinned: true,
	});
	await terminal(page).fill("fixture readback");
	await terminal(page).press("Enter");
	await expect(
		page.getByText("Fixture command completed", { exact: true })
	).toBeVisible();
	// Capture settled panel placement after the dock spring completes.
	await page.waitForTimeout(700);
	await page.screenshot({
		path: proofPath("dock-pinned-terminal-restored.png"),
	});
	await menu(page, "Terminal", "Close all");
	await expect(terminal(page)).toBeVisible(); // pinned tabs survive Close all
	await menu(page, "Terminal", "Unpin tab");
	await page.getByRole("button", { name: "Close tab", exact: true }).click();
	await expect
		.poll(
			async () =>
				(await snapshot(page)).projects["/fixture/project"]?.length ?? 0
		)
		.toBe(0);
});

test("real project terminal consumes command request once, clamps divider and clears transcript", async ({
	page,
}) => {
	await page.evaluate(() => window.dockProof.openCommand());
	await expect(terminal(page)).toBeVisible();
	await expect(
		page.getByText("Fixture command completed", { exact: true })
	).toBeVisible();
	expect(
		(await snapshot(page)).requests.filter((r) => r.command === "shell_execute")
	).toEqual([
		{
			command: "shell_execute",
			args: {
				command: "fixture setup",
				cwd: "/fixture/setup",
				shell: "zsh",
				env: { FIXTURE: "yes" },
			},
		},
	]);
	const handle = page.locator(".cursor-row-resize");
	const bounds = await handle.boundingBox();
	expect(bounds).not.toBeNull();
	await page.mouse.move(bounds!.x + 30, bounds!.y + 3);
	await page.mouse.down();
	await page.mouse.move(bounds!.x + 30, bounds!.y + 3 - 120);
	await page.mouse.up();
	expect(await page.evaluate(() => document.body.style.cursor)).toBe("");
	expect(
		await handle
			.locator("..")
			.evaluate((el) => el.getBoundingClientRect().height)
	).toBe(392);
	await page.mouse.move(bounds!.x + 30, (await handle.boundingBox())!.y + 3);
	await page.mouse.down();
	await page.mouse.move(bounds!.x + 30, 0);
	await page.mouse.up();
	const headerHeight = await page
		.locator("header")
		.evaluate((element) => element.getBoundingClientRect().height);
	await expect
		.poll(() =>
			handle
				.locator("..")
				.evaluate((element) => element.getBoundingClientRect().height)
		)
		.toBeCloseTo(720 - headerHeight - 120 + 12, 2);
	await page.setViewportSize({ width: 1280, height: 400 });
	await expect
		.poll(() =>
			handle.locator("..").evaluate((el) => el.getBoundingClientRect().height)
		)
		.toBeCloseTo(400 - headerHeight - 120 + 12, 2);
	await terminal(page).press("Control+l");
	await expect(
		page.getByText("Fixture command completed", { exact: true })
	).toHaveCount(0);
	expect(
		(await snapshot(page)).requests.filter((r) => r.command === "shell_execute")
	).toHaveLength(1);
	// Capture settled panel placement after the dock spring completes.
	await page.waitForTimeout(700);
	await page.screenshot({
		path: proofPath("dock-divider-terminal-cleared.png"),
	});
});

test("editor choice persists and real dock menu closes others and middle-clicks", async ({
	page,
}) => {
	await page.getByRole("button", { name: "Choose editor" }).click();
	await page.getByRole("menuitem", { name: "VS Code" }).click();
	expect(
		(await snapshot(page)).requests.filter(
			(r) => r.command === "open_in_editor"
		)
	).toEqual([
		{
			command: "open_in_editor",
			args: { editor: "vscode", path: "/fixture/project" },
		},
	]);
	expect(
		await page.evaluate(() =>
			localStorage.getItem("ryu_workspace_default_file_opener")
		)
	).toBe("vscode");
	await expectDeclaredContracts(page);
	await page.reload();
	await page
		.getByRole("button", { name: "Open in VS Code", exact: true })
		.hover();
	await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(
		"Open in VS Code: /fixture/project"
	);
	await page.locator("header button").first().click();
	expect(
		(await snapshot(page)).requests.filter(
			(r) => r.command === "open_in_editor"
		)
	).toEqual([
		{
			command: "open_in_editor",
			args: { editor: "vscode", path: "/fixture/project" },
		},
	]);
	await page.locator("header button").nth(2).click();
	await page
		.getByRole("button", { name: "Terminal", exact: true })
		.first()
		.click();
	await page.getByRole("button", { name: "New tab", exact: true }).click();
	await page.getByRole("menuitem", { name: "Terminal", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Terminal 2", exact: true })
	).toBeVisible();
	await menu(page, "Terminal 2", "Close others");
	await expect(
		page.getByRole("button", { name: "Terminal", exact: true })
	).toHaveCount(0);
	expect((await snapshot(page)).projects["/fixture/project"]).toHaveLength(1);
	await page
		.getByRole("button", { name: "Terminal 2", exact: true })
		.click({ button: "middle" });
	await expect
		.poll(
			async () =>
				(await snapshot(page)).projects["/fixture/project"]?.length ?? 0
		)
		.toBe(0);
	// Capture settled panel placement after the dock spring completes.
	await page.waitForTimeout(700);
	await page.screenshot({
		path: proofPath("dock-close-others-middle-click-empty.png"),
	});
});

test("right divider geometry and hover peek preserve closed session state", async ({
	page,
}) => {
	await page.locator("header button").nth(3).click();
	await page
		.getByRole("button", { name: "Terminal", exact: true })
		.first()
		.click();
	const handle = page.locator(".cursor-col-resize");
	await expect(handle).toBeVisible();
	const before = (await handle.boundingBox())!;
	await page.mouse.move(before.x + 3, before.y + 100);
	await page.mouse.down();
	await page.mouse.move(before.x + 3 - 120, before.y + 100);
	await page.mouse.up();
	expect(
		await handle
			.locator("..")
			.evaluate((el) => el.getBoundingClientRect().width)
	).toBe(472);
	expect(await page.evaluate(() => document.body.style.userSelect)).toBe("");
	const resized = (await handle.boundingBox())!;
	await page.mouse.move(resized.x + 3, resized.y + 100);
	await page.mouse.down();
	await page.mouse.move(1279, resized.y + 100);
	await page.mouse.up();
	expect(
		await handle
			.locator("..")
			.evaluate((el) => el.getBoundingClientRect().width)
	).toBe(92);
	const minimum = (await handle.boundingBox())!;
	await page.mouse.move(minimum.x + 3, minimum.y + 100);
	await page.mouse.down();
	await page.mouse.move(0, minimum.y + 100);
	await page.mouse.up();
	expect(
		await handle
			.locator("..")
			.evaluate((el) => el.getBoundingClientRect().width)
	).toBe(812);
	await page.locator("header button").nth(3).click();
	await expect
		.poll(
			async () =>
				requireWorkspaceSession((await snapshot(page)).tabs[0]).rightOpen
		)
		.toBe(false);
	await page.mouse.move(1278, 400);
	await expect(terminal(page)).toBeVisible();
	expect(
		requireWorkspaceSession((await snapshot(page)).tabs[0]).rightOpen
	).toBe(false);
	await page.mouse.move(1100, 400);
	await expect(terminal(page)).toBeVisible();
	await page.mouse.move(400, 300);
	await expect
		.poll(() =>
			handle.locator("..").evaluate((el) => el.getBoundingClientRect().x)
		)
		.toBe(1280);
	await page.locator("header button").nth(3).click();
	await expect(terminal(page)).toBeVisible();
	// Capture settled panel placement after the dock spring completes.
	await page.waitForTimeout(700);
	await page.screenshot({
		path: proofPath("dock-right-resized-restored.png"),
	});
});
