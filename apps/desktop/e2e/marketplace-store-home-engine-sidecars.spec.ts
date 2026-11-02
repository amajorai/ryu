// Marketplace Store home proof. Engine install, sidecar switches, Manage, sandbox and acceleration.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { EVIDENCE_DIR, IDS } from "./marketplace-store-home.fixture.ts";
import {
	callsFor,
	deferred,
	openStoreSection,
	prepareEvidenceCapture,
	registerStoreHomeEvidenceHooks,
} from "./marketplace-store-home.helpers.ts";
import { storeEffectsSchema } from "./marketplace-store-home-proof.contracts.ts";

registerStoreHomeEvidenceHooks();

test("Engine cards install locally and their active switch only swaps to another resident engine", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	const activeEngine = page.getByRole("button", { name: "llama.cpp" });
	await activeEngine.click();
	const activeSwitch = page.getByRole("switch", {
		name: "Set llama.cpp as active engine",
	});
	await expect(activeSwitch).toBeChecked();
	await expect(activeSwitch).toBeDisabled();
	expect(callsFor(fixture, "POST", "/api/engine/active")).toHaveLength(0);
	await page.getByRole("button", { name: "Close", exact: true }).click();

	const newEngineCard = page
		.getByRole("button", { name: "KoboldCPP Fixture" })
		.locator("xpath=..");
	await newEngineCard.getByRole("button", { name: "Get", exact: true }).click();
	await expect(
		newEngineCard.getByRole("button", { name: "Installed" })
	).toBeVisible();
	expect(fixture.engineInstalled.has(IDS.engineNew)).toBe(true);
	expect(
		callsFor(fixture, "POST", `/api/setup/${IDS.engineNew}/install`).map(
			(call) => ({ search: call.search, body: call.body })
		)
	).toEqual([{ search: "", body: null }]);

	await page.reload();
	await page.getByRole("button", { name: "KoboldCPP Fixture" }).click();
	await expect(
		page.getByRole("switch", {
			name: "Set KoboldCPP Fixture as active engine",
		})
	).toBeEnabled();
	fixture.engineActionFailures[`${IDS.engineNew}:activate`] = 1;
	fixture.engineGatewayRefreshed = false;
	const koboldSwitch = page.getByRole("switch", {
		name: "Set KoboldCPP Fixture as active engine",
	});
	await koboldSwitch.click();
	const detail = page
		.getByRole("dialog")
		.getByText("/api/engine/active failed: 503", { exact: true });
	await expect(detail).toBeVisible();
	await koboldSwitch.click();
	await expect(koboldSwitch).toBeChecked();
	await expect(
		page.getByText("Engine active, but gateway routing was not refreshed.")
	).toBeVisible();
	expect(fixture.engineActive).toBe(IDS.engineNew);
	expect(
		callsFor(fixture, "POST", "/api/engine/active").map((call) => call.body)
	).toEqual([{ name: IDS.engineNew }, { name: IDS.engineNew }]);
	await page.reload();
	await page.getByRole("button", { name: "KoboldCPP Fixture" }).click();
	await expect(
		page.getByRole("switch", {
			name: "Set KoboldCPP Fixture as active engine",
		})
	).toBeChecked();
	await expect(
		page.getByText("Engine active, but gateway routing was not refreshed.")
	).toHaveCount(0);
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-engine-active-readback.png"),
	});
});

