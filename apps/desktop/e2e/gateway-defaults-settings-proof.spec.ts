import path from "node:path";
import { expect, test } from "@playwright/test";

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
}

interface ProofSnapshot {
	preferences: Record<string, string>;
	requests: CapturedRequest[];
}

interface DefaultsProofWindow extends Window {
	__gatewayDefaultsProof: {
		armNextPreferenceWriteFailure: (key: string) => void;
		snapshot: () => ProofSnapshot;
	};
}

const LOCAL_SELECTION_KEY = "default-local-agent-selection";
const CLOUD_SELECTION_KEY = "default-cloud-agent-selection";
const IDLE_SECONDS_KEY = "engine.llamacpp.sleep-idle-seconds";
const INITIAL_LOCAL_SELECTION = {
	agent_id: "ryu",
	provider: "local",
	model: "gemma-4-E2B-it-Q4_K_M",
	thinking_level: "",
	effort: "",
	access_mode: "",
};
const UPDATED_LOCAL_SELECTION = {
	...INITIAL_LOCAL_SELECTION,
	model: "qwen3.5-4b-instruct-q4_K_M",
};
const UPDATED_CLOUD_SELECTION = {
	agent_id: "ryu",
	provider: "managed-openrouter",
	model: "anthropic/claude-sonnet-4",
	thinking_level: "",
	effort: "",
	access_mode: "",
};
const CUSTOM_LOCAL_MODEL_SELECTION = {
	agent_id: "",
	provider: "",
	model: "coverage-local-model-not-in-catalog",
	thinking_level: "",
	effort: "",
	access_mode: "",
};

function evidencePath(name: string): string {
	return path.resolve(
		import.meta.dirname,
		`../../../docs/proof/test-coverage-sweep-20260924/evidence/${name}.png`
	);
}

async function openDefaults(
	page: import("@playwright/test").Page,
	query = ""
): Promise<void> {
	const separator = query ? "&" : "?";
	await page.goto(
		`/gateway-defaults-settings-proof.html${query}${separator}reset=true`
	);
	await waitForDefaults(page);
}

async function waitForDefaults(
	page: import("@playwright/test").Page,
	idleLabel = "5 minutes"
): Promise<void> {
	await expect(
		page.getByRole("heading", { name: "Default agents & models" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Default local agent or model" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Default cloud agent or model" })
	).toBeVisible();
	await expect(autoUnloadSelect(page)).toContainText(idleLabel);
}

function autoUnloadSelect(page: import("@playwright/test").Page) {
	return page.getByRole("combobox", { name: "Auto-unload local model" });
}

async function readProof(page: import("@playwright/test").Page) {
	return page.evaluate(() =>
		/* SAFETY: gateway-defaults-settings-proof.tsx installs __gatewayDefaultsProof before this proof page is evaluated. */ (
			window as DefaultsProofWindow
		).__gatewayDefaultsProof.snapshot()
	);
}

async function chooseProviderModel(
	page: import("@playwright/test").Page,
	buttonName: string,
	providerName: string,
	modelId: string
): Promise<void> {
	await page.getByRole("button", { name: buttonName }).click();
	const picker = page.getByRole("dialog");
	await expect(picker).toBeVisible();
	await picker.getByText(providerName, { exact: true }).click();
	await picker.getByText("Model", { exact: true }).click();
	await picker.getByText(modelId, { exact: true }).click();
	await expect(
		page.getByRole("heading", { name: providerName, exact: true })
	).toHaveCount(0);
}

function writesFor(snapshot: ProofSnapshot, key: string): CapturedRequest[] {
	return snapshot.requests.filter(
		(request) =>
			request.path.endsWith(`/api/preferences/${key}`) &&
			request.method === "PUT"
	);
}

function readsFor(snapshot: ProofSnapshot, key: string): CapturedRequest[] {
	return snapshot.requests.filter(
		(request) =>
			request.path.endsWith(`/api/preferences/${key}`) &&
			request.method === "GET"
	);
}

