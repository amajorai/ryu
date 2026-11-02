import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	evidenceDir,
	makeDashboard,
	makeFixture,
	makeWidget,
	mountHome,
} from "./home-dashboard-proof.helpers.ts";

test.beforeAll(async () => {
	await mkdir(evidenceDir, { recursive: true });
});

test("dashboard list failure retries into the persisted dashboard instead of showing a false empty state", async ({
	page,
}) => {
	const state = makeFixture({
		failNext: ["GET /api/dashboards"],
		widgets: [makeWidget("dash-home")],
	});
	await mountHome(page, state);

	await expect(
		page.getByText("Couldn't load your dashboard", { exact: true })
	).toBeVisible();
	await expect(page.getByText("Your work dashboard is empty")).toBeHidden();
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(page.getByText("Initial item")).toBeVisible();
	await expect
		.poll(
			() => state.calls.filter((call) => call.path === "/api/dashboards").length
		)
		.toBe(2);

	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "home-dashboard-list-error-recovered.png"),
	});
});

test("create, rename, cancel delete, and delete persist exact dashboard state and fall back safely", async ({
	page,
}) => {
	const state = makeFixture({
		dashboards: [
			makeDashboard("dash-home", "Home"),
			makeDashboard("dash-research", "Research"),
		],
	});
	await mountHome(page, state);
	await expect(
		page.getByRole("button", { name: "Home", exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Home", exact: true }).click();
	await page.getByRole("menuitem", { name: "Research", exact: true }).click();
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("button", { name: "Research", exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Research", exact: true }).click();
	await page.getByRole("menuitem", { name: "Home", exact: true }).click();
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("button", { name: "Home", exact: true })
	).toBeVisible();

	await page.getByRole("button", { name: "Home", exact: true }).click();
	await page
		.getByRole("menuitem", { name: "New dashboard", exact: true })
		.click();
	const canceledCreateDialog = page.getByRole("dialog", {
		name: "New dashboard",
	});
	await page.keyboard.press("Escape");
	await expect(canceledCreateDialog).toBeHidden();
	expect(
		state.calls.some(
			(call) => call.method === "POST" && call.path === "/api/dashboards"
		)
	).toBe(false);
	await page.getByRole("button", { name: "Home", exact: true }).click();
	await page
		.getByRole("menuitem", { name: "New dashboard", exact: true })
		.click();
	const createDialog = page.getByRole("dialog", { name: "New dashboard" });
	const nameInput = createDialog.getByPlaceholder("Dashboard name");
	const createButton = createDialog.getByRole("button", { name: "Create" });
	await expect(createButton).toBeDisabled();
	await nameInput.fill("  Roadmap  ");
	await createButton.click();
	await expect(
		page.getByRole("button", { name: "Roadmap", exact: true })
	).toBeVisible();
	expect(
		state.calls.find(
			(call) => call.method === "POST" && call.path === "/api/dashboards"
		)?.body
	).toEqual({ name: "Roadmap" });

	await page.getByRole("button", { name: "Roadmap", exact: true }).click();
	await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
	const canceledRenameDialog = page.getByRole("dialog", {
		name: "Rename dashboard",
	});
	await canceledRenameDialog
		.getByPlaceholder("Dashboard name")
		.fill("Discard this name");
	await canceledRenameDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(canceledRenameDialog).toBeHidden();
	expect(
		state.calls.some(
			(call) =>
				call.method === "PUT" && call.path === "/api/dashboards/dash-created-1"
		)
	).toBe(false);

	await page.getByRole("button", { name: "Roadmap", exact: true }).click();
	await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
	const renameDialog = page.getByRole("dialog", { name: "Rename dashboard" });
	await renameDialog.getByPlaceholder("Dashboard name").fill("  Launch  ");
	const renameRefresh = page.waitForResponse(
		(response) =>
			response.request().method() === "GET" &&
			new URL(response.url()).pathname === "/api/dashboards"
	);
	await renameDialog.getByPlaceholder("Dashboard name").press("Enter");
	await renameRefresh;
	await expect(
		page.getByRole("button", { name: "Launch", exact: true })
	).toBeVisible();
	expect(
		state.calls.find(
			(call) =>
				call.method === "PUT" && call.path === "/api/dashboards/dash-created-1"
		)?.body
	).toEqual({ name: "Launch" });
	expect(
		state.dashboards.find((dashboard) => dashboard.id === "dash-created-1")
			?.name
	).toBe("Launch");

	await page.getByRole("button", { name: "Launch", exact: true }).click();
	await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
	const deleteDialog = page.getByRole("alertdialog", {
		name: 'Delete "Launch"?',
	});
	await deleteDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(deleteDialog).toBeHidden();
	expect(
		state.calls.some(
			(call) =>
				call.method === "DELETE" &&
				call.path === "/api/dashboards/dash-created-1"
		)
	).toBe(false);

	await page.getByRole("button", { name: "Launch", exact: true }).click();
	await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
	await page
		.getByRole("alertdialog", { name: 'Delete "Launch"?' })
		.getByRole("button", { name: "Delete", exact: true })
		.click();
	await expect
		.poll(() =>
			state.calls.some(
				(call) =>
					call.method === "DELETE" &&
					call.path === "/api/dashboards/dash-created-1"
			)
		)
		.toBe(true);
	await expect
		.poll(() => state.dashboards.map((dashboard) => dashboard.name))
		.toEqual(["Home", "Research"]);
	await expect
		.poll(() => {
			const reads = state.calls
				.filter(
					(call) =>
						call.method === "GET" &&
						call.path.startsWith("/api/dashboards/dash-")
				)
				.map((call) => call.path);
			return reads.at(-1);
		})
		.toBe("/api/dashboards/dash-home");
	await expect(page.getByRole("alertdialog")).toBeHidden();
	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "home-dashboard-delete-fallback.png"),
	});
	expect(await page.getByTestId("titlebar-actions").innerText()).toContain(
		"Home"
	);
	await expect(
		page.getByRole("button", { name: "Home", exact: true })
	).toBeVisible();
});

test("view mode and quick-add preserve layout, seed canvas placement, refresh live values, and remove widgets", async ({
	page,
}) => {
	const state = makeFixture({
		widgets: [makeWidget("dash-home")],
	});
	await mountHome(page, state);
	await expect(page.getByText("Initial item")).toBeVisible();

	await page.getByRole("button", { name: "Canvas view" }).click();
	await expect(page.getByTestId("home-dashboard-canvas")).toBeVisible();
	await expect
		.poll(
			() =>
				state.calls.find(
					(call) =>
						call.method === "PUT" && call.path === "/api/dashboards/dash-home"
				)?.body
		)
		.toEqual({ view_mode: "canvas" });

	await page.getByRole("button", { name: "Home", exact: true }).click();
	await page
		.getByRole("menuitem", { name: "Add widget", exact: false })
		.click();
	await page
		.getByRole("menuitem", { name: "Open quests", exact: true })
		.click();
	await expect(
		page.getByTestId("home-dashboard-canvas").getByText("Open quests", {
			exact: true,
		})
	).toBeVisible();
	const created = state.calls.find(
		(call) =>
			call.method === "POST" &&
			call.path === "/api/dashboards/dash-home/widgets"
	);
	expect(created?.body).toMatchObject({
		canvas: { h: 240, w: 320, x: 584, y: 130 },
		kind: "list",
		layout: { h: 4, w: 4, x: 0, y: 3 },
		source: { endpoint: "quests", selector: "quests", type: "core_endpoint" },
		title: "Open quests",
	});
	const newWidgetId = String(
		created?.body && state.widgets["dash-home"].at(-1)?.id
	);
	await expect
		.poll(() =>
			state.calls.some(
				(call) =>
					call.method === "POST" &&
					call.path ===
						`/api/dashboards/dash-home/widgets/${newWidgetId}/refresh`
			)
		)
		.toBe(true);

	await page.getByRole("button", { name: "Grid view" }).click();
	await expect(page.getByText("Refreshed from fixture")).toBeVisible();
	await page
		.getByRole("button", { name: "Widget actions for Open quests" })
		.click();
	await expect(
		page.getByRole("button", { name: "Widget actions for Open quests" })
	).toHaveAttribute("aria-expanded", "true");
	await page.getByRole("menuitem", { name: "Refresh", exact: true }).click();
	await expect
		.poll(
			() =>
				state.calls.filter(
					(call) =>
						call.method === "POST" &&
						call.path ===
							`/api/dashboards/dash-home/widgets/${newWidgetId}/refresh`
				).length
		)
		.toBe(2);
	await expect(page.getByText("Refreshed from fixture")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Widget actions for Open quests" })
	).toHaveAttribute("aria-expanded", "false");
	await page
		.getByRole("button", { name: "Widget actions for Open quests" })
		.click();
	await expect(
		page.getByRole("button", { name: "Widget actions for Open quests" })
	).toHaveAttribute("aria-expanded", "true");
	await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Widget actions for Open quests" })
	).toBeHidden();
	expect(
		state.calls.some(
			(call) =>
				call.method === "DELETE" &&
				call.path === `/api/dashboards/dash-home/widgets/${newWidgetId}`
		)
	).toBe(true);

	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "home-dashboard-canvas-and-quick-add.png"),
	});
});

