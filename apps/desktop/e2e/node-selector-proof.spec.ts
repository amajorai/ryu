import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { buildRyuDeepLink, parseRyuDeepLink } from "@ryuhq/protocol/deep-link";
import type {
	NodeSelectorApiCall,
	NodeSelectorNativeCall,
} from "./harness/node-selector-proof.mock.ts";

interface NodeRow {
	managed?: boolean;
	name: string;
	orgId?: string | null;
	token: string | null;
	url: string;
	userJwt?: string | null;
}

interface NodeSelectorSnapshot {
	apiCalls: NodeSelectorApiCall[];
	clipboardWrites: string[];
	defaultNode: string;
	externalUrls: string[];
	nativeCalls: NodeSelectorNativeCall[];
	nodes: NodeRow[];
}

// The harness mock types the global `__NODE_SELECTOR_PROOF__` as its full
// state; this spec reads only the API below, so it narrows that one property.
interface NodeSelectorWindow extends Omit<Window, "__NODE_SELECTOR_PROOF__"> {
	__CLOSE_NODE_SELECTOR_SETTINGS__: () => void;
	__NODE_SELECTOR_PROOF__: {
		armApiFailure: (method: string, path: string, status?: number) => void;
		armClipboardFailure: () => void;
		armNativeFailure: (command: string) => void;
		setNodeOnline: (name: string, online: boolean) => void;
		snapshot: () => NodeSelectorSnapshot;
	};
	__READ_NODE_SELECTOR_STATE__: () => {
		autoSelect: boolean;
		autoSelectedNode: string | null;
		defaultNode: string;
		gateway: { open: boolean; section: string };
		localNodes: NodeRow[];
		nodes: NodeRow[];
		settings: { open: boolean; section: string };
		suggestedCloudNodes: Array<{ name: string; url: string }>;
	};
}

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
const evidenceOverride = process.env.RYU_PROOF_EVIDENCE_DIR;
const evidence = (name: string) =>
	evidenceOverride
		? path.join(evidenceOverride, name)
		: path.resolve(
				import.meta.dirname,
				"../../../docs/proof/test-coverage-sweep-20260924/evidence",
				name
			);
const decisionModelsEvidence = (name: string) =>
	evidenceOverride
		? path.join(evidenceOverride, "decision-models-20260929", name)
		: path.resolve(
				import.meta.dirname,
				"../../../docs/proof/decision-models-20260929",
				name
			);

async function openSelector(
	page: Page,
	mode: "compact" | "persistent" = "compact",
	query = ""
): Promise<void> {
	const params = new URLSearchParams({ mode, reset: "true" });
	if (query) {
		for (const [key, value] of new URLSearchParams(query)) {
			params.set(key, value);
		}
	}
	await page.goto(`/node-selector-proof.html?${params.toString()}`);
	await expect(
		page.getByRole("heading", { name: "Node selector", exact: true })
	).toBeVisible();
}

async function readSnapshot(page: Page): Promise<NodeSelectorSnapshot> {
	return await page.evaluate(() =>
		/* SAFETY: node-selector-proof.mock.ts installs __NODE_SELECTOR_PROOF__ before this proof page is evaluated. */ (
			window as unknown as NodeSelectorWindow
		).__NODE_SELECTOR_PROOF__.snapshot()
	);
}

async function readState(page: Page) {
	return await page.evaluate(() =>
		/* SAFETY: node-selector-proof.tsx installs __READ_NODE_SELECTOR_STATE__ before this proof page is evaluated. */ (
			window as unknown as NodeSelectorWindow
		).__READ_NODE_SELECTOR_STATE__()
	);
}

async function openCompactMenu(
	page: Page,
	name: RegExp | string = "Your computer"
) {
	const trigger = page
		.getByTestId("node-selector-surface")
		.getByRole("button")
		.first();
	await expect(trigger).toContainText(name);
	await trigger.click();
	const menu = page.getByRole("menu");
	await expect(menu).toBeVisible();
	return { menu, trigger };
}

/** Open the expanded computer dialog from the compact menu and go to its
 *  Engines & models page. The dialog's title follows the page stack, so it is
 *  returned by role alone. */
