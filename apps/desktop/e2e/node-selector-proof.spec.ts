// Node selector proof: Decision Models, node selection and failover, adding
// nodes, and sharing a node.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { buildRyuDeepLink, parseRyuDeepLink } from "@ryuhq/protocol/deep-link";
import {
	decisionModelsEvidence,
	evidence,
	type NodeSelectorWindow,
	openCompactMenu,
	openEnginesPage,
	openSelector,
	readSnapshot,
	readState,
} from "./node-selector-proof.helpers.ts";

test.describe.configure({ timeout: 120_000 });

test("enables Ollaya and routes the stable Decision Models layer to it", async ({
	page,
}) => {
	await openSelector(page, "compact", "decisionModels=true");
	const dialog = await openEnginesPage(page);
	const typedDecisions = dialog.getByRole("button", {
		name: /Typed Decisions/,
	});
	await expect(typedDecisions).toBeVisible();
	await typedDecisions.click();
	const ollaya = dialog.getByRole("button", {
		name: /Ollaya Decision Models/,
	});
	await expect(ollaya.first()).toBeVisible();
	await ollaya.first().click();

	await expect(
		page.getByText("Pinned · 2 providers enabled", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Ollaya Decision Models", { exact: true }).last()
	).toBeVisible();

	const snapshot = await readSnapshot(page);
	expect(
		snapshot.apiCalls.some(
			(call) =>
				call.method === "POST" &&
				call.path === "/api/plugins/%40ryu%2Follaya/enable" &&
				call.status === 200
		)
	).toBe(true);
	expect(
		snapshot.apiCalls.some(
			(call) =>
				call.method === "PUT" &&
				call.path === "/api/capabilities/bindings" &&
				call.status === 200
		)
	).toBe(true);

	const screenshotPath = decisionModelsEvidence(
		"decision-models-node-selector.png"
	);
	await mkdir(path.dirname(screenshotPath), { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath,
	});
});

test("keeps Decision Models keyboard-usable in narrow light RTL layout with reduced motion", async ({
	page,
}) => {
	await page.setViewportSize({ height: 844, width: 390 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await openSelector(page, "compact", "decisionModels=true");
	await page.evaluate(() => localStorage.setItem("theme", "light"));
	await page.reload();
	await expect(
		page.getByRole("heading", { name: "Node selector", exact: true })
	).toBeVisible();
	await page.evaluate(() => {
		document.documentElement.dir = "rtl";
	});
	await expect(page.locator("html")).toHaveClass(/light/);

	const trigger = page
		.getByTestId("node-selector-surface")
		.getByRole("button")
		.first();
	await trigger.focus();
	await page.keyboard.press("Enter");
	const expand = page.getByRole("menuitem", {
		name: /Engines, voice, toolkits/,
	});
	await expect(expand).toBeVisible();
	await expand.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("dialog", { name: "Computer" })).toBeVisible();
	const dialog = page.getByRole("dialog");
	const engines = dialog.getByRole("button", { name: /^Engines & models/ });
	await engines.focus();
	await page.keyboard.press("Enter");
	// A push hides the page that held focus, so focus must move to the new
	// page's back button rather than vanish with the hidden row.
	const back = dialog.getByRole("button", { name: "Back to Computer" });
	await expect(back).toBeFocused();
	await page.keyboard.press("Enter");
	// …and a pop hands it back to the row that opened the page.
	await expect(engines).toBeFocused();
	await page.keyboard.press("Enter");
	const typedDecisions = dialog.getByRole("button", {
		name: /Typed Decisions/,
	});
	await expect(typedDecisions).toBeVisible();
	await typedDecisions.focus();
	await page.keyboard.press("Enter");
	const ollaya = dialog.getByRole("button", {
		name: /Ollaya Decision Models/,
	});
	await expect(ollaya.first()).toBeVisible();
	const bounds = await dialog.evaluate((element) => {
		const rect = element.getBoundingClientRect();
		return {
			bottom: rect.bottom,
			left: rect.left,
			right: rect.right,
			top: rect.top,
		};
	});
	expect(bounds.left).toBeGreaterThanOrEqual(0);
	expect(bounds.top).toBeGreaterThanOrEqual(0);
	expect(bounds.right).toBeLessThanOrEqual(390);
	expect(bounds.bottom).toBeLessThanOrEqual(844);

	const screenshotPath = decisionModelsEvidence(
		"decision-models-node-selector-light-rtl-mobile.png"
	);
	await mkdir(path.dirname(screenshotPath), { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath,
	});
});

test("shows the provider-enable error instead of treating Ollaya as available", async ({
	page,
}) => {
	await openSelector(page, "compact", "decisionModels=true");
	const dialog = await openEnginesPage(page);
	await dialog.getByRole("button", { name: /Typed Decisions/ }).click();
	await page.evaluate(() =>
		/* SAFETY: node-selector-proof.mock.ts installs __NODE_SELECTOR_PROOF__ before this proof page is evaluated. */ (
			window as unknown as NodeSelectorWindow
		).__NODE_SELECTOR_PROOF__.armApiFailure(
			"POST",
			"/api/plugins/%40ryu%2Follaya/enable"
		)
	);
	await dialog.getByRole("button", { name: /Ollaya Decision Models/ }).click();
	await expect(
		page.getByText("Gateway unreachable (fail-closed)", { exact: false })
	).toBeVisible();
	const snapshot = await readSnapshot(page);
	expect(
		snapshot.apiCalls.some(
			(call) =>
				call.method === "POST" &&
				call.path === "/api/plugins/%40ryu%2Follaya/enable" &&
				call.status === 503
		)
	).toBe(true);
	await expect(
		dialog.getByRole("button", { name: /Laya Local Decisions default/ })
	).toBeVisible();
	await expect(
		dialog.getByRole("button", {
			name: /Ollaya Decision Models not enabled/,
		})
	).toBeVisible();
});

test("selects and persists a remote node, shows offline health, recovers, and applies auto-select failover", async ({
	page,
}) => {
	await openSelector(page);
	let { menu, trigger } = await openCompactMenu(page);
	await menu.getByRole("menuitem", { name: /Lan-box/ }).click();
	await expect(trigger).toContainText("Lan-box");
	await expect(trigger.locator('[data-slot="node-status-dot"]')).toHaveClass(
		/bg-success/
	);
	expect((await readState(page)).defaultNode).toBe("lan-box");
	expect(
		(await readSnapshot(page)).nativeCalls.filter(
			(call) => call.command === "set_default_node"
		)
	).toEqual([
		{ args: { name: "lan-box" }, command: "set_default_node", result: "ok" },
	]);
	await expect(page.getByRole("menu")).toBeHidden();
	await page.reload();
	trigger = page.getByRole("button", { name: /Lan-box/ }).first();
	await expect(trigger).toBeVisible();
	expect((await readState(page)).defaultNode).toBe("lan-box");

	await page.evaluate(() =>
		/* SAFETY: node-selector-proof.mock.ts installs __NODE_SELECTOR_PROOF__ before this proof page is evaluated. */ (
			window as unknown as NodeSelectorWindow
		).__NODE_SELECTOR_PROOF__.setNodeOnline("lan-box", false)
	);
	await expect(trigger.locator('[data-slot="node-status-dot"]')).toHaveClass(
		/bg-destructive/,
		{ timeout: 12_000 }
	);
	await page.evaluate(() =>
		/* SAFETY: node-selector-proof.mock.ts installs __NODE_SELECTOR_PROOF__ before this proof page is evaluated. */ (
			window as unknown as NodeSelectorWindow
		).__NODE_SELECTOR_PROOF__.setNodeOnline("lan-box", true)
	);
	await expect(trigger.locator('[data-slot="node-status-dot"]')).toHaveClass(
		/bg-success/,
		{ timeout: 12_000 }
	);

	({ menu } = await openCompactMenu(page, /Lan-box/i));
	const autoSelect = menu.getByRole("switch", {
		name: "Prefer a reachable remote computer, else use your computer",
	});
	await expect(autoSelect).not.toBeChecked();
	await autoSelect.click();
	await expect(autoSelect).toBeChecked();
	await expect(menu.getByText("Using Lan-box", { exact: true })).toBeVisible();

	await page.evaluate(() => {
		const state =
			/* SAFETY: node-selector-proof.mock.ts installs __NODE_SELECTOR_PROOF__ before this proof page is evaluated. */ (
				window as unknown as NodeSelectorWindow
			).__NODE_SELECTOR_PROOF__;
		state.setNodeOnline("lan-box", false);
		state.setNodeOnline("cloud-managed", false);
		state.setNodeOnline("cloud-suggested", false);
		state.setNodeOnline("cloud-dismissed", false);
	});
	await autoSelect.click();
	await expect(autoSelect).not.toBeChecked();
	await autoSelect.click();
	await expect(
		menu.getByText("No remote computer reachable — using your computer", {
			exact: true,
		})
	).toBeVisible();
	expect((await readState(page)).autoSelectedNode).toBe("local");

	await page.evaluate(() =>
		/* SAFETY: node-selector-proof.mock.ts installs __NODE_SELECTOR_PROOF__ before this proof page is evaluated. */ (
			window as unknown as NodeSelectorWindow
		).__NODE_SELECTOR_PROOF__.setNodeOnline("lan-box", true)
	);
	await autoSelect.click();
	await expect(autoSelect).not.toBeChecked();
	await autoSelect.click();
	await expect(menu.getByText("Using Lan-box", { exact: true })).toBeVisible();
	const state = await readState(page);
	expect(state.autoSelect).toBe(true);
	expect(state.autoSelectedNode).toBe("lan-box");
	expect(
		(await readSnapshot(page)).apiCalls.some(
			(call) =>
				call.method === "GET" &&
				call.path === "/api/health" &&
				call.url === "http://lan.fixture:7980" &&
				call.status === 200
		)
	).toBe(true);
	expect(
		await page.evaluate(() => localStorage.getItem("ryu:node-auto-select"))
	).toBe("true");
	await page.reload();
	await expect
		.poll(async () => (await readState(page)).autoSelectedNode)
		.toBe("lan-box");
	({ menu } = await openCompactMenu(page, /Lan-box/));
	const persistedAutoSelect = menu.getByRole("switch", {
		name: "Prefer a reachable remote computer, else use your computer",
	});
	await expect(persistedAutoSelect).toBeChecked();
	await expect(menu.getByText("Using Lan-box", { exact: true })).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("desktop-node-selector-auto-select.png"),
	});
});