test("empty dashboard offers the AI starter and hands its prompt to the global assistant's dashboard builder", async ({
	page,
}) => {
	const state = makeFixture();
	await mountHome(page, state);
	await expect(page.getByText("Your work dashboard is empty")).toBeVisible();
	await page.getByRole("button", { name: "Build a work view for me" }).click();
	await expect(page.getByTestId("home-builder-panel")).toBeVisible();
	await expect(page.getByTestId("home-assistant-mode")).toHaveText("sidebar");
	await expect(page.getByTestId("home-builder-kind")).toHaveText("dashboard");
	await expect(page.getByTestId("home-builder-target")).toHaveText("dash-home");
	await expect(page.locator("#dashboard-builder-chat")).toHaveCount(0);
	await expect(page.getByTestId("home-builder-auto-prompt")).toContainText(
		"Build me a useful starter Home dashboard"
	);
	await expect(
		page.getByText("Assembling your work view…", { exact: true })
	).toBeVisible();

	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "home-dashboard-ai-starter-handoff.png"),
	});
});

test("empty-state custom widget flow validates the dialog, saves its source/config, and survives reload", async ({
	page,
}) => {
	const state = makeFixture();
	await mountHome(page, state);
	await page.getByRole("button", { name: "Add a widget", exact: true }).click();
	const firstDialog = page.getByRole("dialog", { name: "Add widget" });
	await expect(firstDialog).toBeVisible();
	await firstDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(firstDialog).toBeHidden();

	await page.getByRole("button", { name: "Home", exact: true }).click();
	await page
		.getByRole("menuitem", { name: "Add widget", exact: false })
		.click();
	await page
		.getByRole("menuitem", { name: "Custom widget…", exact: true })
		.click();
	const dialog = page.getByRole("dialog", { name: "Add widget" });
	await dialog.getByLabel("Title").fill("Portfolio watch");
	// The dialog starts on the always-available Static source; choose the
	// built-in Core metric to reach its endpoint and selector fields.
	await dialog
		.getByRole("combobox")
		.filter({ hasText: "Static / inline data" })
		.click();
	await page
		.getByRole("option", { name: "Core metric (built-in)", exact: true })
		.click();
	await dialog.getByLabel("Selector (optional)").fill("clients");
	await dialog.getByLabel("Refresh every").fill("45s");
	await dialog
		.getByText("Advanced: display config (JSON)", { exact: true })
		.click();
	await dialog
		.getByPlaceholder(/charts:/)
		.fill('{"label":"Online clients","unit":"people"}');
	await dialog.getByRole("button", { name: "Add widget", exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(
		page.getByText("Portfolio watch", { exact: true })
	).toBeVisible();
	const createCall = state.calls.find(
		(call) =>
			call.method === "POST" &&
			call.path === "/api/dashboards/dash-home/widgets"
	);
	expect(createCall?.body).toMatchObject({
		config: { label: "Online clients", unit: "people" },
		kind: "stat",
		layout: { h: 3, w: 3, x: 0, y: 0 },
		refresh_interval: "45s",
		source: {
			endpoint: "connections",
			selector: "clients",
			type: "core_endpoint",
		},
		title: "Portfolio watch",
	});

	await page.reload();
	await expect(
		page.getByText("Portfolio watch", { exact: true })
	).toBeVisible();
	await expect
		.poll(
			() =>
				state.calls.filter(
					(call) =>
						call.method === "GET" && call.path === "/api/dashboards/dash-home"
				).length
		)
		.toBe(2);

	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "home-dashboard-custom-widget-persisted.png"),
	});
});

