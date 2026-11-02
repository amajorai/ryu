// Node selector proof: connected clients, mesh peers, engines, the sandbox
// lifecycle and cloud suggestions across the compact menu and computer dialog.

import { expect, test } from "@playwright/test";
import {
	evidence,
	type NodeSelectorWindow,
	openCompactMenu,
	openSelector,
	readSnapshot,
	readState,
} from "./node-selector-proof.helpers.ts";

test.describe.configure({ timeout: 120_000 });

test("shows connected clients, mesh peers, engines, sandbox lifecycle and cloud suggestions across the compact menu and computer dialog", async ({
	page,
}) => {
	await openSelector(page, "compact", "mesh=on");
	let { menu } = await openCompactMenu(page);
	await menu
		.getByRole("menuitem", { name: /Engines, voice, toolkits/ })
		.click();
	await expect(page.getByRole("dialog", { name: "Computer" })).toBeVisible();
	let dialog = page.getByRole("dialog");
	await dialog.getByRole("button", { name: /^Network & devices/ }).click();
	await expect(
		dialog.getByText("Connected · 1", { exact: true })
	).toBeVisible();
	await expect(dialog.getByText(/Fixture CLI/)).toBeVisible();
	expect(
		(await readSnapshot(page)).apiCalls.some(
			(call) =>
				call.path === "/api/connections" &&
				call.method === "GET" &&
				call.status === 200
		)
	).toBe(true);
	await expect(dialog.getByText("Network", { exact: true })).toBeVisible();
	await expect(dialog.getByText("needs token", { exact: true })).toBeVisible();
	await expect(dialog.getByRole("button", { name: /needs-token/ })).toHaveCount(
		0
	);
	await dialog
		.getByText("Connected · 1", { exact: true })
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("desktop-node-selector-connected-menu.png"),
	});

	await page.evaluate(() =>
		/* SAFETY: node-selector-proof.mock.ts installs __NODE_SELECTOR_PROOF__ before this proof page is evaluated. */ (
			window as unknown as NodeSelectorWindow
		).__NODE_SELECTOR_PROOF__.armNativeFailure("add_node")
	);
	await dialog.getByRole("button", { name: "mesh-peer" }).click();
	await expect
		.poll(
			async () =>
				(await readSnapshot(page)).nativeCalls.filter(
					(call) => call.command === "add_node"
				).length
		)
		.toBe(1);
	expect(
		(await readSnapshot(page)).nativeCalls.filter(
			(call) => call.command === "add_node"
		)[0]
	).toMatchObject({
		command: "add_node",
		result: "failed",
	});
	await expect(dialog.getByRole("button", { name: "mesh-peer" })).toBeVisible();
	await dialog.getByRole("button", { name: "mesh-peer" }).click();
	await expect
		.poll(
			async () =>
				(await readSnapshot(page)).nativeCalls.filter(
					(call) => call.command === "add_node"
				).length
		)
		.toBe(2);
	let state = await readSnapshot(page);
	const addedNodes = state.nativeCalls.filter(
		(call) => call.command === "add_node"
	);
	expect(addedNodes[0]).toEqual({
		args: {
			name: "mesh-mesh-peer",
			token: "mesh-fixture-token",
			url: "http://mesh-peer.fixture.ts.net:7980",
		},
		command: "add_node",
		result: "failed",
	});
	expect(addedNodes[1]).toEqual({
		args: {
			name: "mesh-mesh-peer",
			token: "mesh-fixture-token",
			url: "http://mesh-peer.fixture.ts.net:7980",
		},
		command: "add_node",
		result: "ok",
	});

	// Engines open as their own page — Chat is listed there, not folded away.
	await dialog.getByRole("button", { name: "Back to Computer" }).click();
	await dialog.getByRole("button", { name: /^Engines & models/ }).click();
	await expect(dialog.getByRole("button", { name: /^Chat\b/ })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();

	// Cloud suggestions stay in the compact menu, next to the computer list.
	({ menu } = await openCompactMenu(page));
	const suggestedRow = page
		.locator('[title="https://suggested.fixture:7980"]')
		.locator("..");
	await expect(suggestedRow).toContainText("Suggested");
	await page.evaluate(() =>
		/* SAFETY: node-selector-proof.mock.ts installs __NODE_SELECTOR_PROOF__ before this proof page is evaluated. */ (
			window as unknown as NodeSelectorWindow
		).__NODE_SELECTOR_PROOF__.armNativeFailure("add_node")
	);
	await suggestedRow.getByRole("button", { name: "Add" }).click();
	await expect(page.getByText("Couldn't add cloud computer")).toBeVisible();
	await expect(suggestedRow.getByRole("button", { name: "Add" })).toBeEnabled();
	await suggestedRow.getByRole("button", { name: "Add" }).click();
	await expect
		.poll(async () =>
			(await readState(page)).localNodes.some(
				(node) => node.name === "cloud-suggested"
			)
		)
		.toBe(true);
	state = await readSnapshot(page);
	expect(
		state.nativeCalls.filter((call) => call.command === "add_node")
	).toEqual([
		{
			args: {
				name: "mesh-mesh-peer",
				token: "mesh-fixture-token",
				url: "http://mesh-peer.fixture.ts.net:7980",
			},
			command: "add_node",
			result: "failed",
		},
		{
			args: {
				name: "mesh-mesh-peer",
				token: "mesh-fixture-token",
				url: "http://mesh-peer.fixture.ts.net:7980",
			},
			command: "add_node",
			result: "ok",
		},
		{
			args: {
				name: "cloud-suggested",
				token: null,
				url: "https://suggested.fixture:7980",
			},
			command: "add_node",
			result: "failed",
		},
		{
			args: {
				name: "cloud-suggested",
				token: null,
				url: "https://suggested.fixture:7980",
			},
			command: "add_node",
			result: "ok",
		},
	]);
	const dismissedRow = page
		.locator('[title="https://dismissed.fixture:7980"]')
		.locator("..");
	await dismissedRow.getByRole("button", { name: "Dismiss Dismissed" }).click();
	await expect(dismissedRow).toHaveCount(0);
	expect(
		await page.evaluate(() => localStorage.getItem("ryu:node-dismissed-cloud"))
	).toContain("https://dismissed.fixture:7980");
	state = await readSnapshot(page);
	expect(
		state.nativeCalls.filter((call) => call.command === "add_node")
	).toHaveLength(4);
	await page.reload();
	({ menu } = await openCompactMenu(page));
	await expect(
		menu.getByRole("menuitem", { name: /suggested/i })
	).toBeVisible();
	await expect(
		menu.getByText("Available in your workspace", { exact: true })
	).toHaveCount(0);

	await menu
		.getByRole("menuitem", { name: /Engines, voice, toolkits/ })
		.click();
	dialog = page.getByRole("dialog");
	await dialog.getByRole("button", { name: /^Voice & sandbox/ }).click();
	const newSandbox = dialog.getByRole("button", { name: "New sandbox" });
	await expect(newSandbox).toBeVisible();
	await page.evaluate(() =>
		/* SAFETY: node-selector-proof.mock.ts installs __NODE_SELECTOR_PROOF__ before this proof page is evaluated. */ (
			window as unknown as NodeSelectorWindow
		).__NODE_SELECTOR_PROOF__.armApiFailure("POST", "/api/sandboxes")
	);
	await newSandbox.click();
	// Raised from inside the modal dialog, the error toast must still reach the
	// accessibility tree (the toaster anchor is a live region the modal spares)
	// and stay visible over the dialog the error is about. While a dialog is
	// open the shared toaster goes click-through on purpose
	// (packages/ui/src/styles/globals/base.css), so taps meant for the dialog
	// are never taken by a toast and the dialog stays open under it.
	const sandboxError = page.getByRole("button", {
		name: "/api/sandboxes failed: 503",
	});
	await expect(sandboxError).toBeVisible();
	await expect(sandboxError).toHaveCSS("pointer-events", "none");
	await expect(dialog).toBeVisible();
	await expect(newSandbox).toBeVisible();
	await expect(newSandbox).toBeEnabled();
	await newSandbox.click();
	await expect
		.poll(
			async () =>
				(await readSnapshot(page)).apiCalls.filter(
					(call) => call.path === "/api/sandboxes" && call.method === "POST"
				).length
		)
		.toBe(2);
	const postSandbox = (await readSnapshot(page)).apiCalls.find(
		(call) => call.path === "/api/sandboxes" && call.method === "POST"
	);
	expect(postSandbox).toMatchObject({ body: {}, method: "POST", status: 503 });
	const sandboxPosts = (await readSnapshot(page)).apiCalls.filter(
		(call) => call.path === "/api/sandboxes" && call.method === "POST"
	);
	expect(sandboxPosts.map((call) => call.status)).toEqual([503, 200]);
	expect(sandboxPosts[1]).toMatchObject({
		body: {},
		method: "POST",
		status: 200,
		url: "http://127.0.0.1:7980",
	});
	const stops = dialog.getByRole("button", { name: "Stop" });
	await expect(stops.first()).toBeVisible();
	const runningSandbox = dialog
		.getByText("0:18", { exact: true })
		.locator("..");
	await page.evaluate(() =>
		/* SAFETY: node-selector-proof.mock.ts installs __NODE_SELECTOR_PROOF__ before this proof page is evaluated. */ (
			window as unknown as NodeSelectorWindow
		).__NODE_SELECTOR_PROOF__.armApiFailure(
			"DELETE",
			"/api/sandboxes/sandbox-running"
		)
	);
	await runningSandbox.getByRole("button", { name: "Stop" }).click();
	await expect(
		runningSandbox.getByRole("button", { name: "Stop" })
	).toBeEnabled();
	await expect(runningSandbox).toBeVisible();
	await runningSandbox.getByRole("button", { name: "Stop" }).click();
	await expect
		.poll(
			async () =>
				(await readSnapshot(page)).apiCalls.filter(
					(call) =>
						call.path === "/api/sandboxes/sandbox-running" &&
						call.method === "DELETE"
				).length
		)
		.toBe(2);
	expect(
		(await readSnapshot(page)).apiCalls
			.filter(
				(call) =>
					call.path === "/api/sandboxes/sandbox-running" &&
					call.method === "DELETE"
			)
			.map((call) => call.status)
	).toEqual([503, 200]);
	await expect(runningSandbox).toHaveCount(0);
});