test.describe.configure({ timeout: 90_000 });

test("saves local and managed Bot realm defaults with their full selection and reloads both", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await openDefaults(page);
	await expect(
		page.getByRole("button", { name: "Default local agent or model" })
	).toContainText("gemma-4-E2B-it-Q4_K_M");

	await expect(page.getByTestId("bot-realm-default-card")).toContainText(
		"Console owners and admins can choose the provider and model"
	);
	await expect(
		page.getByRole("button", { name: "Default cloud agent or model" })
	).toContainText("Ryu");
	const loaded = await readProof(page);
	for (const key of [
		LOCAL_SELECTION_KEY,
		CLOUD_SELECTION_KEY,
		IDLE_SECONDS_KEY,
	]) {
		expect(readsFor(loaded, key)).toEqual([
			{ body: null, method: "GET", path: `/api/preferences/${key}` },
		]);
	}
	expect(loaded.preferences[LOCAL_SELECTION_KEY]).toBe(
		JSON.stringify(INITIAL_LOCAL_SELECTION)
	);
	expect(loaded.preferences[CLOUD_SELECTION_KEY]).toBeUndefined();
	expect(loaded.preferences[IDLE_SECONDS_KEY]).toBe("300");

	await chooseProviderModel(
		page,
		"Default local agent or model",
		"Local",
		"qwen3.5-4b-instruct-q4_K_M"
	);
	await expect(
		page.getByRole("button", { name: "Default local agent or model" })
	).toContainText("qwen3.5-4b-instruct-q4_K_M");
	await expect
		.poll(async () => writesFor(await readProof(page), LOCAL_SELECTION_KEY))
		.toEqual([
			{
				body: { value: JSON.stringify(UPDATED_LOCAL_SELECTION) },
				method: "PUT",
				path: `/api/preferences/${LOCAL_SELECTION_KEY}`,
			},
		]);
	const localSnapshot = await readProof(page);
	expect(writesFor(localSnapshot, LOCAL_SELECTION_KEY)).toEqual([
		{
			body: { value: JSON.stringify(UPDATED_LOCAL_SELECTION) },
			method: "PUT",
			path: `/api/preferences/${LOCAL_SELECTION_KEY}`,
		},
	]);
	expect(localSnapshot.preferences[LOCAL_SELECTION_KEY]).toBe(
		JSON.stringify(UPDATED_LOCAL_SELECTION)
	);

	await chooseProviderModel(
		page,
		"Default cloud agent or model",
		"Auto cloud",
		"anthropic/claude-sonnet-4"
	);
	await expect(
		page.getByRole("button", { name: "Default cloud agent or model" })
	).toContainText("anthropic/claude-sonnet-4");
	await expect
		.poll(async () => writesFor(await readProof(page), CLOUD_SELECTION_KEY))
		.toEqual([
			{
				body: { value: JSON.stringify(UPDATED_CLOUD_SELECTION) },
				method: "PUT",
				path: `/api/preferences/${CLOUD_SELECTION_KEY}`,
			},
		]);
	const savedSnapshot = await readProof(page);
	expect(writesFor(savedSnapshot, CLOUD_SELECTION_KEY)).toEqual([
		{
			body: { value: JSON.stringify(UPDATED_CLOUD_SELECTION) },
			method: "PUT",
			path: `/api/preferences/${CLOUD_SELECTION_KEY}`,
		},
	]);

	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-defaults-saved-rendered"),
	});
	await page.reload();
	await waitForDefaults(page);
	await expect(
		page.getByRole("button", { name: "Default local agent or model" })
	).toContainText("qwen3.5-4b-instruct-q4_K_M");
	await expect(
		page.getByRole("button", { name: "Default cloud agent or model" })
	).toContainText("anthropic/claude-sonnet-4");
	const reloaded = await readProof(page);
	expect(reloaded.preferences[LOCAL_SELECTION_KEY]).toBe(
		JSON.stringify(UPDATED_LOCAL_SELECTION)
	);
	expect(reloaded.preferences[CLOUD_SELECTION_KEY]).toBe(
		JSON.stringify(UPDATED_CLOUD_SELECTION)
	);

	for (const [buttonName, key] of [
		["Default local agent or model", LOCAL_SELECTION_KEY],
		["Default cloud agent or model", CLOUD_SELECTION_KEY],
	] as const) {
		await page.getByRole("button", { name: buttonName }).click();
		await page
			.getByRole("dialog")
			.getByText("Use the default", { exact: true })
			.click();
		await expect(page.getByRole("button", { name: buttonName })).toBeVisible();
		await expect
			.poll(async () => writesFor(await readProof(page), key))
			.toHaveLength(1);
	}
	const cleared = await readProof(page);
	expect(cleared.preferences[LOCAL_SELECTION_KEY]).toBe("");
	expect(cleared.preferences[CLOUD_SELECTION_KEY]).toBe("");
	await expect(
		page.getByRole("button", { name: "Default local agent or model" })
	).toContainText("Ryu · local · Gemma 4");
	await expect(
		page.getByRole("button", { name: "Default cloud agent or model" })
	).toContainText("openrouter/auto");

	await page
		.getByRole("button", { name: "Default local agent or model" })
		.click();
	const localPicker = page.getByRole("dialog");
	await localPicker
		.getByRole("textbox", { name: "Custom model id" })
		.fill(CUSTOM_LOCAL_MODEL_SELECTION.model);
	await localPicker.getByRole("button", { name: "Use this model" }).click();
	await expect(
		page.getByRole("button", { name: "Default local agent or model" })
	).toContainText(CUSTOM_LOCAL_MODEL_SELECTION.model);
	await expect
		.poll(async () => writesFor(await readProof(page), LOCAL_SELECTION_KEY))
		.toEqual([
			{
				body: { value: "" },
				method: "PUT",
				path: `/api/preferences/${LOCAL_SELECTION_KEY}`,
			},
			{
				body: { value: JSON.stringify(CUSTOM_LOCAL_MODEL_SELECTION) },
				method: "PUT",
				path: `/api/preferences/${LOCAL_SELECTION_KEY}`,
			},
		]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-defaults-custom-local-model-rendered"),
	});
	await page.reload();
	await waitForDefaults(page);
	await expect(
		page.getByRole("button", { name: "Default local agent or model" })
	).toContainText(CUSTOM_LOCAL_MODEL_SELECTION.model);
	expect(pageErrors).toEqual([]);
});