test("Image and speech sidecar switches retry start and stop, and running engines cannot be removed", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	await page
		.getByRole("button", { name: "Stable Diffusion CPP Fixture" })
		.click();
	const sidecarSwitch = page.getByRole("switch", {
		name: "Start or stop Stable Diffusion CPP Fixture",
	});
	await expect(sidecarSwitch).not.toBeChecked();
	fixture.engineActionFailures[`${IDS.mediaEngine}:start`] = 1;
	await sidecarSwitch.click();
	await expect(
		page.getByRole("dialog").getByText("Fixture start failed", { exact: true })
	).toBeVisible();
	await expect(sidecarSwitch).not.toBeChecked();
	const startGate = deferred();
	fixture.engineActionGates[`${IDS.mediaEngine}:start`] = startGate;
	await sidecarSwitch.click();
	await expect
		.poll(
			() =>
				callsFor(fixture, "POST", `/api/sidecar/${IDS.mediaEngine}/start`)
					.length
		)
		.toBe(2);
	await expect(sidecarSwitch).toBeDisabled();
	startGate.release();
	await expect(sidecarSwitch).toBeChecked();
	await expect(page.getByRole("button", { name: "Remove" })).toBeDisabled();
	expect(fixture.engineRunning[IDS.mediaEngine]).toBe(true);

	fixture.engineActionFailures[`${IDS.mediaEngine}:stop`] = 1;
	await sidecarSwitch.click();
	await expect(
		page.getByRole("dialog").getByText("Fixture stop failed", { exact: true })
	).toBeVisible();
	await expect(sidecarSwitch).toBeChecked();
	await sidecarSwitch.click();
	await expect(sidecarSwitch).not.toBeChecked();
	await expect(page.getByRole("button", { name: "Remove" })).toBeEnabled();
	expect(fixture.engineRunning[IDS.mediaEngine]).toBe(false);
	expect(
		callsFor(fixture, "POST", `/api/sidecar/${IDS.mediaEngine}/start`).map(
			(call) => call.body
		)
	).toEqual([null, null]);
	expect(
		callsFor(fixture, "POST", `/api/sidecar/${IDS.mediaEngine}/stop`).map(
			(call) => call.body
		)
	).toEqual([null, null]);
	await page.reload();
	await page
		.getByRole("button", { name: "Stable Diffusion CPP Fixture" })
		.click();
	await expect(
		page.getByRole("switch", {
			name: "Start or stop Stable Diffusion CPP Fixture",
		})
	).not.toBeChecked();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-engine-sidecar-stopped.png"),
	});
});

test("Image sidecar Add retries the exact local install and reads its installed state back", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	fixture.engineActionFailures[`${IDS.mediaNew}:install`] = 1;
	const sidecarCard = page
		.getByRole("button", { name: "Image Sidecar Candidate" })
		.locator("xpath=..");
	await sidecarCard.getByRole("button", { name: "Get" }).click();
	await expect(
		sidecarCard.getByText("Fixture install failed", { exact: true })
	).toBeVisible();
	expect(fixture.engineInstalled.has(IDS.mediaNew)).toBe(false);

	await page.getByRole("button", { name: "Image Sidecar Candidate" }).click();
	const details = page.getByRole("dialog").first();
	await expect(details).toContainText("Image Sidecar Candidate");
	await details.getByRole("button", { name: "Add", exact: true }).click();
	await expect(
		details.getByRole("button", { name: "Remove", exact: true })
	).toBeVisible();
	expect(fixture.engineInstalled.has(IDS.mediaNew)).toBe(true);
	expect(
		callsFor(fixture, "POST", `/api/setup/${IDS.mediaNew}/install`).map(
			(call) => ({ search: call.search, body: call.body })
		)
	).toEqual([
		{ search: "", body: null },
		{ search: "", body: null },
	]);
	await page.reload();
	await page.getByRole("button", { name: "Image Sidecar Candidate" }).click();
	await expect(
		page.getByRole("switch", {
			name: "Start or stop Image Sidecar Candidate",
		})
	).toBeEnabled();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-engine-sidecar-installed.png"
		),
	});
});

test("Engine card Manage and context actions open settings and recover sidecar failures", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	fixture.engineActionFailures[`${IDS.voiceEngine}:stop`] = 1;
	const voiceCard = page
		.getByRole("button", { name: "Pocket TTS Fixture" })
		.locator("xpath=..");
	await voiceCard.getByRole("button", { name: "Manage" }).click();
	await expect(page.getByRole("menuitem", { name: "Settings" })).toBeVisible();
	await expect(page.getByRole("menuitem", { name: "Stop" })).toBeVisible();
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-engine-manage-settings-stop.png"
		),
	});
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await expect
		.poll(async () => {
			const effects = storeEffectsSchema.parse(
				JSON.parse(
					await page.getByTestId("marketplace-home-effects").innerText()
				)
			);
			return effects.openedSettings;
		})
		.toEqual([IDS.voiceEngine]);

	await voiceCard.getByRole("button", { name: "Manage" }).click();
	await page.getByRole("menuitem", { name: "Stop" }).click();
	await expect(
		page.getByText("Fixture stop failed", { exact: true })
	).toBeVisible();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-engine-card-error.png"),
	});
	expect(fixture.engineRunning[IDS.voiceEngine]).toBe(true);
	await voiceCard.getByRole("button", { name: "Manage" }).click();
	await page.getByRole("menuitem", { name: "Stop" }).click();
	await expect.poll(() => fixture.engineRunning[IDS.voiceEngine]).toBe(false);

	await page
		.getByRole("button", { name: "Pocket TTS Fixture" })
		.click({ button: "right" });
	await expect(page.getByRole("menuitem", { name: "Start" })).toBeVisible();
	await expect(page.getByRole("menuitem", { name: "Remove" })).toBeVisible();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	await expect
		.poll(async () => {
			const effects = storeEffectsSchema.parse(
				JSON.parse(
					await page.getByTestId("marketplace-home-effects").innerText()
				)
			);
			return effects.openedSettings;
		})
		.toEqual([IDS.voiceEngine, IDS.voiceEngine]);
	await page
		.getByRole("button", { name: "Pocket TTS Fixture" })
		.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Start" }).click();
	await expect.poll(() => fixture.engineRunning[IDS.voiceEngine]).toBe(true);
	expect(
		callsFor(fixture, "POST", `/api/sidecar/${IDS.voiceEngine}/stop`).map(
			(call) => call.body
		)
	).toEqual([null, null]);
	expect(
		callsFor(fixture, "POST", `/api/sidecar/${IDS.voiceEngine}/start`).map(
			(call) => call.body
		)
	).toEqual([null]);
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Pocket TTS Fixture" }).locator("xpath=..")
	).toContainText("Installed");
});

