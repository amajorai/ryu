// Node selector proof: the persistent-sidebar item, the compact menu's
// hardware pages, and the wallet and settings/cloud links.

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