test("validates connection strings and manual node fields, retries native add, and adds a discovered LAN node", async ({
	page,
}) => {
	await openSelector(page);
	let { menu } = await openCompactMenu(page);
	await menu.getByRole("menuitem", { name: "Add computer" }).click();
	let dialog = page.getByRole("dialog", { name: "Add computer" });
	await expect(dialog).toBeVisible();
	const addButton = dialog.getByRole("button", {
		name: "Add computer",
		exact: true,
	});
	await expect(addButton).toBeDisabled();
	await dialog
		.getByLabel("Connection string")
		.fill("https://untrusted.example/connect");
	await expect(
		dialog.getByText("That doesn't look like a Ryu connection string")
	).toBeVisible();
	await expect(addButton).toBeDisabled();

	const connectLink = buildRyuDeepLink({
		kind: "node",
		name: "Pasted node",
		url: "http://paste.fixture:7980",
		token: "pasted-fixture-token",
	});
	await dialog.getByLabel("Connection string").fill(connectLink);
	await expect(dialog.getByLabel("Name")).toHaveValue("Pasted node");
	await expect(dialog.getByLabel("URL")).toHaveValue(
		"http://paste.fixture:7980"
	);
	await expect(dialog.getByLabel("Token")).toHaveValue("pasted-fixture-token");
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("desktop-node-selector-add-node-prefill.png"),
	});
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toBeHidden();
	const native = (await readSnapshot(page)).nativeCalls;
	expect(native.filter((call) => call.command === "add_node")).toEqual([]);
	({ menu } = await openCompactMenu(page));
	await menu.getByRole("menuitem", { name: "Add computer" }).click();
	dialog = page.getByRole("dialog", { name: "Add computer" });
	await expect(dialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();

	({ menu } = await openCompactMenu(page));
	await menu.getByRole("menuitem", { name: "Add computer" }).click();
	dialog = page.getByRole("dialog", { name: "Add computer" });
	await dialog.getByLabel("Name").fill("  Manual fixture node  ");
	await dialog.getByLabel("URL").fill("ftp://manual.fixture:7980");
	await dialog.getByLabel("Token").fill("  manual-token  ");
	await addButton.waitFor({ state: "visible" });
	await dialog
		.getByRole("button", { name: "Add computer", exact: true })
		.click();
	await expect(
		dialog.getByText("Node URL must use http or https")
	).toBeVisible();
	await expect(dialog.getByLabel("Name")).toHaveValue(
		"  Manual fixture node  "
	);
	await dialog.getByLabel("URL").fill(" https://manual.fixture:7980 ");
	await page.evaluate(() =>
		/* SAFETY: node-selector-proof.mock.ts installs __NODE_SELECTOR_PROOF__ before this proof page is evaluated. */ (
			window as unknown as NodeSelectorWindow
		).__NODE_SELECTOR_PROOF__.armNativeFailure("add_node")
	);
	await dialog
		.getByRole("button", { name: "Add computer", exact: true })
		.click();
	await expect(dialog.getByText("fixture refused add_node")).toBeVisible();
	await expect(dialog.getByLabel("Token")).toHaveValue("  manual-token  ");
	await dialog
		.getByRole("button", { name: "Add computer", exact: true })
		.click();
	await expect(dialog).toBeHidden();

	let state = await readSnapshot(page);
	const manualCalls = state.nativeCalls.filter(
		(call) => call.command === "add_node"
	);
	expect(manualCalls).toEqual([
		{
			args: {
				name: "Manual fixture node",
				token: "manual-token",
				url: "ftp://manual.fixture:7980",
			},
			command: "add_node",
			result: "failed",
		},
		{
			args: {
				name: "Manual fixture node",
				token: "manual-token",
				url: "https://manual.fixture:7980",
			},
			command: "add_node",
			result: "failed",
		},
		{
			args: {
				name: "Manual fixture node",
				token: "manual-token",
				url: "https://manual.fixture:7980",
			},
			command: "add_node",
			result: "ok",
		},
	]);
	expect(state.nodes.some((node) => node.name === "Manual fixture node")).toBe(
		true
	);

	await page.reload();
	({ menu } = await openCompactMenu(page));
	await expect(
		menu.getByRole("menuitem", { name: /Manual fixture node/ })
	).toBeVisible();
	await menu.getByRole("menuitem", { name: "Add computer" }).click();
	dialog = page.getByRole("dialog", { name: "Add computer" });
	await dialog.getByRole("button", { name: "Scan local network" }).click();
	await expect(
		dialog.getByRole("button", { name: /10\.10\.0\.8:7980/ })
	).toBeVisible();
	await expect(
		dialog.getByText("192.168.1.44:7980", { exact: true })
	).toHaveCount(0);
	await dialog.getByRole("button", { name: /10\.10\.0\.8:7980/ }).click();
	await expect(
		dialog.getByRole("button", { name: /10\.10\.0\.8:7980/ })
	).toHaveCount(0);
	state = await readSnapshot(page);
	expect(state.nativeCalls).toContainEqual({
		args: {
			name: "node-10-10-0-8-canary",
			token: null,
			url: "http://10.10.0.8:7980",
		},
		command: "add_node",
		result: "ok",
	});
	expect(state.nativeCalls).toContainEqual({
		args: null,
		command: "discover_lan_nodes",
		result: "ok",
	});
	await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("shares a node with a safe editable address and copies only through the clipboard fixture", async ({
	page,
}) => {
	await openSelector(page, "compact", "mesh=off");
	let { menu } = await openCompactMenu(page);
	await menu.getByRole("button", { name: "Share Your computer" }).click();
	const dialog = page.getByRole("dialog", {
		name: /Connect a computer to Your computer/,
	});
	await expect(dialog).toBeVisible();
	await expect(
		dialog.getByText(/Other devices can't reach a localhost address/)
	).toBeVisible();
	await dialog.getByRole("button", { name: "Show" }).click();
	await expect(
		dialog.getByText("local-node-selector-token", { exact: true })
	).toBeVisible();
	await dialog.getByRole("button", { name: "Hide" }).click();
	const address = "http://192.168.1.50:7980";
	await dialog.getByLabel("Shareable address").fill(address);
	await expect(
		dialog.getByText(/Other devices can't reach a localhost address/)
	).toHaveCount(0);
	const link = await dialog.getByLabel("Connect link").inputValue();
	expect(parseRyuDeepLink(link)).toMatchObject({
		kind: "node",
		name: "local",
		token: "local-node-selector-token",
		url: address,
	});
	await page.evaluate(() =>
		/* SAFETY: node-selector-proof.mock.ts installs __NODE_SELECTOR_PROOF__ before this proof page is evaluated. */ (
			window as unknown as NodeSelectorWindow
		).__NODE_SELECTOR_PROOF__.armClipboardFailure()
	);
	await dialog.getByRole("button", { name: "Copy" }).click();
	await expect(page.getByText("Could not copy to clipboard")).toBeVisible();
	await dialog.getByRole("button", { name: "Copy" }).click();
	await expect(page.getByText("Connect link copied")).toBeVisible();
	expect((await readSnapshot(page)).clipboardWrites).toEqual([link]);
	expect((await readSnapshot(page)).defaultNode).toBe("local");
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("desktop-node-selector-share-link.png"),
	});
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(dialog).toBeHidden();
	({ menu } = await openCompactMenu(page));
	await menu.getByRole("button", { name: "Share Your computer" }).click();
	const reopened = page.getByRole("dialog", {
		name: /Connect a computer to Your computer/,
	});
	await expect(reopened).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(reopened).toBeHidden();
});
