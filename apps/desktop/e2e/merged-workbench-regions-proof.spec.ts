import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof tree.
const proof =
	process.env.RYU_MERGE_PROOF_DIR ??
	process.env.RYU_PROOF_EVIDENCE_DIR ??
	proofEvidencePath("merge-recovery-20261006");
test("actual Desktop shell overlays side panes in a narrow window and restores them when wide", async ({
	page,
}) => {
	// Run alone it also pays the dev server's cold compile of the whole shell.
	test.setTimeout(120_000);
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.route("**/api/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		if (!path.startsWith("/api/")) {
			return route.continue();
		}
		if (path === "/api/pi-config") {
			return route.fulfill({ json: { config: {} } });
		}
		if (path.startsWith("/api/auth/")) {
			return route.fulfill({ json: null });
		}
		return route.fulfill({ json: [] });
	});
	await page.addInitScript(() => {
		if (sessionStorage.getItem("narrow-proof")) {
			return;
		}
		sessionStorage.setItem("narrow-proof", "1");
		localStorage.setItem("ryu_tab_layout", "horizontal");
		localStorage.setItem("ryu:tab-dropdown", "false");
		localStorage.setItem("ryu_startup_behavior", "restore");
		localStorage.setItem(
			"ryu_session_tabs",
			JSON.stringify({
				tabs: [
					{ path: "/channels", title: "Channels" },
					{ path: "/library", title: "Library" },
				],
				activeIndex: 0,
			})
		);
	});
	await page.goto("/merged-workbench-proof.html");
	const channels = page
		.getByRole("button", { name: "Channels", exact: true })
		.last();
	await channels.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Move to pane", exact: true })
		.hover();
	await page.getByRole("menuitem", { name: "Right", exact: true }).click();
	const right = page.locator('section[aria-label="Right"]');
	await expect(right).toBeVisible();
	await expect(page.locator("[data-narrow]")).toHaveAttribute(
		"data-narrow",
		"false"
	);

	// cd5fcb4e28 folds the docked sidebar into the compact rail below 1024px,
	// which gives Center room for a docked Right at 900px; 800px still leaves
	// Center under its 400px minimum beside the 360px Right pane. The fold lands
	// in the same frame as the width change, so crossing to 900px never mounts
	// the overlay sheet, not even for a frame.
	await page.evaluate(() => {
		const proofWindow = window as Window & { __overlayScrimMounts?: number };
		proofWindow.__overlayScrimMounts = 0;
		new MutationObserver(() => {
			if (document.querySelector("[data-workbench-overlay-scrim]")) {
				proofWindow.__overlayScrimMounts =
					(proofWindow.__overlayScrimMounts ?? 0) + 1;
			}
		}).observe(document.body, { childList: true, subtree: true });
	});
	await page.setViewportSize({ width: 900, height: 900 });
	await expect(
		page.locator("[data-slot='sidebar'][data-state='collapsed']")
	).toBeAttached();
	await expect(right).toBeVisible();
	await expect(page.locator("[data-narrow]")).toHaveAttribute(
		"data-narrow",
		"false"
	);
	expect(
		await page.evaluate(
			() =>
				(window as Window & { __overlayScrimMounts?: number })
					.__overlayScrimMounts
		)
	).toBe(0);
	await page.setViewportSize({ width: 800, height: 900 });
	await expect(page.locator("[data-narrow]")).toHaveAttribute(
		"data-narrow",
		"true"
	);
	// Right still has focus, so it shows as an overlay sheet over Center.
	await expect(page.locator("[data-workbench-overlay-scrim]")).toBeAttached();
	await page.locator("[data-workbench-overlay-scrim]").click({
		position: { x: 20, y: 200 },
	});
	await expect(right).toHaveCount(0);
	// Toggle Right Panel opens and closes the sheet in a narrow window.
	await page.keyboard.press("ControlOrMeta+Alt+ArrowRight");
	await expect(right).toBeVisible();
	await page.keyboard.press("ControlOrMeta+Alt+ArrowRight");
	await expect(right).toHaveCount(0);

	await page.setViewportSize({ width: 1600, height: 1000 });
	await expect(page.locator("[data-narrow]")).toHaveAttribute(
		"data-narrow",
		"false"
	);
	await expect(right).toBeVisible();
	await expect(
		page.getByRole("separator", { name: "Resize Right" })
	).toBeVisible();
});

