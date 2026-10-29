import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { InvokeArgs } from "@tauri-apps/api/core";

interface ApiCall {
	authorization: string | null;
	body: unknown;
	method: string;
	path: string;
	status?: number;
	url: string;
}

interface TauriCall {
	args?: InvokeArgs;
	command: string;
	origin?: "automatic" | "manual" | "restart";
}

interface PreflightSnapshot {
	analyticsEvents: unknown[];
	apiCalls: ApiCall[];
	clipboardText: string | null;
	coreStatus: "running" | "stopped";
	nonNodeFetches: string[];
	safeModeEnabled: boolean;
	safeModeSentinel: boolean;
	scheduledUpdates: Array<{
		asset: unknown;
		scheduled_for: string;
		time_zone: string;
		version: string;
	}>;
	serviceStatus: Array<{ name: string; running: boolean }>;
	tauriCalls: TauriCall[];
	telemetryReports: string[];
}

interface PreflightProofWindow extends Window {
	__preflightPageProof: {
		snapshot: () => PreflightSnapshot;
	};
}

const NODE_URL = "http://127.0.0.1:5319";
const NODE_TOKEN = "preflight-proof-node-token";
/** The token the harness gives this computer's own Core (`node=local`). */
const LOCAL_NODE_TOKEN = "preflight-proof-local-token";
const UPDATE_ASSET = {
	kind: "core",
	name: "ryu-core-proof-linux-x64.tar.gz",
	size: 4096,
	url: "https://updates.example.invalid/releases/ryu-core-proof.tar.gz",
};

function evidencePath(name: string): string {
	return path.resolve(import.meta.dirname, `evidence/${name}.png`);
}

async function snapshot(page: Page): Promise<PreflightSnapshot> {
	return page.evaluate(() =>
		/* SAFETY: preflight-page-proof.mock.ts installs __preflightPageProof before this proof page is evaluated. */ (
			window as PreflightProofWindow
		).__preflightPageProof.snapshot()
	);
}

async function openGatewayHealth(page: Page, query: string): Promise<void> {
	await page.goto(`/preflight-page-proof.html?surface=gateway&${query}`);
	const coreTrigger = page.getByRole("button", { name: /^Core\b/ });
	await expect(coreTrigger).toBeVisible();
	if ((await coreTrigger.getAttribute("aria-expanded")) === "true") {
		await coreTrigger.click();
	}
	await coreTrigger.click();
	const description = page.getByText(
		/Ryu's brain\. Chat, agents, and automations/
	);
	await description.scrollIntoViewIfNeeded();
	await expect(description).toBeVisible();
}

function callsFor(
	result: PreflightSnapshot,
	pathName: string,
	method: string
): ApiCall[] {
	return result.apiCalls.filter(
		(call) => call.path === pathName && call.method === method
	);
}

function expectNonNodeFetchesStayOnLoopback(urls: string[]): void {
	expect(
		urls.every((rawUrl) => {
			const hostname = new URL(rawUrl).hostname;
			return hostname === "localhost" || hostname === "127.0.0.1";
		})
	).toBe(true);
}

test.describe.configure({ timeout: 90_000 });