test("stores auto-unload as seconds and restores the persisted llama.cpp choice on reload", async ({
	page,
}) => {
	await openDefaults(page);
	const trigger = autoUnloadSelect(page);
	await trigger.click();
	await expect(page.getByRole("option")).toHaveCount(6);
	expect(await page.getByRole("option").allTextContents()).toEqual([
		"Never",
		"1 minute",
		"5 minutes",
		"15 minutes",
		"30 minutes",
		"1 hour",
	]);
	await page.getByRole("option", { name: "Never", exact: true }).click();
	await expect(trigger).toContainText("Never");
	await expect
		.poll(async () => writesFor(await readProof(page), IDLE_SECONDS_KEY))
		.toEqual([
			{
				body: { value: "0" },
				method: "PUT",
				path: `/api/preferences/${IDLE_SECONDS_KEY}`,
			},
		]);

	let snapshot = await readProof(page);
	expect(writesFor(snapshot, IDLE_SECONDS_KEY)).toEqual([
		{
			body: { value: "0" },
			method: "PUT",
			path: `/api/preferences/${IDLE_SECONDS_KEY}`,
		},
	]);
	await page.reload();
	await waitForDefaults(page, "Never");
	await expect(autoUnloadSelect(page)).toContainText("Never");
	snapshot = await readProof(page);
	expect(snapshot.preferences[IDLE_SECONDS_KEY]).toBe("0");
});

