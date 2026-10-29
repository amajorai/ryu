import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { CloudSyncProofState } from "./harness/desktop-cloud-sync-settings-proof.mock.ts";

declare global {
	interface Window {
		__CLOUD_SYNC_PROOF__?: CloudSyncProofState;
	}
}

const evidence = (name: string) =>
	path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence",
		name
	);

async function openProof(page: Page, query = ""): Promise<void> {
	await page.goto(`/desktop-cloud-sync-settings-proof.html${query}`);
	await expect(page.locator("header h1")).toHaveText("Connections");
}

async function proofState(page: Page): Promise<CloudSyncProofState> {
	const state = await page.evaluate(() => window.__CLOUD_SYNC_PROOF__);
	if (!state) {
		throw new Error("Cloud sync fixtures were not installed");
	}
	return state;
}

function syncSwitch(page: Page) {
	return page.getByRole("switch", {
		name: "Sync my chats and Spaces across devices",
	});
}

test("defaults off, reads node auth, and writes bare boolean values on opt-in/out", async ({
	page,
}) => {
	await openProof(page);
	const sync = syncSwitch(page);
	await expect(sync).toBeEnabled();
	await expect(sync).not.toBeChecked();
	const initialCalls = (await proofState(page)).calls;
	expect(
		initialCalls.map((call) => ({ method: call.method, path: call.path }))
	).toContainEqual({ method: "GET", path: "/api/auth/status" });
	expect(
		initialCalls.map((call) => ({ method: call.method, path: call.path }))
	).toContainEqual({
		method: "GET",
		path: "/api/preferences/cloud-sync-enabled",
	});
	expect(
		initialCalls.every(
			(call) => call.authorization === "Bearer cloud-sync-proof-token"
		)
	).toBe(true);
	await page.screenshot({
		path: evidence("desktop-cloud-sync-off-by-default.png"),
		fullPage: true,
	});

	await sync.click();
	await expect(sync).toBeChecked();
	expect((await proofState(page)).preference).toBe("true");
	await sync.click();
	await expect(sync).not.toBeChecked();
	expect((await proofState(page)).preference).toBe("false");
	const writes = (await proofState(page)).calls.filter(
		(call) =>
			call.method === "PUT" &&
			call.path === "/api/preferences/cloud-sync-enabled"
	);
	expect(writes.map((call) => call.body)).toEqual([
		{ value: "true" },
		{ value: "false" },
	]);
});

test("keeps a saved preference visible but disabled while this node is signed out", async ({
	page,
}) => {
	await openProof(page, "?syncOn&signedOut");
	const sync = syncSwitch(page);
	await expect(sync).toBeChecked();
	await expect(sync).toBeDisabled();
	await expect(
		page.getByText(
			"Sign in on this node to sync across devices. Until then, syncing stays paused even when this is on.",
			{ exact: true }
		)
	).toBeVisible();
	expect(
		(await proofState(page)).calls.some(
			(call) =>
				call.method === "PUT" &&
				call.path === "/api/preferences/cloud-sync-enabled"
		)
	).toBe(false);
});

test("rolls the switch back after a failed preference write and lets the user retry", async ({
	page,
}) => {
	await openProof(page);
	await page.evaluate(() => {
		const state = window.__CLOUD_SYNC_PROOF__;
		if (!state) {
			throw new Error("Cloud sync fixtures were not installed");
		}
		state.writeFailureRemaining = 1;
	});
	const sync = syncSwitch(page);
	await sync.click();
	await expect(
		page.getByText("Couldn't save your sync choice", { exact: true })
	).toBeVisible();
	await expect(sync).not.toBeChecked();
	await expect(
		page.getByRole("button", { name: /Couldn't save your sync choice/u })
	).toHaveCSS("opacity", "1");
	await page.screenshot({
		path: evidence("desktop-cloud-sync-write-error-retry.png"),
		fullPage: true,
	});
	await sync.click();
	await expect(sync).toBeChecked();
	expect((await proofState(page)).preference).toBe("true");
	const writes = (await proofState(page)).calls.filter(
		(call) =>
			call.method === "PUT" &&
			call.path === "/api/preferences/cloud-sync-enabled"
	);
	expect(writes.map((call) => call.body)).toEqual([
		{ value: "true" },
		{ value: "true" },
	]);
});

test("fails open when this node's auth status is unreachable", async ({
	page,
}) => {
	await openProof(page, "?failAuthRead");
	const sync = syncSwitch(page);
	await expect(sync).toBeEnabled();
	await expect(
		page.getByText(/Sign in on this node to sync across devices/u)
	).toHaveCount(0);
	await sync.click();
	await expect(sync).toBeChecked();
	expect((await proofState(page)).preference).toBe("true");
	expect(
		(await proofState(page)).calls.filter(
			(call) => call.path === "/api/auth/status"
		).length
	).toBe(1);
});

test("shows an error and keeps the switch hidden until preference reload succeeds", async ({
	page,
}) => {
	await openProof(page, "?failPreferenceRead");
	await expect(
		page.getByText("We couldn't read this node's sync settings.")
	).toBeVisible();
	await expect(syncSwitch(page)).toHaveCount(0);
	await page.screenshot({
		path: evidence("desktop-cloud-sync-load-error.png"),
		fullPage: true,
	});
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(syncSwitch(page)).toBeEnabled();
	expect(
		(await proofState(page)).calls.filter(
			(call) =>
				call.method === "GET" &&
				call.path === "/api/preferences/cloud-sync-enabled"
		).length
	).toBe(2);
});