async function openEnginesPage(page: Page) {
	const { menu } = await openCompactMenu(page);
	await menu
		.getByRole("menuitem", { name: /Engines, voice, toolkits/ })
		.click();
	await expect(page.getByRole("dialog", { name: "Computer" })).toBeVisible();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("button", { name: /^Engines & models/ }).click();
	await expect(
		dialog.getByRole("heading", { name: "Decision Models", exact: true })
	).toBeVisible();
	return dialog;
}

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

test("proves the uncalled persistent-sidebar item branch directly: select, stats tooltips, hardware dependencies, share and confirmed remove", async ({
	page,
}) => {
	await openSelector(page, "persistent");
	const remoteName = page.getByText("Lan-box", { exact: true });
	await remoteName.click();
	await expect
		.poll(async () => (await readState(page)).defaultNode)
		.toBe("lan-box");
	const row = remoteName.locator(
		"xpath=ancestor::div[contains(@class,'group')][1]"
	);
	await row.hover();
	const specs = row.getByText("8 cores · A10G", { exact: true });
	await expect(specs).toBeVisible();
	await specs.hover();
	await expect(
		page.getByText("Node selector fixture CPU", { exact: true }).last()
	).toBeVisible();
	await row.getByText("GPU", { exact: true }).hover();
	await expect(
		page.getByText("NVIDIA A10G", { exact: true }).last()
	).toBeVisible();
	const cloudName = page.getByText("Cloud-managed", { exact: true }).first();
	const cloudRow = cloudName.locator(
		"xpath=ancestor::div[contains(@class,'group')][1]"
	);
	await cloudRow.getByText("Cloud Computers", { exact: true }).hover();
	await expect(
		page
			.getByText("Cloud Computers · Fixture workspace", { exact: true })
			.last()
	).toBeVisible();

	await page
		.getByRole("button", { exact: true, name: "Hardware for Lan-box" })
		.click();
	const hardware = page.getByRole("dialog", { name: /Hardware/ });
	await expect(hardware).toBeVisible();
	await expect(hardware.getByText("Node selector fixture CPU")).toBeVisible();
	await expect(
		hardware.getByText("Dependencies", { exact: true })
	).toBeVisible();
	await expect(
		hardware.getByRole("button", { name: "Install 1 missing" })
	).toBeVisible();
	await page.evaluate(() =>
		/* SAFETY: node-selector-proof.mock.ts installs __NODE_SELECTOR_PROOF__ before this proof page is evaluated. */ (
			window as unknown as NodeSelectorWindow
		).__NODE_SELECTOR_PROOF__.armApiFailure("POST", "/api/dependencies/install")
	);
	await hardware.getByRole("button", { name: "Install 1 missing" }).click();
	await expect(page.getByText("deps install failed: 503")).toBeVisible();
	await expect(
		hardware.getByRole("button", { name: "Install 1 missing" })
	).toBeEnabled();
	await hardware.getByRole("button", { name: "Install 1 missing" }).click();
	await expect(
		hardware.getByRole("button", { name: /Install .* missing/ })
	).toHaveCount(0);
	const dependencyCalls = (await readSnapshot(page)).apiCalls.filter(
		(call) => call.path === "/api/dependencies/install"
	);
	expect(
		dependencyCalls.map((call) => ({
			method: call.method,
			status: call.status,
		}))
	).toEqual([
		{ method: "POST", status: 503 },
		{ method: "POST", status: 200 },
	]);
	await hardware.getByRole("button", { name: "Close" }).click();
	await expect(hardware).toBeHidden();

	await row.getByRole("button", { name: "Share Lan-box" }).click();
	const share = page.getByRole("dialog", {
		name: /Connect a computer to Lan-box/,
	});
	await expect(share).toBeVisible();
	await share.getByRole("button", { name: "Done" }).click();
	await expect(share).toBeHidden();

	await row.getByRole("button", { name: "Remove Lan-box" }).click();
	const confirmRemove = page.getByRole("alertdialog", {
		name: "Remove Lan-box?",
	});
	await expect(confirmRemove).toBeVisible();
	await confirmRemove.getByRole("button", { name: "Cancel" }).click();
	await expect(confirmRemove).toBeHidden();
	await expect(page.getByText("Lan-box", { exact: true })).toBeVisible();
	expect(
		(await readSnapshot(page)).nativeCalls.filter(
			(call) => call.command === "remove_node"
		)
	).toEqual([]);
	await row.hover();
	await row.getByRole("button", { name: "Remove Lan-box" }).click();
	await confirmRemove.getByRole("button", { name: "Remove computer" }).click();
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	await expect(page.getByText("Lan-box", { exact: true })).toHaveCount(0);
	const state = await readSnapshot(page);
	expect(
		state.nativeCalls.filter((call) => call.command === "remove_node")
	).toEqual([
		{ args: { name: "lan-box" }, command: "remove_node", result: "ok" },
	]);
	await page.getByRole("button", { name: "Add computer" }).click();
	const addDialog = page.getByRole("dialog", { name: "Add computer" });
	await expect(addDialog).toBeVisible();
	await addDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(addDialog).toBeHidden();
	await page.getByRole("button", { name: "Manage cloud computers" }).click();
	const finalState = await readSnapshot(page);
	expect(finalState.externalUrls).toHaveLength(1);
	expect(finalState.externalUrls[0]).toMatch(/\/organizations$/);
	expect(
		finalState.nativeCalls.filter((call) => call.command === "open_external")
	).toEqual([
		{
			args: { url: finalState.externalUrls[0] },
			command: "open_external",
			result: "ok",
		},
	]);
});