test("manual Core start and Safe Mode report failures, retry, and read back the host state", async ({
	page,
}) => {
	// Starting, restarting and Safe Mode restarts drive this computer's own Core
	// process, so the proof opens the dialog on the local computer.
	await openGatewayHealth(
		page,
		"core=stopped&fail=core-start,safe-mode&node=local"
	);
	await expect(page.getByText("not running", { exact: true })).toBeVisible();
	await expect
		.poll(
			async () =>
				(await snapshot(page)).tauriCalls.filter(
					(call) => call.command === "start_ryu_core"
				).length
		)
		.toBe(1);
	const startCore = page.getByRole("button", {
		name: "Start Core",
		exact: true,
	});
	await expect(startCore).toBeVisible();
	await startCore.click();
	await expect(page.getByText("Core start is unavailable.")).toBeVisible();
	await expect(startCore).toBeEnabled();
	await startCore.click();
	await expect(
		page.getByText("running · v0.9.7-proof", { exact: true })
	).toBeVisible();

	const startCalls = (await snapshot(page)).tauriCalls.filter(
		(call) => call.command === "start_ryu_core"
	);
	expect(startCalls.map((call) => call.origin)).toEqual([
		"automatic",
		"manual",
		"manual",
	]);
	expect(startCalls.every((call) => call.args === undefined)).toBe(true);

	const armSafeMode = page.getByRole("button", {
		name: "Restart in Safe Mode",
		exact: true,
	});
	await expect(armSafeMode).toBeVisible();
	await armSafeMode.click();
	await expect(
		page.getByText("Safe Mode is controlled by the host policy.", {
			exact: true,
		})
	).toBeVisible();
	await expect(armSafeMode).toBeEnabled();
	let result = await snapshot(page);
	let safeModeWrites = callsFor(result, "/api/safe-mode", "PUT");
	expect(safeModeWrites).toEqual([
		expect.objectContaining({
			authorization: `Bearer ${LOCAL_NODE_TOKEN}`,
			body: { enabled: true },
			status: 409,
		}),
	]);
	expect(
		result.tauriCalls.some((call) => call.command === "set_safe_mode_sentinel")
	).toBe(false);
	await armSafeMode.click();
	await expect(
		page.getByRole("button", { name: "Leave Safe Mode", exact: true })
	).toBeVisible();
	result = await snapshot(page);
	safeModeWrites = callsFor(result, "/api/safe-mode", "PUT");
	expect(safeModeWrites).toHaveLength(2);
	expect(safeModeWrites.map((call) => call.body)).toEqual([
		{ enabled: true },
		{ enabled: true },
	]);
	expect(safeModeWrites.map((call) => call.status)).toEqual([409, 200]);
	expect(result.safeModeEnabled).toBe(true);
	expect(
		result.tauriCalls.filter((call) => call.command === "stop_ryu_core")
	).toHaveLength(1);
	expect(
		result.tauriCalls.filter((call) => call.command === "start_ryu_core")
	).toHaveLength(4);
	expect(
		result.tauriCalls.some((call) => call.command === "set_safe_mode_sentinel")
	).toBe(false);
});