test("actual Desktop shell moves Navigation to the Right pane and back", async ({
	page,
}) => {
	// Includes a reload; run alone it also pays the dev server's cold compile.
	test.setTimeout(120_000);
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.route("**/api/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		if (!path.startsWith("/api/")) {
			return route.continue();
		}
		if (path === "/api/pi-config") {
			return route.fulfill({ json: { config: {} } });
		}
		if (path.startsWith("/api/auth/")) {
			return route.fulfill({ json: null });
		}
		return route.fulfill({ json: [] });
	});
	await page.addInitScript(() => {
		if (sessionStorage.getItem("navigation-proof")) {
			return;
		}
		sessionStorage.setItem("navigation-proof", "1");
		localStorage.setItem("ryu_tab_layout", "horizontal");
		localStorage.setItem("ryu_startup_behavior", "restore");
		localStorage.setItem(
			"ryu_session_tabs",
			JSON.stringify({
				tabs: [{ path: "/library", title: "Library" }],
				activeIndex: 0,
			})
		);
	});
	await page.goto("/merged-workbench-proof.html");
	const dockedSidebar = page.locator('[data-slot="sidebar-container"]');
	await expect(dockedSidebar).toBeVisible();

	const runCommand = async (name: string) => {
		await page.keyboard.press("ControlOrMeta+k");
		await page.keyboard.type(name);
		await page.getByRole("option", { name, exact: true }).click();
	};
	await runCommand("Move Navigation to Right");
	const right = page.locator('section[aria-label="Right"]');
	await expect(
		right.getByRole("tab", { name: "Navigation", exact: true })
	).toBeVisible();
	await expect(right.getByText("Projects & chats").first()).toBeVisible();
	await expect(dockedSidebar).toHaveCount(0);
	// The title bar keeps clear of the window's nav cluster, as when collapsed.
	const searchButton = await page
		.getByRole("button", { name: /search/i })
		.first()
		.boundingBox();
	const libraryTab = await page
		.getByRole("button", { name: "Library", exact: true })
		.first()
		.boundingBox();
	expect(libraryTab?.x ?? 0).toBeGreaterThan(
		(searchButton?.x ?? 0) + (searchButton?.width ?? 0)
	);

	await page.reload();
	await expect(
		right.getByRole("tab", { name: "Navigation", exact: true })
	).toBeVisible();
	await expect(dockedSidebar).toHaveCount(0);

	await page.keyboard.press("ControlOrMeta+b");
	await expect(right).toHaveCount(0);
	await page.keyboard.press("ControlOrMeta+b");
	await expect(right).toBeVisible();

	await runCommand("Move Navigation to Left");
	await expect(dockedSidebar).toBeVisible();
	await expect(right).toHaveCount(0);
});

