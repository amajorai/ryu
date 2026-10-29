import path from "node:path";
import { expect, type Page, test } from "@playwright/test";

interface ComputerUseProofRequest {
	body: unknown;
	method: string;
	path: string;
	status: number;
}

interface ComputerUseProofSnapshot {
	computerUse: { locked_use: boolean };
	requests: ComputerUseProofRequest[];
}

interface ComputerUseProofApi {
	failNextWrite: () => void;
	snapshot: () => ComputerUseProofSnapshot;
}

declare global {
	interface Window {
		__COMPUTER_USE_SETTINGS_PROOF__?: ComputerUseProofApi;
	}
}

function evidencePath(name: string): string {
	return path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence",
		name
	);
}

async function proofSnapshot(page: Page): Promise<ComputerUseProofSnapshot> {
	const snapshot = await page.evaluate(
		() => window.__COMPUTER_USE_SETTINGS_PROOF__?.snapshot() ?? null
	);
	if (!snapshot) {
		throw new Error("Computer Use settings fixture is unavailable");
	}
	return snapshot;
}

function configRequests(snapshot: ComputerUseProofSnapshot) {
	return snapshot.requests.filter(
		(request) => request.path === "/api/gateway/config"
	);
}

function configWrites(snapshot: ComputerUseProofSnapshot) {
	return configRequests(snapshot).filter((request) => request.method === "PUT");
}

async function openSettings(page: Page, query = ""): Promise<void> {
	await page.goto(`/computer-use-settings-proof.html${query}`);
	await expect(
		page.getByRole("heading", { name: "Device settings", exact: true })
	).toBeVisible();
}

test("saves the selected device's locked-use policy and reads it back after reload", async ({
	page,
}) => {
	await openSettings(page);
	const toggle = page.getByRole("switch", { name: "Allow locked use" });
	await expect(toggle).toBeEnabled();
	await expect(toggle).not.toBeChecked();
	await expect(page.getByText("Off", { exact: true })).toBeVisible();

	await toggle.click();
	await expect(toggle).toBeChecked();
	await expect(page.getByText("Allowed", { exact: true })).toBeVisible();
	await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
	const enabled = await proofSnapshot(page);
	expect(configWrites(enabled)).toEqual([
		{
			body: { computer_use: { locked_use: true } },
			method: "PUT",
			path: "/api/gateway/config",
			status: 200,
		},
	]);

	await page.reload();
	await expect(toggle).toBeChecked();
	await expect(page.getByText("Allowed", { exact: true })).toBeVisible();
	const readback = await proofSnapshot(page);
	expect(readback.computerUse).toEqual({ locked_use: true });
	expect(configRequests(readback)).toEqual([
		{
			body: null,
			method: "GET",
			path: "/api/gateway/config",
			status: 200,
		},
	]);
	await page.mouse.move(1200, 650);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("desktop-computer-use-policy-enabled-readback.png"),
	});

	await toggle.click();
	await expect(toggle).not.toBeChecked();
	await expect(page.getByText("Off", { exact: true })).toBeVisible();
	const disabled = await proofSnapshot(page);
	expect(configWrites(disabled)).toEqual([
		{
			body: { computer_use: { locked_use: false } },
			method: "PUT",
			path: "/api/gateway/config",
			status: 200,
		},
	]);
});

test("rolls back a rejected policy write and lets the user retry the same value", async ({
	page,
}) => {
	await openSettings(page);
	const toggle = page.getByRole("switch", { name: "Allow locked use" });
	await expect(toggle).toBeEnabled();
	await page.evaluate(() => {
		window.__COMPUTER_USE_SETTINGS_PROOF__?.failNextWrite();
	});

	await toggle.click();
	await expect(toggle).not.toBeChecked();
	await expect(page.getByText(/503/u)).toBeVisible();
	await expect(page.getByText("Off", { exact: true })).toBeVisible();
	const rejected = await proofSnapshot(page);
	expect(rejected.computerUse).toEqual({ locked_use: false });
	expect(configWrites(rejected)).toEqual([
		{
			body: { computer_use: { locked_use: true } },
			method: "PUT",
			path: "/api/gateway/config",
			status: 503,
		},
	]);
	await page.mouse.move(1200, 650);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath(
			"desktop-computer-use-policy-write-error-rolled-back.png"
		),
	});

	await toggle.click();
	await expect(toggle).toBeChecked();
	await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
	const recovered = await proofSnapshot(page);
	expect(configWrites(recovered)).toEqual([
		{
			body: { computer_use: { locked_use: true } },
			method: "PUT",
			path: "/api/gateway/config",
			status: 503,
		},
		{
			body: { computer_use: { locked_use: true } },
			method: "PUT",
			path: "/api/gateway/config",
			status: 200,
		},
	]);

	await page.reload();
	await expect(toggle).toBeChecked();
	expect((await proofSnapshot(page)).computerUse).toEqual({ locked_use: true });
});

test("keeps the policy read-only without configuration access and unavailable offline", async ({
	page,
}) => {
	await openSettings(page, "?canConfigure=false");
	const readOnlyToggle = page.getByRole("switch", { name: "Allow locked use" });
	await expect(readOnlyToggle).toBeDisabled();
	await expect(
		page.getByText(/need device configuration access/u)
	).toBeVisible();
	const readOnly = await proofSnapshot(page);
	expect(configRequests(readOnly)).toEqual([
		{
			body: null,
			method: "GET",
			path: "/api/gateway/config",
			status: 200,
		},
	]);
	expect(configWrites(readOnly)).toEqual([]);

	await openSettings(page, "?reachable=false");
	const offlineToggle = page.getByRole("switch", { name: "Allow locked use" });
	await expect(offlineToggle).toBeDisabled();
	await expect(
		page.getByText(/unavailable while this device is offline/u)
	).toBeVisible();
	expect(configRequests(await proofSnapshot(page))).toEqual([]);
});