test("rolls failed lane and auto-unload writes back to saved values and allows retry", async ({
	page,
}) => {
	await openDefaults(page, "?holdStatusPoll=true");
	await page.evaluate((key) => {
		/* SAFETY: gateway-defaults-settings-proof.tsx installs __gatewayDefaultsProof before this proof page is evaluated. */ (
			window as DefaultsProofWindow
		).__gatewayDefaultsProof.armNextPreferenceWriteFailure(key);
	}, LOCAL_SELECTION_KEY);
	await chooseProviderModel(
		page,
		"Default local agent or model",
		"Local",
		"qwen3.5-4b-instruct-q4_K_M"
	);
	const localTrigger = page.getByRole("button", {
		name: "Default local agent or model",
	});
	await expect(localTrigger).toContainText("gemma-4-E2B-it-Q4_K_M");
	await expect(page.getByText("Couldn't save the default")).toBeVisible();
	let snapshot = await readProof(page);
	expect(snapshot.preferences[LOCAL_SELECTION_KEY]).toBe(
		JSON.stringify(INITIAL_LOCAL_SELECTION)
	);
	expect(writesFor(snapshot, LOCAL_SELECTION_KEY)).toEqual([
		{
			body: { value: JSON.stringify(UPDATED_LOCAL_SELECTION) },
			method: "PUT",
			path: `/api/preferences/${LOCAL_SELECTION_KEY}`,
		},
	]);

	await chooseProviderModel(
		page,
		"Default local agent or model",
		"Local",
		"qwen3.5-4b-instruct-q4_K_M"
	);
	await expect(localTrigger).toContainText("qwen3.5-4b-instruct-q4_K_M");
	const updatedLocalWrite = {
		body: { value: JSON.stringify(UPDATED_LOCAL_SELECTION) },
		method: "PUT",
		path: `/api/preferences/${LOCAL_SELECTION_KEY}`,
	};
	await expect
		.poll(async () => writesFor(await readProof(page), LOCAL_SELECTION_KEY))
		.toEqual([updatedLocalWrite, updatedLocalWrite]);
	snapshot = await readProof(page);
	expect(writesFor(snapshot, LOCAL_SELECTION_KEY)).toEqual([
		updatedLocalWrite,
		updatedLocalWrite,
	]);

	await page.evaluate((key) => {
		/* SAFETY: gateway-defaults-settings-proof.tsx installs __gatewayDefaultsProof before this proof page is evaluated. */ (
			window as DefaultsProofWindow
		).__gatewayDefaultsProof.armNextPreferenceWriteFailure(key);
	}, CLOUD_SELECTION_KEY);
	await chooseProviderModel(
		page,
		"Default cloud agent or model",
		"Auto cloud",
		"anthropic/claude-sonnet-4"
	);
	const cloudTrigger = page.getByRole("button", {
		name: "Default cloud agent or model",
	});
	await expect(cloudTrigger).toContainText("openrouter/auto");
	await expect(page.getByText("Couldn't save the default")).toBeVisible();
	const updatedCloudWrite = {
		body: { value: JSON.stringify(UPDATED_CLOUD_SELECTION) },
		method: "PUT",
		path: `/api/preferences/${CLOUD_SELECTION_KEY}`,
	};
	snapshot = await readProof(page);
	expect(snapshot.preferences[CLOUD_SELECTION_KEY]).toBeUndefined();
	expect(writesFor(snapshot, CLOUD_SELECTION_KEY)).toEqual([updatedCloudWrite]);

	await chooseProviderModel(
		page,
		"Default cloud agent or model",
		"Auto cloud",
		"anthropic/claude-sonnet-4"
	);
	await expect(cloudTrigger).toContainText("anthropic/claude-sonnet-4");
	await expect
		.poll(async () => writesFor(await readProof(page), CLOUD_SELECTION_KEY))
		.toEqual([updatedCloudWrite, updatedCloudWrite]);
	snapshot = await readProof(page);
	expect(snapshot.preferences[CLOUD_SELECTION_KEY]).toBe(
		JSON.stringify(UPDATED_CLOUD_SELECTION)
	);

	const trigger = autoUnloadSelect(page);
	await page.evaluate((key) => {
		/* SAFETY: gateway-defaults-settings-proof.tsx installs __gatewayDefaultsProof before this proof page is evaluated. */ (
			window as DefaultsProofWindow
		).__gatewayDefaultsProof.armNextPreferenceWriteFailure(key);
	}, IDLE_SECONDS_KEY);
	await trigger.click();
	await page.getByRole("option", { name: "Never", exact: true }).click();
	await expect(trigger).toContainText("5 minutes");
	await expect(
		page.getByText("Couldn't save the auto-unload setting")
	).toBeVisible();
	snapshot = await readProof(page);
	expect(snapshot.preferences[IDLE_SECONDS_KEY]).toBe("300");
	expect(writesFor(snapshot, IDLE_SECONDS_KEY)).toEqual([
		{
			body: { value: "0" },
			method: "PUT",
			path: `/api/preferences/${IDLE_SECONDS_KEY}`,
		},
	]);

	await trigger.click();
	await page.getByRole("option", { name: "Never", exact: true }).click();
	await expect(trigger).toContainText("Never");
	const neverWrite = {
		body: { value: "0" },
		method: "PUT",
		path: `/api/preferences/${IDLE_SECONDS_KEY}`,
	};
	await expect
		.poll(async () => writesFor(await readProof(page), IDLE_SECONDS_KEY))
		.toEqual([neverWrite, neverWrite]);
	snapshot = await readProof(page);
	expect(snapshot.preferences[LOCAL_SELECTION_KEY]).toBe(
		JSON.stringify(UPDATED_LOCAL_SELECTION)
	);
	expect(snapshot.preferences[IDLE_SECONDS_KEY]).toBe("0");
	expect(writesFor(snapshot, LOCAL_SELECTION_KEY)).toHaveLength(2);
	expect(writesFor(snapshot, IDLE_SECONDS_KEY)).toEqual([
		neverWrite,
		neverWrite,
	]);
});

