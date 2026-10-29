import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { NodeSelectorProofSnapshot } from "./harness/node-selector-proof.mock.ts";

interface NodeSelectorProofWindow extends Window {
	__NODE_SELECTOR_PROOF__: {
		armApiFailure: (method: string, path: string, status?: number) => void;
		setNodeOnline: (name: string, online: boolean) => void;
		snapshot: () => NodeSelectorProofSnapshot;
	};
	__READ_NODE_SELECTOR_STATE__: () => {
		defaultNode: string;
	};
}

const evidenceDirectory = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

async function openSelector(
	page: Page,
	mode: "compact" | "persistent",
	query = ""
): Promise<void> {
	const params = new URLSearchParams({ mode, reset: "true" });
	for (const [key, value] of new URLSearchParams(query)) {
		params.set(key, value);
	}
	await page.goto(`/node-selector-proof.html?${params.toString()}`);
	await expect(
		page.getByRole("heading", { name: "Node selector", exact: true })
	).toBeVisible();
}

async function readSnapshot(page: Page): Promise<NodeSelectorProofSnapshot> {
	return await page.evaluate(() =>
		/* SAFETY: node-selector-proof.mock.ts installs __NODE_SELECTOR_PROOF__ before this proof page is evaluated. */ (
			window as NodeSelectorProofWindow
		).__NODE_SELECTOR_PROOF__.snapshot()
	);
}

async function readDefaultNode(page: Page): Promise<string> {
	return await page.evaluate(
		() =>
			/* SAFETY: node-selector-proof.tsx installs __READ_NODE_SELECTOR_STATE__ before this proof page is evaluated. */ (
				window as NodeSelectorProofWindow
			).__READ_NODE_SELECTOR_STATE__().defaultNode
	);
}

async function openCompactMenu(
	page: Page,
	activeName: RegExp | string = "Your computer"
) {
	const trigger = page
		.getByTestId("node-selector-surface")
		.getByRole("button")
		.first();
	await expect(trigger).toContainText(activeName);
	await trigger.click();
	const menu = page.getByRole("menu").first();
	await expect(menu).toBeVisible();
	return { menu, trigger };
}

/** Open the expanded computer dialog from the compact menu. Its title follows
 *  the page stack, so callers get the dialog by role alone. */
async function openComputerSettings(page: Page) {
	const { menu } = await openCompactMenu(page);
	await menu
		.getByRole("menuitem", { name: /Engines, voice, toolkits/ })
		.click();
	await expect(page.getByRole("dialog", { name: "Computer" })).toBeVisible();
	return page.getByRole("dialog");
}

test.describe.configure({ timeout: 120_000 });

test("selects a persistent-sidebar node and visibly marks the active row", async ({
	page,
}) => {
	await openSelector(page, "persistent");
	const remoteName = page.getByText("Lan-box", { exact: true });
	const remoteRow = remoteName.locator(
		"xpath=ancestor::div[contains(@class,'group')][1]"
	);
	await remoteRow.click();
	await expect.poll(() => readDefaultNode(page)).toBe("lan-box");
	await expect(remoteRow).toHaveClass(/bg-accent/);

	const localRow = page
		.getByText("Your computer", { exact: true })
		.locator("xpath=ancestor::div[contains(@class,'group')][1]");
	await expect(localRow).not.toHaveClass(/bg-accent text-accent-foreground/);
	const selectionCalls = (await readSnapshot(page)).nativeCalls.filter(
		(call) => call.command === "set_default_node"
	);
	expect(selectionCalls).toEqual([
		{ args: { name: "lan-box" }, command: "set_default_node", result: "ok" },
	]);
});

test("opens Add computer, cancels without a bridge mutation, and manages cloud computers", async ({
	page,
}) => {
	await openSelector(page, "persistent");
	await page.getByRole("button", { name: "Add computer" }).click();
	const addDialog = page.getByRole("dialog", { name: "Add computer" });
	await expect(addDialog).toBeVisible();
	await addDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(addDialog).toBeHidden();
	let snapshot = await readSnapshot(page);
	expect(
		snapshot.nativeCalls.filter((call) => call.command === "add_node")
	).toEqual([]);

	await page.getByRole("button", { name: "Manage cloud computers" }).click();
	snapshot = await readSnapshot(page);
	expect(snapshot.externalUrls).toHaveLength(1);
	expect(snapshot.externalUrls[0]).toMatch(/\/organizations$/);
	expect(
		snapshot.nativeCalls.filter((call) => call.command === "open_external")
	).toEqual([
		{
			args: { url: snapshot.externalUrls[0] },
			command: "open_external",
			result: "ok",
		},
	]);
});