test("actual sidebar auto-rename updates its title and preserves it when the model refuses", async ({
	page,
}) => {
	// Run alone it also pays the dev server's cold compile of the whole shell.
	test.setTimeout(120_000);
	await page.emulateMedia({ reducedMotion: "reduce" });
	let title = "Plan the week";
	let refuse = false;
	const calls: { method: string; token: string | null }[] = [];
	await page.route("**/api/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		if (!path.startsWith("/api/")) {
			return route.continue();
		}
		if (path === "/api/conversations/rename-proof/retitle") {
			calls.push({
				method: route.request().method(),
				token: route.request().headers().authorization ?? null,
			});
			if (refuse) {
				return route.fulfill({
					status: 422,
					json: { error: "No titling model available" },
				});
			}
			title = "Weekly planning";
			return route.fulfill({ json: { ok: true, title } });
		}
		if (path.startsWith("/api/auth/")) {
			return route.fulfill({ json: null });
		}
		return route.fulfill({
			json:
				path === "/api/conversations"
					? {
							conversations: [
								{
									id: "rename-proof",
									title,
									created_at: Date.now(),
									updated_at: Date.now(),
									message_count: 2,
									pinned: false,
									archived: false,
									participants: [],
								},
							],
						}
					: path === "/api/pi-config"
						? { config: {} }
						: [],
		});
	});
	await page.addInitScript(() => {
		localStorage.setItem("ryu_startup_behavior", "restore");
		localStorage.setItem(
			"ryu_session_tabs",
			JSON.stringify({
				tabs: [{ path: "/library", title: "Library" }],
				activeIndex: 0,
			})
		);
	});
	await page.goto("/merged-workbench-proof.html");
	await page
		.getByText("Plan the week", { exact: true })
		.first()
		.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Auto-rename", exact: true })
		.click();
	await expect(
		page.getByText("Weekly planning", { exact: true }).first()
	).toBeVisible();
	expect(calls).toEqual([{ method: "POST", token: "Bearer tabs-fixture" }]);
	refuse = true;
	await page
		.getByText("Weekly planning", { exact: true })
		.first()
		.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Auto-rename", exact: true })
		.click();
	await expect.poll(() => calls.length).toBe(2);
	await expect(
		page.getByText("Weekly planning", { exact: true }).first()
	).toBeVisible();
	await expect(
		page.getByText("No titling model available", { exact: false })
	).toBeVisible();
	await page.mouse.move(900, 400);
	const errorToast = page.locator(
		'[data-sileo-toast][data-state="error"][data-ready="true"] [data-sileo-header-inner][data-layer="current"]'
	);
	await expect(errorToast).toContainText("No titling model available");
	await expect(errorToast).toHaveCSS("opacity", "1");
	await page.screenshot({ path: `${proof}/merged-auto-rename-completed.png` });
});

test("actual chat opens its panels as workbench tabs from its header", async ({
	page,
}) => {
	// Run alone it also pays the dev server's cold compile of the whole shell.
	test.setTimeout(120_000);
	page.on("pageerror", (error) =>
		process.stderr.write(`PAGE ERROR: ${error.stack}\n`)
	);
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.route("**/api/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		if (!path.startsWith("/api/")) {
			return route.continue();
		}
		if (path === "/api/pi-config") {
			return route.fulfill({ json: { config: {} } });
		}
		if (path.startsWith("/api/auth/")) {
			return route.fulfill({ json: null });
		}
		return route.fulfill({ json: [] });
	});
	await page.addInitScript(() => {
		if (sessionStorage.getItem("chat-panels-proof")) {
			return;
		}
		sessionStorage.setItem("chat-panels-proof", "1");
		localStorage.setItem("ryu_tab_layout", "horizontal");
		localStorage.setItem("ryu_startup_behavior", "restore");
		localStorage.setItem(
			"ryu_session_tabs",
			JSON.stringify({
				tabs: [{ path: "/chat", title: "New chat" }],
				activeIndex: 0,
			})
		);
	});
	await page.goto("/merged-workbench-proof.html");
	const right = page.locator('section[aria-label="Right"]');
	const show = page.getByRole("button", { name: "Show right panel" });
	await expect(show).toBeVisible();
	await expect(right).toHaveCount(0);

	// No project is open, so the empty Right pane opens the chat's Context.
	await show.click();
	await expect(right.getByRole("tab", { name: /^Context: / })).toBeVisible();
	const hide = page.getByRole("button", { name: "Hide right panel" });
	await expect(hide).toHaveAttribute("aria-pressed", "true");
	await mkdir(proof, { recursive: true });
	await page.screenshot({ path: `${proof}/merged-workbench-chat-panels.png` });

	// The same button hides and shows the shared pane; the tab stays put.
	await hide.click();
	await expect(right).toHaveCount(0);
	await show.click();
	await expect(right.getByRole("tab")).toHaveCount(1);
});