test("titlebar builder opens without an unsolicited starter prompt", async ({
	page,
}) => {
	const state = makeFixture({ widgets: [makeWidget("dash-home")] });
	await mountHome(page, state);
	await expect(page.getByText("Initial item")).toBeVisible();
	await page.getByRole("button", { name: "Home", exact: true }).click();
	await page
		.getByRole("menuitem", { name: "Build a work view", exact: true })
		.click();
	await expect(page.getByTestId("home-builder-panel")).toBeVisible();
	await expect(page.getByTestId("home-builder-target")).toHaveText("dash-home");
	await expect(page.getByTestId("home-builder-thread")).toHaveText(
		"dashboard:dash-home"
	);
	await expect(page.getByTestId("home-builder-auto-prompt")).toHaveCount(0);
	await expect(page.getByText("Initial item")).toBeVisible();
});

test("closing the global assistant ends build mode and releases the dashboard surface", async ({
	page,
}) => {
	const state = makeFixture({ widgets: [makeWidget("dash-home")] });
	await mountHome(page, state);
	await expect(page.getByText("Initial item")).toBeVisible();
	await page.getByRole("button", { name: "Home", exact: true }).click();
	await page
		.getByRole("menuitem", { name: "Build a work view", exact: true })
		.click();
	await expect(page.getByTestId("home-builder-kind")).toHaveText("dashboard");
	await page.getByRole("button", { name: "Close assistant" }).click();
	await expect(page.getByTestId("home-builder-panel")).toHaveCount(0);
	await page.getByRole("button", { name: "Home", exact: true }).click();
	await page
		.getByRole("menuitem", { name: "Build a work view", exact: true })
		.click();
	await expect(page.getByTestId("home-builder-kind")).toHaveText("dashboard");
	await expect(page.getByTestId("home-assistant-mode")).toHaveText("sidebar");
});