test("remote Core update retries the exact asset and Update tonight reads back the node schedule", async ({
	page,
}) => {
	await openGatewayHealth(page, "core=running&fail=update-apply");
	await expect(page.getByRole("button", { name: "Update Core" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Update tonight", exact: true })
	).toBeVisible();
	const updateCore = page.getByRole("button", {
		name: "Update Core",
		exact: true,
	});

	await updateCore.click();
	await expect(
		page.getByText("/api/update/apply failed: 503", { exact: true })
	).toBeVisible();
	await expect(updateCore).toBeEnabled();
	await updateCore.click();
	await expect(
		page.getByText("Proof update staged on the local fixture.", { exact: true })
	).toBeVisible();

	const updateTonight = page.getByRole("button", {
		name: "Update tonight",
		exact: true,
	});
	await updateTonight.click();
	await expect(
		page.getByText(/v0\.9\.8-proof will install at .*\(Etc\/UTC\)\./)
	).toBeVisible();

	const result = await snapshot(page);
	const applyCalls = callsFor(result, "/api/update/apply", "POST");
	expect(applyCalls).toHaveLength(2);
	expect(applyCalls.map((call) => call.body)).toEqual([
		UPDATE_ASSET,
		UPDATE_ASSET,
	]);
	expect(applyCalls.map((call) => call.status)).toEqual([503, 200]);
	expect(
		applyCalls.every(
			(call) =>
				call.authorization === `Bearer ${NODE_TOKEN}` &&
				call.url.startsWith(NODE_URL)
		)
	).toBe(true);
	const scheduleCalls = callsFor(result, "/api/update/schedule", "POST");
	expect(scheduleCalls).toEqual([
		expect.objectContaining({
			authorization: `Bearer ${NODE_TOKEN}`,
			body: { asset: UPDATE_ASSET, version: "0.9.8-proof" },
			status: 200,
			url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:5319\//),
		}),
	]);
	expect(result.scheduledUpdates).toEqual([
		{
			asset: UPDATE_ASSET,
			scheduled_for: "2026-10-03T03:00:00.000Z",
			time_zone: "Etc/UTC",
			version: "0.9.8-proof",
		},
	]);
	expectNonNodeFetchesStayOnLoopback(result.nonNodeFetches);
});

test("sidecar and Gateway restart controls show failure, allow retry, and refresh status", async ({
	page,
}) => {
	await openGatewayHealth(
		page,
		"core=running&fail=sidecar-restart,gateway-restart"
	);
	const sidecarRestart = page.getByRole("button", {
		name: "Restart",
		exact: true,
	});
	await expect(sidecarRestart).toBeVisible();
	await sidecarRestart.click();
	await expect(page.getByText("Sidecar restart is unavailable.")).toBeVisible();
	await expect(sidecarRestart).toBeEnabled();
	await sidecarRestart.click();
	await expect(sidecarRestart).toBeEnabled();

	const gatewayAccordion = page.getByRole("button", { name: /^Gateway\b/ });
	await expect(gatewayAccordion).toHaveAttribute("aria-expanded", "false");
	await gatewayAccordion.click();
	await expect(gatewayAccordion).toHaveAttribute("aria-expanded", "true");
	const restartGateway = page.getByRole("button", {
		name: "Restart Gateway",
		exact: true,
	});
	await expect(restartGateway).toBeVisible();
	await restartGateway.click();
	await expect(
		page.getByText("Gateway can't be restarted from here", { exact: true })
	).toBeVisible();
	await expect(restartGateway).toBeEnabled();
	await restartGateway.click();
	await expect(
		page.getByText("Restarting Gateway…", { exact: true })
	).toBeVisible();
	await expect(page.getByText("connected", { exact: true })).toBeVisible();

	const desktopAccordion = page.getByRole("button", { name: /^Desktop\b/ });
	await expect(desktopAccordion).toHaveAttribute("aria-expanded", "false");
	await desktopAccordion.click();
	await expect(desktopAccordion).toHaveAttribute("aria-expanded", "true");
	await page
		.getByRole("button", { name: "Relaunch Desktop", exact: true })
		.click();

	const result = await snapshot(page);
	const sidecarCalls = callsFor(
		result,
		"/api/sidecar/preflight-proof-running-sidecar/restart",
		"POST"
	);
	expect(sidecarCalls).toHaveLength(2);
	expect(sidecarCalls.map((call) => call.status)).toEqual([503, 200]);
	expect(
		sidecarCalls.every(
			(call) =>
				call.authorization === `Bearer ${NODE_TOKEN}` && call.body === null
		)
	).toBe(true);
	const gatewayCalls = callsFor(result, "/api/gateway/restart", "POST");
	expect(gatewayCalls).toHaveLength(2);
	expect(gatewayCalls.map((call) => call.status)).toEqual([200, 200]);
	expect(gatewayCalls.map((call) => call.body)).toEqual([null, null]);
	expect(
		gatewayCalls.every((call) => call.authorization === `Bearer ${NODE_TOKEN}`)
	).toBe(true);
	expect(
		result.tauriCalls.filter(
			(call) => call.command === "plugin:process|relaunch"
		)
	).toHaveLength(1);
	const refreshedStatuses = callsFor(result, "/api/system/status", "GET");
	expect(refreshedStatuses.length).toBeGreaterThanOrEqual(3);
	expectNonNodeFetchesStayOnLoopback(result.nonNodeFetches);
	await gatewayAccordion.click();
	await desktopAccordion.click();
	await page
		.getByRole("button", { name: "Copy diagnostics", exact: true })
		.scrollIntoViewIfNeeded();
	await expect(page.getByText("connected", { exact: true })).toBeVisible();
	await mkdir(path.dirname(evidencePath("preflight-page-production-health")), {
		recursive: true,
	});
	await page.screenshot({
		animations: "disabled",
		path: evidencePath("preflight-page-production-health"),
	});
});

test("diagnostics copy and report use only local fixtures and stubbed consent sinks", async ({
	page,
}) => {
	// Reporting requires crash-report consent and a configured sink.
	await openGatewayHealth(page, "core=running&crashReports=on");
	await page
		.getByRole("button", { name: "Copy diagnostics", exact: true })
		.click();
	await expect(
		page.getByText("Diagnostics copied to clipboard", { exact: true })
	).toBeVisible();
	let result = await snapshot(page);
	expect(result.clipboardText).toContain("# Ryu diagnostics");
	expect(result.clipboardText).toContain(`node ${NODE_URL}`);
	expect(result.clipboardText).toContain("## Health (/api/health)");
	expect(result.clipboardText).toContain(
		"preflight-proof-running-sidecar: installed"
	);

	await page.getByRole("button", { name: "Report issue", exact: true }).click();
	await expect(
		page.getByText("Issue report queued", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText(
			"Delivery to the reporting service has not been confirmed.",
			{
				exact: true,
			}
		)
	).toBeVisible();
	result = await snapshot(page);
	expect(result.telemetryReports).toHaveLength(1);
	expect(result.telemetryReports[0]).toContain("[preflight-report]");
	expect(result.telemetryReports[0]).toContain("## Health (/api/health)");
	expect(result.telemetryReports[0]).not.toContain("## Recent console");
	expect(result.analyticsEvents).toContainEqual({
		code: "preflight_report",
		event: "error_shown",
	});
	expectNonNodeFetchesStayOnLoopback(result.nonNodeFetches);
});

declare global {
	interface Window {
		__preflightPageProof: {
			snapshot: () => PreflightSnapshot;
		};
	}
}