test("selects a remote node, recovers its offline status, and keeps nested dialogs on that node", async ({
	page,
}) => {
	await openSelector(page, "compact");
	let { menu, trigger } = await openCompactMenu(page);
	await menu.getByRole("menuitem", { name: /Lan-box/ }).click();
	await expect(trigger).toContainText("Lan-box");
	await expect(trigger.locator('[data-slot="node-status-dot"]')).toHaveClass(
		/bg-success/
	);
	await expect.poll(() => readDefaultNode(page)).toBe("lan-box");
	expect(
		(await readSnapshot(page)).nativeCalls.filter(
			(call) => call.command === "set_default_node"
		)
	).toEqual([
		{ args: { name: "lan-box" }, command: "set_default_node", result: "ok" },
	]);

	await page.reload();
	trigger = page.getByRole("button", { name: /Lan-box/ }).first();
	await expect(trigger).toBeVisible();
	await expect.poll(() => readDefaultNode(page)).toBe("lan-box");
	await page.evaluate(() =>
		/* SAFETY: node-selector-proof.mock.ts installs __NODE_SELECTOR_PROOF__ before this proof page is evaluated. */ (
			window as NodeSelectorProofWindow
		).__NODE_SELECTOR_PROOF__.setNodeOnline("lan-box", false)
	);
	await expect(trigger.locator('[data-slot="node-status-dot"]')).toHaveClass(
		/bg-destructive/,
		{ timeout: 12_000 }
	);
	await page.evaluate(() =>
		/* SAFETY: node-selector-proof.mock.ts installs __NODE_SELECTOR_PROOF__ before this proof page is evaluated. */ (
			window as NodeSelectorProofWindow
		).__NODE_SELECTOR_PROOF__.setNodeOnline("lan-box", true)
	);
	await expect(trigger.locator('[data-slot="node-status-dot"]')).toHaveClass(
		/bg-success/,
		{ timeout: 12_000 }
	);

	({ menu } = await openCompactMenu(page, /Lan-box/i));
	const activeRow = menu.getByRole("menuitem", { name: /Lan-box/ });
	await expect(activeRow).toContainText("Active");
	await expect(
		menu.getByRole("menuitem", { name: /Your computer/ })
	).not.toContainText("Active");

	await activeRow.getByRole("button", { name: "Share Lan-box" }).click();
	const shareDialog = page.getByRole("dialog", {
		name: /Connect a computer to Lan-box/,
	});
	await expect(shareDialog).toBeVisible();
	await expect.poll(() => readDefaultNode(page)).toBe("lan-box");
	await shareDialog.getByRole("button", { name: "Done" }).click();
	await expect(shareDialog).toBeHidden();
	await expect(menu).toBeVisible();
	await expect.poll(() => readDefaultNode(page)).toBe("lan-box");
	await expect(trigger).toContainText("Lan-box");
});

test("opens the compact Hardware dialog with the selected node's live readback", async ({
	page,
}) => {
	await page.setViewportSize({ height: 1280, width: 1280 });
	await openSelector(page, "compact", "active=lan");
	const { menu } = await openCompactMenu(page, /Lan-box/i);
	await menu.getByRole("menuitem", { name: "Hardware", exact: true }).click();
	const hardwareDialog = page.getByRole("dialog", {
		name: /Hardware · Lan-box/,
	});
	await expect(hardwareDialog).toBeVisible();
	await expect(
		hardwareDialog.getByText("selector-fixture", { exact: true })
	).toBeVisible();
	await expect(
		hardwareDialog.getByText("NVIDIA A10G", { exact: true })
	).toBeVisible();
	const infoCalls = (await readSnapshot(page)).apiCalls.filter(
		(call) =>
			call.method === "GET" &&
			call.path === "/api/system/info" &&
			call.url === "http://lan.fixture:7980"
	);
	expect(infoCalls.some((call) => call.status === 200)).toBe(true);
	expect(
		infoCalls.some(
			(call) => call.authorization === "Bearer lan-node-selector-token"
		)
	).toBe(true);

	await mkdir(evidenceDirectory, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(
			evidenceDirectory,
			"desktop-node-selector-interactions-hardware-dialog.png"
		),
	});
	await hardwareDialog.getByRole("button", { name: "Close" }).click();
	await expect(hardwareDialog).toBeHidden();
});