test("uses the reachable compact menu to inspect hardware, recover dependencies, and close the dialog", async ({
	page,
}) => {
	await openSelector(page, "compact", "active=lan");
	const { menu } = await openCompactMenu(page, /Lan-box/);
	const specs = menu.getByText("8 cores · A10G", { exact: true });
	await expect(specs).toBeVisible();
	await specs.hover();
	await expect(
		page.getByText("Node selector fixture CPU", { exact: true }).last()
	).toBeVisible();
	await menu.getByRole("menuitem", { name: "Hardware" }).click();
	const hardware = page.getByRole("dialog", { name: /Hardware · Lan-box/ });
	await expect(hardware).toBeVisible();
	await expect(
		hardware.getByText("selector-fixture", { exact: true })
	).toBeVisible();
	await expect(
		hardware.getByText("NVIDIA A10G", { exact: true })
	).toBeVisible();
	await expect(
		hardware.getByRole("button", { name: "Install 1 missing" })
	).toBeVisible();
	expect(
		(await readSnapshot(page)).apiCalls.filter(
			(call) =>
				call.path === "/api/system/info" &&
				call.method === "GET" &&
				call.url === "http://lan.fixture:7980"
		).length
	).toBeGreaterThan(0);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("desktop-node-selector-hardware.png"),
	});
	await page.evaluate(() =>
		/* SAFETY: node-selector-proof.mock.ts installs __NODE_SELECTOR_PROOF__ before this proof page is evaluated. */ (
			window as unknown as NodeSelectorWindow
		).__NODE_SELECTOR_PROOF__.armApiFailure("POST", "/api/dependencies/install")
	);
	await hardware.getByRole("button", { name: "Install 1 missing" }).click();
	await expect(page.getByText("deps install failed: 503")).toBeVisible();
	await expect(
		hardware.getByRole("button", { name: "Install 1 missing" })
	).toBeEnabled();
	await hardware.getByRole("button", { name: "Install 1 missing" }).click();
	await expect(
		hardware.getByRole("button", { name: /Install .* missing/ })
	).toHaveCount(0);
	expect(
		(await readSnapshot(page)).apiCalls
			.filter((call) => call.path === "/api/dependencies/install")
			.map((call) => ({ method: call.method, status: call.status }))
	).toEqual([
		{ method: "POST", status: 503 },
		{ method: "POST", status: 200 },
	]);
	await page.keyboard.press("Escape");
	await expect(hardware).toBeHidden();
});