test("banner retry recovers a failed refresh and dismiss clears a later stale-data warning", async ({
	page,
}) => {
	const state = makeFixture({ widgets: [makeWidget("dash-home")] });
	await mountHome(page, state);
	await expect(page.getByText("Initial item")).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.__homeDashboardProof?.notifyResourceChanged instanceof Function
			)
		)
		.toBe(true);

	state.failNext.add("GET /api/dashboards/dash-home");
	await page.evaluate(() =>
		window.__homeDashboardProof?.notifyResourceChanged()
	);
	await expect(
		page.getByText(
			"We couldn't load this dashboard. Check your connection and try again."
		)
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Dismiss error" })
	).toBeVisible();
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(
		page.getByText(
			"We couldn't load this dashboard. Check your connection and try again."
		)
	).toBeHidden();
	await expect(page.getByText("Initial item")).toBeVisible();

	state.failNext.add("GET /api/dashboards/dash-home");
	await page.evaluate(() =>
		window.__homeDashboardProof?.notifyResourceChanged()
	);
	await expect(
		page.getByRole("button", { name: "Dismiss error" })
	).toBeVisible();
	await page.getByRole("button", { name: "Dismiss error" }).click();
	await expect(
		page.getByText(
			"We couldn't load this dashboard. Check your connection and try again."
		)
	).toBeHidden();
	await expect(page.getByText("Initial item")).toBeVisible();
});