test("starts an image engine through the compact dropdown and recovers after a failed request", async ({
	page,
}) => {
	await openSelector(page, "compact");
	const dialog = await openComputerSettings(page);
	await dialog.getByRole("button", { name: /^Engines & models/ }).click();
	const imageLayer = dialog.getByRole("button", { name: /^Image\b/ });
	await expect(imageLayer).toBeVisible();
	await imageLayer.click();
	const imageEngine = dialog.getByRole("button", {
		name: /^Fixture image engine/,
	});
	await expect(imageEngine).toBeVisible();
	await page.evaluate(() =>
		/* SAFETY: node-selector-proof.mock.ts installs __NODE_SELECTOR_PROOF__ before this proof page is evaluated. */ (
			window as NodeSelectorProofWindow
		).__NODE_SELECTOR_PROOF__.armApiFailure(
			"POST",
			"/api/sidecar/image-engine/start"
		)
	);
	await imageEngine.click();
	await expect
		.poll(async () =>
			(await readSnapshot(page)).apiCalls
				.filter((call) => call.path === "/api/sidecar/image-engine/start")
				.map((call) => call.status)
		)
		.toEqual([503]);
	await expect(
		page.getByText("/api/sidecar/image-engine/start failed: 503", {
			exact: true,
		})
	).toBeVisible();
	await expect(imageEngine).toBeEnabled();
	await imageEngine.click();
	await expect
		.poll(async () =>
			(await readSnapshot(page)).apiCalls
				.filter((call) => call.path === "/api/sidecar/image-engine/start")
				.map((call) => call.status)
		)
		.toEqual([503, 200]);
	await expect(imageEngine.locator('svg[aria-label="Running"]')).toBeVisible();
	// Back on the Engines page the layer row reads the new state.
	await dialog
		.getByRole("button", { name: "Back to Engines & models" })
		.click();
	await expect(imageLayer).toContainText("Fixture image engine");
	await expect(imageLayer.locator('[class*="bg-success"]')).toBeVisible();

	const startCalls = (await readSnapshot(page)).apiCalls.filter(
		(call) => call.path === "/api/sidecar/image-engine/start"
	);
	expect(
		startCalls.map((call) => ({
			authorization: call.authorization,
			body: call.body,
			method: call.method,
			path: call.path,
			status: call.status,
		}))
	).toEqual([
		{
			authorization: "Bearer local-node-selector-token",
			body: null,
			method: "POST",
			path: "/api/sidecar/image-engine/start",
			status: 503,
		},
		{
			authorization: "Bearer local-node-selector-token",
			body: null,
			method: "POST",
			path: "/api/sidecar/image-engine/start",
			status: 200,
		},
	]);
});

test("selects a Decision Models capability provider and reads back the active binding", async ({
	page,
}) => {
	await openSelector(page, "compact", "decisionModels=true");
	const dialog = await openComputerSettings(page);
	await dialog.getByRole("button", { name: /^Engines & models/ }).click();
	await expect(
		dialog.getByRole("heading", { name: "Decision Models", exact: true })
	).toBeVisible();
	const typedDecisions = dialog.getByRole("button", {
		name: /Typed Decisions/,
	});
	await expect(typedDecisions).toBeVisible();
	await typedDecisions.click();
	await dialog.getByRole("button", { name: /Ollaya Decision Models/ }).click();
	await expect(
		page.getByText("Pinned · 2 providers enabled", { exact: true }).last()
	).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: /^Ollaya Decision Models/ })
	).toHaveAttribute("aria-current", "true");

	const calls = (await readSnapshot(page)).apiCalls.filter(
		(call) =>
			call.path === "/api/plugins/%40ryu%2Follaya/enable" ||
			call.path === "/api/capabilities/bindings"
	);
	expect(
		calls.map((call) => ({
			authorization: call.authorization,
			body: call.body,
			method: call.method,
			path: call.path,
			status: call.status,
		}))
	).toEqual([
		{
			authorization: "Bearer local-node-selector-token",
			body: null,
			method: "POST",
			path: "/api/plugins/%40ryu%2Follaya/enable",
			status: 200,
		},
		{
			authorization: "Bearer local-node-selector-token",
			body: null,
			method: "GET",
			path: "/api/capabilities/bindings",
			status: 200,
		},
		{
			authorization: "Bearer local-node-selector-token",
			body: { overrides: { "decision.typed": "@ryu/ollaya" } },
			method: "PUT",
			path: "/api/capabilities/bindings",
			status: 200,
		},
	]);
});

test("a double-click on a computer dialog row opens its page without pressing the action beneath", async ({
	page,
}) => {
	await openSelector(page, "compact");
	const dialog = await openComputerSettings(page);
	await dialog.getByRole("button", { name: /^Services/ }).click();
	// Gateway is row two on Services; on the Gateway page row two is "Stop".
	await dialog.getByRole("button", { name: /^Gateway/ }).dblclick();
	await expect(
		dialog.getByRole("button", { name: "Back to Services" })
	).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Stop" })).toBeVisible();
	await page.waitForTimeout(300);
	const stopCalls = (await readSnapshot(page)).apiCalls.filter((call) =>
		call.path.includes("/stop")
	);
	expect(stopCalls).toEqual([]);
});