test("recovers a failed compact hardware read when the user reopens Hardware", async ({
	page,
}) => {
	await openSelector(page, "compact", "active=lan");
	await page.evaluate(() => {
		const state =
			/* SAFETY: node-selector-proof.mock.ts installs __NODE_SELECTOR_PROOF__ before this proof page is evaluated. */ (
				window as unknown as NodeSelectorWindow
			).__NODE_SELECTOR_PROOF__;
		state.armApiFailure("GET", "/api/system/info");
		state.armApiFailure("GET", "/api/system/info");
	});
	let { menu } = await openCompactMenu(page, /Lan-box/);
	await menu.getByRole("menuitem", { name: "Hardware" }).click();
	const hardware = page.getByRole("dialog", { name: /Hardware · Lan-box/ });
	await expect(
		hardware.getByText("Computer unreachable — couldn't load hardware.")
	).toBeVisible();
	await expect
		.poll(
			async () =>
				(await readSnapshot(page)).apiCalls.filter(
					(call) =>
						call.path === "/api/system/info" &&
						call.url === "http://lan.fixture:7980"
				).length
		)
		.toBe(2);
	const infoCalls = (await readSnapshot(page)).apiCalls.filter(
		(call) =>
			call.path === "/api/system/info" && call.url === "http://lan.fixture:7980"
	);
	await expect(infoCalls.map((call) => call.status)).toEqual([503, 503]);
	await page.keyboard.press("Escape");
	await expect(hardware).toBeHidden();
	({ menu } = await openCompactMenu(page, /Lan-box/));
	await expect(menu.getByText("8 cores · A10G", { exact: true })).toBeVisible();
	await expect
		.poll(async () =>
			(await readSnapshot(page)).apiCalls
				.filter(
					(call) =>
						call.path === "/api/system/info" &&
						call.url === "http://lan.fixture:7980"
				)
				.map((call) => call.status)
		)
		.toEqual([503, 503, 200]);
});

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
	// accessibility tree (the toaster anchor is a live region the modal spares),
	// and pressing it must not dismiss the dialog the error is about.
	const sandboxError = page.getByRole("button", {
		name: "/api/sandboxes failed: 503",
	});
	await expect(sandboxError).toBeVisible();
	await sandboxError.click();
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

test("exercises the wallet and settings/cloud links for the active managed node", async ({
	page,
}) => {
	await openSelector(page, "compact", "active=cloud&level=expert");
	let { menu } = await openCompactMenu(page, /Cloud-managed/);
	await expect(menu.getByTestId("managed-node-wallet")).toHaveAttribute(
		"data-credit-state",
		"empty"
	);
	await menu.getByRole("button", { name: /Credits empty/ }).click();
	let state = await readState(page);
	expect(state.settings).toEqual({ open: true, section: "credits" });
	await page.evaluate(() =>
		/* SAFETY: node-selector-proof.tsx installs __CLOSE_NODE_SELECTOR_SETTINGS__ before this proof page is evaluated. */ (
			window as unknown as NodeSelectorWindow
		).__CLOSE_NODE_SELECTOR_SETTINGS__()
	);
	await page.keyboard.press("Escape");
	({ menu } = await openCompactMenu(page, /Cloud-managed/));
	const addCredits = menu.getByRole("button", { name: "Add credits" });
	await addCredits.focus();
	await addCredits.press("Enter");
	state = await readState(page);
	expect(state.settings).toEqual({ open: true, section: "credits" });

	await page.evaluate(() =>
		/* SAFETY: node-selector-proof.tsx installs __CLOSE_NODE_SELECTOR_SETTINGS__ before this proof page is evaluated. */ (
			window as unknown as NodeSelectorWindow
		).__CLOSE_NODE_SELECTOR_SETTINGS__()
	);
	await page.keyboard.press("Escape");
	({ menu } = await openCompactMenu(page, /Cloud-managed/));
	const gatewaySettings = menu.getByRole("menuitem", {
		name: "Gateway settings",
	});
	await gatewaySettings.focus();
	await gatewaySettings.press("Enter");
	await expect
		.poll(async () => (await readState(page)).gateway)
		.toEqual({ open: true, section: "overview" });
	const gateway = page.getByRole("dialog").last();
	await expect(gateway).toBeVisible();
	await gateway.getByRole("button", { name: "Close" }).click();
	await expect
		.poll(async () => (await readState(page)).gateway.open)
		.toBe(false);

	await page.keyboard.press("Escape");
	({ menu } = await openCompactMenu(page, /Cloud-managed/));
	const manageCloudComputers = menu.getByRole("menuitem", {
		name: "Manage cloud computers",
	});
	await manageCloudComputers.focus();
	await manageCloudComputers.press("Enter");
	const finalState = await readSnapshot(page);
	expect(finalState.externalUrls).toHaveLength(1);
	expect(finalState.externalUrls[0]).toMatch(/\/organizations$/);
	expect(
		finalState.nativeCalls.filter((call) => call.command === "open_external")
	).toEqual([
		{
			args: { url: finalState.externalUrls[0] },
			command: "open_external",
			result: "ok",
		},
	]);
});
