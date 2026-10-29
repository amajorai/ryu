import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { DangerZoneProofState } from "./harness/desktop-danger-zone-proof.mock.ts";

declare global {
	interface Window {
		__DANGER_ZONE_PROOF__?: DangerZoneProofState;
	}
}

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
const evidence = (name: string) =>
	path.resolve(
		process.env.RYU_PROOF_EVIDENCE_DIR ??
			path.resolve(
				import.meta.dirname,
				"../../../docs/proof/test-coverage-sweep-20260924/evidence"
			),
		name
	);

async function openProof(page: Page, query = ""): Promise<void> {
	await page.goto("about:blank");
	await page.evaluate(() => {
		window.name = "";
	});
	await page.goto(`/desktop-danger-zone-proof.html${query}`);
	await expect(page.locator("header h1")).toHaveText("Danger zone");
}

async function proofState(page: Page): Promise<DangerZoneProofState> {
	const state = await page.evaluate(() => window.__DANGER_ZONE_PROOF__);
	if (!state) {
		throw new Error("Danger Zone proof fixtures were not installed");
	}
	return state;
}

async function confirmReset(page: Page, nodeName: string): Promise<void> {
	await page.getByRole("button", { name: "Reset node", exact: true }).click();
	const dialog = page.getByRole("alertdialog");
	await expect(dialog).toBeVisible();
	await dialog.getByPlaceholder(nodeName).fill(nodeName);
	await dialog.getByRole("button", { name: "Reset node", exact: true }).click();
}

test("renders Core-owned categories and disables an empty category", async ({
	page,
}) => {
	await openProof(page);
	await expect(page.getByText("4 chats", { exact: true })).toBeVisible();
	await expect(
		page.getByText("3 meeting notes", { exact: true })
	).toBeVisible();
	await expect(page.getByText("No spaces", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Delete all spaces", exact: true })
	).toBeDisabled();
	const state = await proofState(page);
	expect(state.apiCalls).toHaveLength(1);
	expect(state.apiCalls[0]).toMatchObject({
		authorization: "Bearer danger-zone-proof-token",
		method: "GET",
		path: "/api/data/counts",
	});
	await page.screenshot({
		path: evidence("desktop-danger-zone-categories.png"),
		fullPage: true,
	});
});

test("keeps deletes disabled until the category list is retried successfully", async ({
	page,
}) => {
	await openProof(page, "?countsFail");
	await expect(
		page.getByText(
			"We couldn't load your data. Deleting is disabled until we know what's here."
		)
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Delete all chats", exact: true })
	).toHaveCount(0);
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Delete all chats", exact: true })
	).toBeEnabled();
	expect((await proofState(page)).apiCalls).toHaveLength(2);
});

test("uses the safe kernel-only fallback for an older Core response", async ({
	page,
}) => {
	await openProof(page, "?legacy");
	await expect(page.getByText("9 chats", { exact: true })).toBeVisible();
	await expect(page.getByText("2 spaces", { exact: true })).toBeVisible();
	await expect(
		page.getByText("3 memory entries", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Delete all meeting notes", exact: true })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Delete all chats", exact: true })
	).toBeEnabled();
});

