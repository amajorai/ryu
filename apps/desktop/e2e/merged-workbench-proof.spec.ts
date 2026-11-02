import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof tree.
const proof =
	process.env.RYU_MERGE_PROOF_DIR ??
	process.env.RYU_PROOF_EVIDENCE_DIR ??
	proofEvidencePath("merge-recovery-20261006");
test("actual Desktop shell moves pages between panes, adds a pane chat, and restores placement", async ({
	page,
}) => {
	// First in the file, so it also pays the dev server's cold compile of the
	// whole shell (about 50s here) on top of a reload.
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
		// The signed-out auth session is null, not a list; an array here reads as
		// a session without a user and crashes the account menu.
		if (path.startsWith("/api/auth/")) {
			return route.fulfill({ json: null });
		}
		return route.fulfill({ json: [] });
	});
	await page.addInitScript(() => {
		if (sessionStorage.getItem("merge-proof")) {
			return;
		}
		sessionStorage.setItem("merge-proof", "1");
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
	await expect(channels).toBeVisible();
	await channels.click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "Move to pane", exact: true })
		.hover();
	await page.getByRole("menuitem", { name: "Right", exact: true }).click();
	const right = page.getByRole("tablist", { name: "Right tabs" });
	await expect(
		right.getByRole("tab", { name: "Channels", exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "More Right tab actions" }).click();
	await page
		.getByRole("menuitem", { name: "Move to Bottom", exact: true })
		.click();
	const bottom = page.getByRole("tablist", { name: "Bottom tabs" });
	await expect(
		bottom.getByRole("tab", { name: "Channels", exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Add tab to Bottom" }).click();
	await expect(bottom.getByRole("tab")).toHaveCount(2);
	await bottom.getByRole("tab", { name: "Channels", exact: true }).click();
	await page.reload();
	await expect(
		bottom.getByRole("tab", { name: "Channels", exact: true })
	).toBeVisible();
	await expect(bottom.getByRole("tab")).toHaveCount(2);
	await expect(
		page.getByRole("searchbox", { name: "Search your library…" }).first()
	).toBeVisible();
	const handle = page.getByRole("separator", { name: "Resize Bottom" });
	const box = await handle.boundingBox();
	if (!box) {
		throw new Error("Missing bottom resize handle");
	}
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2, box.y - 130, { steps: 8 });
	await page.mouse.up();
	await mkdir(proof, { recursive: true });
	await page.screenshot({ path: `${proof}/merged-workbench-completed.png` });
	await page.getByRole("button", { name: "More Bottom tab actions" }).click();
	await page
		.getByRole("menuitem", { name: "Move to Center", exact: true })
		.click();
	await expect(channels).toBeVisible();
});

test("actual Desktop shell drags workbench tabs between regions", async ({
	page,
}) => {
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
		if (sessionStorage.getItem("drag-proof")) {
			return;
		}
		sessionStorage.setItem("drag-proof", "1");
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
	const right = page.getByRole("tablist", { name: "Right tabs" });
	const rightTab = right.getByRole("tab", { name: "Channels", exact: true });
	await expect(rightTab).toBeVisible();

	const dragTo = async (
		source: ReturnType<typeof page.getByRole>,
		target: () => ReturnType<typeof page.locator>
	) => {
		const from = await source.boundingBox();
		if (!from) {
			throw new Error("Missing drag source");
		}
		await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
		await page.mouse.down();
		await page.mouse.move(from.x + from.width / 2 - 12, from.y + 4, {
			steps: 4,
		});
		await expect(target()).toBeVisible();
		const to = await target().boundingBox();
		if (!to) {
			throw new Error("Missing drop target");
		}
		await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
			steps: 8,
		});
		await page.mouse.up();
	};

	await dragTo(rightTab, () =>
		page.locator('[data-workbench-edge-drop="bottom"]')
	);
	const bottom = page.getByRole("tablist", { name: "Bottom tabs" });
	const bottomTab = bottom.getByRole("tab", { name: "Channels", exact: true });
	await expect(bottomTab).toBeVisible();
	await expect(right).toHaveCount(0);

	await dragTo(bottomTab, () => page.locator("[data-tab-drop-overlay]"));
	await expect(bottom).toHaveCount(0);
	await expect(channels).toBeVisible();
});

test("actual Desktop shell opens an app panel as a workbench tab from the palette", async ({
	page,
}) => {
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
		if (path === "/api/plugins/contributions") {
			// A Left-preferring app panel whose native component this build does
			// not ship: Desktop keeps Left for navigation, so it opens in Right
			// and renders the safe unavailable body.
			return route.fulfill({
				json: {
					dock_panels: [
						{
							id: "notes",
							panel: "native",
							placement: "left",
							plugin: "com.example.proof",
							title: "Proof notes",
						},
					],
				},
			});
		}
		return route.fulfill({ json: [] });
	});
	await page.addInitScript(() => {
		if (sessionStorage.getItem("tool-proof")) {
			return;
		}
		sessionStorage.setItem("tool-proof", "1");
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
	await expect(
		page.getByRole("searchbox", { name: "Search your library…" }).first()
	).toBeVisible();

	const openFromPalette = async () => {
		await page.keyboard.press("ControlOrMeta+k");
		await page.keyboard.type("Open Proof notes");
		await page
			.getByRole("option", { name: "Open Proof notes", exact: true })
			.click();
	};
	await openFromPalette();
	const right = page.getByRole("tablist", { name: "Right tabs" });
	await expect(
		right.getByRole("tab", { name: "Proof notes", exact: true })
	).toBeVisible();
	await expect(
		page.getByText("This panel isn't available in this version.")
	).toBeVisible();

	await page.keyboard.press("ControlOrMeta+Alt+ArrowRight");
	await expect(right).toHaveCount(0);
	await openFromPalette();
	await expect(right.getByRole("tab")).toHaveCount(1);
});