test("disables lane-default changes without gateway.configure while preserving the device auto-unload control", async ({
	page,
}) => {
	await openDefaults(page, "?permission=denied");
	const local = page.getByRole("button", {
		name: "Default local agent or model",
	});
	const cloud = page.getByRole("button", {
		name: "Default cloud agent or model",
	});
	await expect(local).toBeDisabled();
	await expect(cloud).toBeDisabled();
	await expect(
		page.getByText(
			"Only organization owners and admins can change the local or Bot realm default."
		)
	).toBeVisible();
	await expect(autoUnloadSelect(page)).toBeEnabled();

	const before = await readProof(page);
	await local.click({ force: true });
	await cloud.click({ force: true });
	expect(writesFor(before, LOCAL_SELECTION_KEY)).toHaveLength(0);
	expect(writesFor(before, CLOUD_SELECTION_KEY)).toHaveLength(0);

	const idle = autoUnloadSelect(page);
	await idle.click();
	await page.getByRole("option", { name: "15 minutes", exact: true }).click();
	await expect(idle).toContainText("15 minutes");
	await expect
		.poll(async () => writesFor(await readProof(page), IDLE_SECONDS_KEY))
		.toEqual([
			{
				body: { value: "900" },
				method: "PUT",
				path: `/api/preferences/${IDLE_SECONDS_KEY}`,
			},
		]);
	const after = await readProof(page);
	expect(writesFor(after, LOCAL_SELECTION_KEY)).toHaveLength(0);
	expect(writesFor(after, CLOUD_SELECTION_KEY)).toHaveLength(0);
	expect(writesFor(after, IDLE_SECONDS_KEY)).toEqual([
		{
			body: { value: "900" },
			method: "PUT",
			path: `/api/preferences/${IDLE_SECONDS_KEY}`,
		},
	]);
});