test("requires the matching phrase, supports cancellation, and refreshes after delete", async ({
	page,
}) => {
	await openProof(page);
	await page
		.getByRole("button", { name: "Delete all chats", exact: true })
		.click();
	const dialog = page.getByRole("alertdialog");
	const deleteButton = dialog.getByRole("button", {
		name: "Delete",
		exact: true,
	});
	await expect(dialog).toContainText("This will delete 4 chats.");
	await expect(deleteButton).toBeDisabled();
	await dialog.getByPlaceholder("Chats").fill("wrong phrase");
	await expect(deleteButton).toBeDisabled();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	expect(
		(await proofState(page)).apiCalls.filter(
			(call) => call.path === "/api/data/clear"
		)
	).toHaveLength(0);

	await page
		.getByRole("button", { name: "Delete all chats", exact: true })
		.click();
	const confirmation = page.getByRole("alertdialog");
	await confirmation.getByPlaceholder("Chats").fill(" cHaTs ");
	await expect(
		confirmation.getByRole("button", { name: "Delete", exact: true })
	).toBeEnabled();
	await page.screenshot({
		path: evidence("desktop-danger-zone-chat-confirmation.png"),
		fullPage: true,
	});
	await confirmation
		.getByRole("button", { name: "Delete", exact: true })
		.click();
	await expect(
		page.getByText("4 chats deleted.", { exact: true })
	).toBeVisible();
	await expect(page.getByText("No chats", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Delete all chats", exact: true })
	).toBeDisabled();
	const calls = (await proofState(page)).apiCalls.filter(
		(call) => call.path === "/api/data/clear"
	);
	expect(calls).toHaveLength(1);
	expect(calls[0]).toMatchObject({
		body: { category: "chats" },
		method: "POST",
	});
});

test("shows a failed category delete and lets the user retry it", async ({
	page,
}) => {
	await openProof(page, "?clearFail");
	await page
		.getByRole("button", { name: "Delete all meeting notes", exact: true })
		.click();
	const dialog = page.getByRole("alertdialog");
	await dialog.getByPlaceholder("Meeting notes").fill("Meeting notes");
	await dialog.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(
		page.getByText("Could not delete", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("3 meeting notes", { exact: true })
	).toBeVisible();
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(
		page.getByText("3 meeting notes deleted.", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("No meeting notes", { exact: true })
	).toBeVisible();
	const calls = (await proofState(page)).apiCalls.filter(
		(call) => call.path === "/api/data/clear"
	);
	expect(calls).toHaveLength(2);
	expect(calls.map((call) => call.body)).toEqual([
		{ category: "com.ryu.meetings.notes" },
		{ category: "com.ryu.meetings.notes" },
	]);
});

test("reset confirmation remains disabled for a mismatch and cancellation writes nothing", async ({
	page,
}) => {
	await openProof(page);
	await page.getByRole("button", { name: "Reset node", exact: true }).click();
	const dialog = page.getByRole("alertdialog");
	const resetButton = dialog.getByRole("button", {
		name: "Reset node",
		exact: true,
	});
	await expect(resetButton).toBeDisabled();
	await dialog.getByPlaceholder("Local proof node").fill("another node");
	await expect(resetButton).toBeDisabled();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	expect(
		(await proofState(page)).apiCalls.filter(
			(call) => call.path === "/api/node/reset"
		)
	).toHaveLength(0);
});

test("reports a shared-node reset denial without clearing local client state", async ({
	page,
}) => {
	await openProof(page, "?resetFailure=403");
	await page.evaluate(() => {
		localStorage.setItem("ryu_workspace_folder", "/proof/workspace");
	});
	await page.getByRole("button", { name: "Reset node", exact: true }).click();
	const dialog = page.getByRole("alertdialog");
	await dialog.getByPlaceholder("Local proof node").fill("Local proof node");
	await dialog.getByRole("button", { name: "Reset node", exact: true }).click();
	await expect(
		page.getByText("Could not reset node", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Reset is disabled for a shared organization node.", {
			exact: true,
		})
	).toBeVisible();
	expect((await proofState(page)).restartCalls).toBe(0);
	expect(
		await page.evaluate(() => localStorage.getItem("ryu_workspace_folder"))
	).toBe("/proof/workspace");
	const call = (await proofState(page)).apiCalls.find(
		(entry) => entry.path === "/api/node/reset"
	);
	expect(call).toMatchObject({
		body: { confirm: "Local proof node" },
		method: "POST",
	});
});

test("resets a local node, restarts Core, clears browser state, and reloads", async ({
	page,
}) => {
	await openProof(page);
	await page.evaluate(() => {
		localStorage.setItem("ryu_workspace_folder", "/proof/workspace");
		sessionStorage.setItem("proof-draft", "must be cleared");
	});
	const reloaded = page.waitForEvent("load");
	await confirmReset(page, "local proof node");
	await reloaded;
	await expect(
		page.getByRole("button", { name: "Delete all chats", exact: true })
	).toBeVisible();
	const state = await proofState(page);
	expect(state.restartCalls).toBe(1);
	expect(
		state.apiCalls.find((call) => call.path === "/api/node/reset")
	).toMatchObject({
		body: { confirm: "Local proof node" },
		method: "POST",
	});
	expect(
		await page.evaluate(() => localStorage.getItem("ryu_workspace_folder"))
	).toBeNull();
	expect(
		await page.evaluate(() => sessionStorage.getItem("proof-draft"))
	).toBeNull();
	await page.screenshot({
		path: evidence("desktop-danger-zone-local-reset-complete.png"),
		fullPage: true,
	});
});

test("resets a remote node through its own host without restarting local Core", async ({
	page,
}) => {
	await openProof(page, "?remote");
	const reloaded = page.waitForEvent("load");
	await confirmReset(page, "Remote proof node");
	await reloaded;
	const state = await proofState(page);
	expect(state.restartCalls).toBe(0);
	expect(
		state.apiCalls.find((call) => call.path === "/api/node/reset")
	).toMatchObject({
		body: { confirm: "Remote proof node" },
		method: "POST",
	});
	await expect(
		page.getByRole("button", { name: "Delete all chats", exact: true })
	).toBeVisible();
});

test("validates deep-clean scope and explains the chosen data before cancellation", async ({
	page,
}) => {
	await openProof(page);
	await page.getByRole("button", { name: "Deep clean…", exact: true }).click();
	const options = page.getByRole("dialog");
	await expect(options).toBeVisible();
	await expect(options.getByText("Clear data, keep downloads")).toBeVisible();
	const continueButton = options.getByRole("button", {
		name: "Continue",
		exact: true,
	});
	await options.getByRole("checkbox", { name: "release" }).uncheck();
	await expect(continueButton).toBeDisabled();
	await options.getByRole("checkbox", { name: "canary" }).check();
	await options.getByRole("checkbox", { name: "beta" }).check();
	const depth = options.getByRole("combobox");
	await depth.click();
	await page
		.getByRole("option", { name: "Everything, including downloads" })
		.click();
	await options
		.getByRole("switch", { name: "Also clear shadow and ghost" })
		.uncheck();
	await expect(
		options.getByText(
			"Deletes the whole data folder, engines and models included."
		)
	).toBeVisible();
	await continueButton.click();
	const confirmation = page.getByRole("alertdialog");
	await expect(confirmation).toContainText("canary, beta");
	await expect(confirmation).toContainText(
		"delete its entire data folder including downloaded engines and models"
	);
	await expect(confirmation).not.toContainText("shared by every profile");
	await expect(confirmation).toContainText("The encryption key is kept");
	await page.screenshot({
		path: evidence("desktop-danger-zone-deep-clean-confirmation.png"),
		fullPage: true,
	});
	await confirmation
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	expect(
		(await proofState(page)).invokeCalls.filter(
			(call) => call.command === "deep_clean_node"
		)
	).toHaveLength(0);
	expect((await proofState(page)).restartCalls).toBe(0);
});

test("closes the deep-clean options by button or Escape without running a wipe", async ({
	page,
}) => {
	await openProof(page);
	await page.getByRole("button", { name: "Deep clean…", exact: true }).click();
	let options = page.getByRole("dialog");
	await expect(options).toBeVisible();
	await options.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(options).toHaveCount(0);

	await page.getByRole("button", { name: "Deep clean…", exact: true }).click();
	options = page.getByRole("dialog");
	await expect(options).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(options).toHaveCount(0);
	const state = await proofState(page);
	expect(
		state.invokeCalls.filter((call) => call.command === "deep_clean_node")
	).toHaveLength(0);
	expect(state.restartCalls).toBe(0);
});

test("config-only depth states that data survives and cancels before any profile wipe", async ({
	page,
}) => {
	await openProof(page);
	await page.getByRole("button", { name: "Deep clean…", exact: true }).click();
	const options = page.getByRole("dialog");
	await options.getByRole("combobox").click();
	await page
		.getByRole("option", { name: "Config only — keep all data" })
		.click();
	await expect(
		options.getByText(
			"Removes only the gateway config and the data-folder pointer."
		)
	).toBeVisible();
	await options.getByRole("button", { name: "Continue", exact: true }).click();
	const confirmation = page.getByRole("alertdialog");
	await expect(confirmation).toContainText(
		"Chats, spaces and memory live in the data folder"
	);
	await expect(confirmation).toContainText("are NOT touched at this setting");
	await page.screenshot({
		path: evidence("desktop-danger-zone-config-only-confirmation.png"),
		fullPage: true,
	});
	await confirmation
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	const state = await proofState(page);
	expect(
		state.invokeCalls.filter((call) => call.command === "deep_clean_node")
	).toHaveLength(0);
	expect(state.restartCalls).toBe(0);
});

test("deep-cleans selected profiles with the default useful depth and restarts once", async ({
	page,
}) => {
	await openProof(page);
	await page.evaluate(() => {
		localStorage.setItem("ryu_pinned_dock_tabs", '["chat"]');
	});
	await page.getByRole("button", { name: "Deep clean…", exact: true }).click();
	const options = page.getByRole("dialog");
	await options.getByRole("checkbox", { name: "dev" }).check();
	await expect(
		options.getByText("Deletes chats, spaces, memory")
	).toBeVisible();
	await options.getByRole("button", { name: "Continue", exact: true }).click();
	const confirmation = page.getByRole("alertdialog");
	await expect(confirmation).toContainText("release, dev");
	await expect(confirmation).toContainText(
		"clear its data folder while keeping downloaded engines and models"
	);
	await expect(confirmation).toContainText(
		"Shadow and ghost are shared by every profile"
	);
	const reloaded = page.waitForEvent("load");
	await confirmation
		.getByRole("button", { name: "Remove them", exact: true })
		.click();
	await reloaded;
	const state = await proofState(page);
	expect(
		state.invokeCalls.filter((call) => call.command === "deep_clean_node")
	).toEqual([
		{
			args: { depth: "state", profile: "release", shared: true },
			command: "deep_clean_node",
		},
		{
			args: { depth: "state", profile: "dev", shared: true },
			command: "deep_clean_node",
		},
	]);
	expect(state.restartCalls).toBe(1);
	expect(
		await page.evaluate(() => localStorage.getItem("ryu_pinned_dock_tabs"))
	).toBeNull();
	await page.screenshot({
		path: evidence("desktop-danger-zone-deep-clean-complete.png"),
		fullPage: true,
	});
});

test("keeps profile choices and browser state after a deep-clean failure for retry", async ({
	page,
}) => {
	await openProof(page, "?failProfile=dev");
	await page.evaluate(() => {
		localStorage.setItem("ryu_pinned_dock_tabs", '["chat"]');
	});
	await page.getByRole("button", { name: "Deep clean…", exact: true }).click();
	const options = page.getByRole("dialog");
	await options.getByRole("checkbox", { name: "dev" }).check();
	await options.getByRole("button", { name: "Continue", exact: true }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Remove them", exact: true })
		.click();
	await expect(
		page.getByText("Could not deep clean", { exact: true })
	).toBeVisible();
	await expect(options).toBeVisible();
	let state = await proofState(page);
	expect(
		state.invokeCalls
			.filter((call) => call.command === "deep_clean_node")
			.map((call) =>
				call.args && "profile" in call.args ? call.args.profile : undefined
			)
	).toEqual(["release", "dev"]);
	expect(state.restartCalls).toBe(0);
	// The failed clean stopped local Core; it is started again for the retry.
	expect(state.startCalls).toBe(1);
	expect(
		await page.evaluate(() => localStorage.getItem("ryu_pinned_dock_tabs"))
	).toBe('["chat"]');

	await options.getByRole("button", { name: "Continue", exact: true }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Remove them", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Delete all chats", exact: true })
	).toBeVisible();
	state = await proofState(page);
	expect(
		state.invokeCalls
			.filter((call) => call.command === "deep_clean_node")
			.map((call) =>
				call.args && "profile" in call.args ? call.args.profile : undefined
			)
	).toEqual(["release", "dev", "release", "dev"]);
	expect(state.restartCalls).toBe(1);
	expect(
		await page.evaluate(() => localStorage.getItem("ryu_pinned_dock_tabs"))
	).toBeNull();
});