test("Sandbox default selection retries the exact backend and unsupported/default controls stay disabled", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	await page.getByRole("button", { name: "WasmTime Fixture" }).click();
	await expect(
		page.getByRole("switch", {
			name: "Set WasmTime Fixture as the default sandbox backend",
		})
	).toBeDisabled();
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await page.getByRole("button", { name: "OpenSandbox Fixture" }).click();
	await expect(
		page.getByRole("switch", {
			name: "Set OpenSandbox Fixture as the default sandbox backend",
		})
	).toBeDisabled();
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await page.getByRole("button", { name: "Docker Fixture" }).click();
	const defaultSwitch = page.getByRole("switch", {
		name: "Set Docker Fixture as the default sandbox backend",
	});
	fixture.sandboxSetFailures = 1;
	await defaultSwitch.click();
	await expect(
		page
			.getByRole("dialog")
			.getByText("/api/sandbox/backend failed: 503", { exact: true })
	).toBeVisible();
	const gate = deferred();
	fixture.sandboxSetGate = gate;
	await defaultSwitch.click();
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/sandbox/backend").length)
		.toBe(2);
	await expect(defaultSwitch).toBeDisabled();
	gate.release();
	await expect(defaultSwitch).toBeChecked();
	expect(fixture.sandboxDefault).toBe("docker");
	expect(
		callsFor(fixture, "POST", "/api/sandbox/backend").map((call) => call.body)
	).toEqual([{ name: "docker" }, { name: "docker" }]);
	await page.reload();
	await page.getByRole("button", { name: "Docker Fixture" }).click();
	await expect(
		page.getByRole("switch", {
			name: "Set Docker Fixture as the default sandbox backend",
		})
	).toBeChecked();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-sandbox-default-readback.png"
		),
	});
});

test("llama.cpp acceleration selection reports failure, locks while switching, and reads back the exact build", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	await page.getByRole("button", { name: "llama.cpp" }).click();
	const auto = page.getByRole("radio", { name: /Automatic/ });
	const metal = page.getByRole("radio", { name: "Metal" });
	const cuda = page.getByRole("radio", { name: "CUDA" });
	await expect(auto).toBeChecked();
	await expect(metal).toBeEnabled();
	await expect(cuda).toBeDisabled();
	fixture.accelerationFailures = 1;
	await metal.click();
	await expect(
		page.getByText("/api/engine/llamacpp/acceleration failed: 503", {
			exact: true,
		})
	).toBeVisible();
	await expect(auto).toBeChecked();
	const gate = deferred();
	fixture.accelerationGate = gate;
	await metal.click();
	await expect(
		page.getByText("Downloading and switching the build…", { exact: true })
	).toBeVisible();
	await expect(auto).toBeDisabled();
	await expect(metal).toBeDisabled();
	gate.release();
	await expect(metal).toBeChecked();
	await expect(
		page.getByText("Right now this engine runs on Metal.")
	).toBeVisible();
	expect(fixture.acceleration.selected).toBe("metal");
	expect(
		callsFor(fixture, "POST", "/api/engine/llamacpp/acceleration").map(
			(call) => call.body
		)
	).toEqual([{ variant: "metal" }, { variant: "metal" }]);
	await page.reload();
	await page.getByRole("button", { name: "llama.cpp" }).click();
	await expect(page.getByRole("radio", { name: "Metal" })).toBeChecked();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-engine-acceleration-readback.png"
		),
	});
});
