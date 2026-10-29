import { expect, test } from "@playwright/test";

const STORY_URL = "/plugin-settings-fields-proof.html?reset=true";

interface RequestRecord {
	body: unknown;
	method: string;
	path: string;
}

interface ProofSnapshot {
	externalRequests: string[];
	preferences: Record<string, string>;
	requests: RequestRecord[];
	secretStates: Record<
		string,
		{ readable: boolean; set: boolean; updated_at: number | null }
	>;
}

async function proofSnapshot(page: import("@playwright/test").Page) {
	return await page.evaluate(() =>
		/* SAFETY: plugin-settings-fields-proof.tsx installs __pluginSettingsFieldsProof before this proof page is evaluated. */ (
			window as Window & {
				__pluginSettingsFieldsProof: { snapshot: () => ProofSnapshot };
			}
		).__pluginSettingsFieldsProof.snapshot()
	);
}

async function openSettings(
	page: import("@playwright/test").Page,
	{ holdSecretRead = false }: { holdSecretRead?: boolean } = {}
) {
	const browserErrors: string[] = [];
	const externalRequests: string[] = [];
	await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => browserErrors.push(error.message));
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (
			(url.protocol === "http:" || url.protocol === "https:") &&
			url.origin !== "http://127.0.0.1:5247"
		) {
			externalRequests.push(request.url());
		}
	});
	const url = holdSecretRead ? `${STORY_URL}&holdSecretRead=true` : STORY_URL;
	await page.goto(url, { waitUntil: "commit", timeout: 120_000 });
	await page.waitForFunction(
		() => document.body.dataset.harnessReady === "1",
		null,
		{ timeout: 30_000 }
	);
	return { browserErrors, externalRequests };
}

async function clearRequestLog(page: import("@playwright/test").Page) {
	await page.evaluate(() =>
		/* SAFETY: plugin-settings-fields-proof.tsx installs __pluginSettingsFieldsProof before this proof page is evaluated. */ (
			window as Window & {
				__pluginSettingsFieldsProof: { clearRequestLog: () => void };
			}
		).__pluginSettingsFieldsProof.clearRequestLog()
	);
}

async function armFailure(
	page: import("@playwright/test").Page,
	method: string,
	path: string
) {
	await page.evaluate(
		({ failureMethod, failurePath }) =>
			/* SAFETY: plugin-settings-fields-proof.tsx installs __pluginSettingsFieldsProof before this proof page is evaluated. */ (
				window as Window & {
					__pluginSettingsFieldsProof: {
						armFailure: (method: string, path: string) => void;
					};
				}
			).__pluginSettingsFieldsProof.armFailure(failureMethod, failurePath),
		{ failureMethod: method, failurePath: path }
	);
}

test("persists preference fields as exact strings and reads them back after reload", async ({
	page,
}, testInfo) => {
	const { browserErrors, externalRequests } = await openSettings(page);
	const enabled = page.getByRole("switch", { name: "Enable fixture feature" });
	await expect(enabled).toHaveAttribute("aria-checked", "false");
	await clearRequestLog(page);
	await enabled.click();
	await expect(enabled).toHaveAttribute("aria-checked", "true");

	const mode = page.getByRole("combobox", { name: "Output mode" });
	await mode.click();
	await page.getByRole("option", { name: "Strict", exact: true }).click();
	await expect(mode).toContainText("Strict");

	const endpoint = page.getByRole("textbox", { name: "Service endpoint" });
	await endpoint.fill("  https://new.fixture.local/api  ");
	await endpoint.press("Tab");
	await expect(endpoint).toHaveValue("  https://new.fixture.local/api  ");

	const instructions = page.getByRole("textbox", {
		name: "System instructions",
	});
	await instructions.fill("  Summarize fixture data only.  ");
	await instructions.press("Tab");

	const attempts = page.getByRole("spinbutton", { name: "Max attempts" });
	await attempts.fill("7");
	await attempts.press("Tab");
	await expect(attempts).toHaveValue("7");
	const validWriteCount = (await proofSnapshot(page)).requests.filter(
		(request) =>
			request.path === "/api/preferences/proof.retry-count" &&
			request.method === "PUT"
	).length;
	await attempts.fill("11");
	await attempts.press("Tab");
	await expect(attempts).toHaveValue("7");
	const afterOutOfRange = await proofSnapshot(page);
	expect(
		afterOutOfRange.requests.filter(
			(request) =>
				request.path === "/api/preferences/proof.retry-count" &&
				request.method === "PUT"
		).length
	).toBe(validWriteCount);
	await attempts.fill("8");
	await attempts.press("Tab");
	await expect(attempts).toHaveValue("7");
	expect(
		(await proofSnapshot(page)).requests.filter(
			(request) =>
				request.path === "/api/preferences/proof.retry-count" &&
				request.method === "PUT"
		).length
	).toBe(validWriteCount);

	const emptySelectFallback = page.getByRole("textbox", {
		name: "Empty-select fallback",
	});
	await emptySelectFallback.fill("  fallback stays editable  ");
	await emptySelectFallback.press("Tab");
	const unknownTypeFallback = page.getByRole("textbox", {
		name: "Future field fallback",
	});
	await unknownTypeFallback.fill("unknown types remain usable");
	await unknownTypeFallback.press("Tab");

	const { preferences, requests } = await proofSnapshot(page);
	expect(preferences).toMatchObject({
		"proof.enabled": "true",
		"proof.mode": "strict",
		"proof.summary": "https://new.fixture.local/api",
		"proof.instructions": "Summarize fixture data only.",
		"proof.retry-count": "7",
		"proof.empty-select": "fallback stays editable",
		"proof.future-field": "unknown types remain usable",
	});
	expect(requests).toEqual(
		expect.arrayContaining([
			{
				method: "PUT",
				path: "/api/preferences/proof.enabled",
				body: { value: "true" },
			},
			{
				method: "PUT",
				path: "/api/preferences/proof.mode",
				body: { value: "strict" },
			},
			{
				method: "PUT",
				path: "/api/preferences/proof.summary",
				body: { value: "https://new.fixture.local/api" },
			},
			{
				method: "PUT",
				path: "/api/preferences/proof.instructions",
				body: { value: "Summarize fixture data only." },
			},
			{
				method: "PUT",
				path: "/api/preferences/proof.retry-count",
				body: { value: "7" },
			},
			{
				method: "PUT",
				path: "/api/preferences/proof.empty-select",
				body: { value: "fallback stays editable" },
			},
			{
				method: "PUT",
				path: "/api/preferences/proof.future-field",
				body: { value: "unknown types remain usable" },
			},
		])
	);
	expect(externalRequests).toEqual([]);

	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(
		page.getByRole("switch", { name: "Enable fixture feature" })
	).toHaveAttribute("aria-checked", "true");
	await expect(
		page.getByRole("combobox", { name: "Output mode" })
	).toContainText("Strict");
	await expect(
		page.getByRole("textbox", { name: "Service endpoint" })
	).toHaveValue("https://new.fixture.local/api");
	await expect(
		page.getByRole("textbox", { name: "System instructions" })
	).toHaveValue("Summarize fixture data only.");
	await expect(
		page.getByRole("spinbutton", { name: "Max attempts" })
	).toHaveValue("7");
	await expect(emptySelectFallback).toHaveValue("fallback stays editable");
	await expect(unknownTypeFallback).toHaveValue("unknown types remain usable");
	await page.screenshot({
		path: testInfo.outputPath("desktop-plugin-settings-fields-persisted.png"),
		fullPage: true,
	});
	expect(browserErrors).toEqual([]);
});

test("rolls back failed preference writes, shows an error, and retries with the same field value", async ({
	page,
}) => {
	const { browserErrors, externalRequests } = await openSettings(page);
	await clearRequestLog(page);
	const enabled = page.getByRole("switch", { name: "Enable fixture feature" });
	await armFailure(page, "PUT", "/api/preferences/proof.enabled");
	await enabled.click();
	await expect(
		page.getByText("Couldn't save this setting", { exact: true })
	).toBeVisible();
	await expect(enabled).toHaveAttribute("aria-checked", "false");
	await expect((await proofSnapshot(page)).preferences).not.toHaveProperty(
		"proof.enabled"
	);

	await enabled.click();
	await expect(enabled).toHaveAttribute("aria-checked", "true");
	await expect((await proofSnapshot(page)).preferences["proof.enabled"]).toBe(
		"true"
	);

	const mode = page.getByRole("combobox", { name: "Output mode" });
	await armFailure(page, "PUT", "/api/preferences/proof.mode");
	await mode.click();
	await page.getByRole("option", { name: "Strict", exact: true }).click();
	await expect(
		page.getByText("Couldn't save this setting", { exact: true })
	).toBeVisible();
	await expect(mode).toContainText("Standard");
	await expect((await proofSnapshot(page)).preferences["proof.mode"]).toBe(
		"standard"
	);

	await mode.click();
	await page.getByRole("option", { name: "Strict", exact: true }).click();
	await expect(mode).toContainText("Strict");
	await expect((await proofSnapshot(page)).preferences["proof.mode"]).toBe(
		"strict"
	);

	const endpoint = page.getByRole("textbox", { name: "Service endpoint" });
	await armFailure(page, "PUT", "/api/preferences/proof.summary");
	await endpoint.fill("  https://retry.fixture.local  ");
	await endpoint.press("Tab");
	await expect(
		page.getByText("Couldn't save this setting", { exact: true })
	).toBeVisible();
	await expect(endpoint).toHaveValue("  https://retry.fixture.local  ");
	await expect((await proofSnapshot(page)).preferences["proof.summary"]).toBe(
		"Existing endpoint"
	);
	await endpoint.press("Tab");
	await expect((await proofSnapshot(page)).preferences["proof.summary"]).toBe(
		"https://retry.fixture.local"
	);
	const writes = (await proofSnapshot(page)).requests.filter(
		(request) =>
			request.method === "PUT" &&
			[
				"/api/preferences/proof.enabled",
				"/api/preferences/proof.mode",
				"/api/preferences/proof.summary",
			].includes(request.path)
	);
	expect(writes).toHaveLength(6);
	expect(externalRequests).toEqual([]);
	expect(browserErrors).toEqual([]);
});

test("stores secrets write-only, ignores a late stale read, retries clear, and reloads state", async ({
	page,
}, testInfo) => {
	const { browserErrors, externalRequests } = await openSettings(page, {
		holdSecretRead: true,
	});
	await expect
		.poll(async () => {
			const proof = await proofSnapshot(page);
			return proof.requests.some(
				(request) =>
					request.method === "GET" &&
					request.path === "/api/plugins/com.ryu.proof/secrets"
			);
		})
		.toBe(true);
	await clearRequestLog(page);
	const token = page.getByRole("textbox", { name: "API token" });
	const save = page.getByRole("button", { name: "Save", exact: true });
	await expect(save).toBeDisabled();
	await token.fill("plugin-settings-proof-secret");
	await expect(save).toBeEnabled();
	await armFailure(
		page,
		"PUT",
		"/api/plugins/com.ryu.proof/secrets/RYU_PLUGIN_PROOF_API_KEY"
	);
	await save.click();
	await expect(
		page.getByText("Couldn't save this secret", { exact: true })
	).toBeVisible();
	await expect(token).toHaveValue("plugin-settings-proof-secret");
	await expect(save).toBeEnabled();
	await save.click();
	await expect(save).toBeDisabled();
	await expect(token).toHaveValue("");
	await expect(token).toHaveAttribute("type", "password");
	await expect(token).toHaveAttribute(
		"placeholder",
		"Stored — enter a new value to replace"
	);
	await expect(page.getByText(/Set ·/)).toBeVisible();
	const wroteSecret = await proofSnapshot(page);
	expect(wroteSecret.secretStates.RYU_PLUGIN_PROOF_API_KEY).toMatchObject({
		readable: true,
		set: true,
	});
	await page.evaluate(() =>
		/* SAFETY: plugin-settings-fields-proof.tsx installs __pluginSettingsFieldsProof before this proof page is evaluated. */ (
			window as Window & {
				__pluginSettingsFieldsProof: { releaseSecretRead: () => void };
			}
		).__pluginSettingsFieldsProof.releaseSecretRead()
	);
	await expect(token).toHaveAttribute(
		"placeholder",
		"Stored — enter a new value to replace"
	);
	await expect(
		page.getByText("plugin-settings-proof-secret", { exact: true })
	).toHaveCount(0);
	const afterSave = await proofSnapshot(page);
	expect(afterSave.secretStates.RYU_PLUGIN_PROOF_API_KEY).toMatchObject({
		readable: true,
		set: true,
	});
	const secretWrites = afterSave.requests.filter(
		(request) =>
			request.method === "PUT" &&
			request.path ===
				"/api/plugins/com.ryu.proof/secrets/RYU_PLUGIN_PROOF_API_KEY"
	);
	expect(secretWrites).toEqual([
		{
			method: "PUT",
			path: "/api/plugins/com.ryu.proof/secrets/RYU_PLUGIN_PROOF_API_KEY",
			body: { value: "plugin-settings-proof-secret" },
		},
		{
			method: "PUT",
			path: "/api/plugins/com.ryu.proof/secrets/RYU_PLUGIN_PROOF_API_KEY",
			body: { value: "plugin-settings-proof-secret" },
		},
	]);
	expect(afterSave.requests).toContainEqual({
		method: "PUT",
		path: "/api/plugins/com.ryu.proof/secrets/RYU_PLUGIN_PROOF_API_KEY",
		body: { value: "plugin-settings-proof-secret" },
	});

	await page.reload({ waitUntil: "domcontentloaded" });
	const reloadedToken = page.getByRole("textbox", { name: "API token" });
	await expect(reloadedToken).toHaveValue("");
	await expect(reloadedToken).toHaveAttribute(
		"placeholder",
		"Stored — enter a new value to replace"
	);
	await expect(page.getByText(/Set ·/)).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("desktop-plugin-settings-secret-stored.png"),
		fullPage: true,
	});

	await armFailure(
		page,
		"DELETE",
		"/api/plugins/com.ryu.proof/secrets/RYU_PLUGIN_PROOF_API_KEY"
	);
	await page.getByRole("button", { name: "Clear", exact: true }).click();
	await expect(
		page.getByText("Couldn't clear this secret", { exact: true })
	).toBeVisible();
	await expect(page.getByText(/Set ·/)).toBeVisible();
	await page.getByRole("button", { name: "Clear", exact: true }).click();
	await expect(page.getByText("Not set", { exact: true })).toBeVisible();
	// The successful Clear removes its button, leaving the pointer where the
	// bottom-right toast stack grows. A hovered sileo toast pauses every
	// dismissal timer, so park the pointer off the stack before waiting for the
	// failure toast's own lifetime to end.
	await page.mouse.move(0, 0);
	await expect(
		page.getByText("Couldn't clear this secret", { exact: true })
	).toBeHidden({ timeout: 10_000 });
	await page.screenshot({
		path: testInfo.outputPath("desktop-plugin-settings-secret-cleared.png"),
		fullPage: true,
	});
	const { secretStates, requests } = await proofSnapshot(page);
	expect(secretStates).not.toHaveProperty("RYU_PLUGIN_PROOF_API_KEY");
	expect(
		requests.filter(
			(request) =>
				request.method === "DELETE" &&
				request.path ===
					"/api/plugins/com.ryu.proof/secrets/RYU_PLUGIN_PROOF_API_KEY"
		)
	).toHaveLength(2);
	expect(externalRequests).toEqual([]);
	expect(browserErrors).toEqual([]);
});

test("saves model and full-agent selections through the real controlled pickers", async ({
	page,
}, testInfo) => {
	const { browserErrors, externalRequests } = await openSettings(page);
	await clearRequestLog(page);

	const modelPicker = page.getByRole("button", {
		name: "Preferred model",
		exact: true,
	});
	await armFailure(page, "PUT", "/api/preferences/proof.default-model");
	await modelPicker.click();
	let picker = page.getByRole("dialog", { name: "Choose provider and model" });
	await expect(picker).toBeVisible();
	await picker.getByRole("option", { name: "OpenAI", exact: true }).click();
	let providerPage = page.getByRole("dialog", { name: "OpenAI" });
	await providerPage
		.getByRole("option", { name: /Model\s+proof-model/ })
		.click();
	let modelPage = page.getByRole("dialog", { name: "Model" });
	await modelPage
		.getByRole("option", { name: "proof-model", exact: true })
		.click();
	await expect(
		page.getByText("Couldn't save this setting", { exact: true })
	).toBeVisible();
	await expect(modelPicker).toContainText("Use default model");
	await expect((await proofSnapshot(page)).preferences).not.toHaveProperty(
		"proof.default-model"
	);

	await modelPicker.click();
	picker = page.getByRole("dialog", { name: "Choose provider and model" });
	await picker.getByRole("option", { name: "OpenAI", exact: true }).click();
	providerPage = page.getByRole("dialog", { name: "OpenAI" });
	await providerPage
		.getByRole("option", { name: /Model\s+proof-model/ })
		.click();
	modelPage = page.getByRole("dialog", { name: "Model" });
	await modelPage
		.getByRole("option", { name: "proof-model", exact: true })
		.click();
	await expect(modelPicker).toContainText("proof-model");
	await expect(
		(await proofSnapshot(page)).preferences["proof.default-model"]
	).toBe("proof-model");

	const agentPicker = page.getByRole("button", {
		name: "Default agent target",
	});
	await armFailure(page, "PUT", "/api/preferences/proof.default-agent");
	await agentPicker.click();
	picker = page.getByRole("dialog", { name: "Choose provider and model" });
	await picker.getByRole("option", { name: "Ryu", exact: true }).click();
	const ryuPage = page.getByRole("dialog", { name: "Ryu" });
	await ryuPage.getByRole("option", { name: "Use Ryu", exact: true }).click();
	await expect(
		page.getByText("Couldn't save this setting", { exact: true })
	).toBeVisible();
	await expect(agentPicker).toContainText("Use the default");
	await expect((await proofSnapshot(page)).preferences).not.toHaveProperty(
		"proof.default-agent"
	);
	await agentPicker.click();
	picker = page.getByRole("dialog", { name: "Choose provider and model" });
	await picker.getByRole("option", { name: "Ryu", exact: true }).click();
	const ryuPageRetry = page.getByRole("dialog", { name: "Ryu" });
	await ryuPageRetry
		.getByRole("option", { name: "Use Ryu", exact: true })
		.click();
	await expect(agentPicker).toContainText("Ryu");
	const serializedSelection = JSON.stringify({
		agent_id: "ryu",
		provider: "",
		model: "",
		thinking_level: "",
		effort: "",
		access_mode: "",
	});
	await expect(
		(await proofSnapshot(page)).preferences["proof.default-agent"]
	).toBe(serializedSelection);

	const pickerWrites = (await proofSnapshot(page)).requests.filter(
		(request) =>
			request.method === "PUT" &&
			[
				"/api/preferences/proof.default-model",
				"/api/preferences/proof.default-agent",
			].includes(request.path)
	);
	expect(pickerWrites).toEqual([
		{
			method: "PUT",
			path: "/api/preferences/proof.default-model",
			body: { value: "proof-model" },
		},
		{
			method: "PUT",
			path: "/api/preferences/proof.default-model",
			body: { value: "proof-model" },
		},
		{
			method: "PUT",
			path: "/api/preferences/proof.default-agent",
			body: { value: serializedSelection },
		},
		{
			method: "PUT",
			path: "/api/preferences/proof.default-agent",
			body: { value: serializedSelection },
		},
	]);
	await page.reload({ waitUntil: "domcontentloaded" });
	const persistedModelPicker = page.getByRole("button", {
		name: "Preferred model",
		exact: true,
	});
	const persistedAgentPicker = page.getByRole("button", {
		name: "Default agent target",
	});
	await expect(persistedModelPicker).toContainText("proof-model");
	await expect(persistedAgentPicker).toContainText("Ryu");
	await page.screenshot({
		path: testInfo.outputPath("desktop-plugin-settings-fields-pickers.png"),
		fullPage: true,
	});
	await clearRequestLog(page);

	await persistedAgentPicker.click();
	picker = page.getByRole("dialog", { name: "Choose provider and model" });
	await picker.getByRole("button", { name: "Use the default" }).click();
	await expect(persistedAgentPicker).toContainText("Use the default");
	await expect(
		(await proofSnapshot(page)).preferences["proof.default-agent"]
	).toBe("");
	expect((await proofSnapshot(page)).requests).toContainEqual({
		method: "PUT",
		path: "/api/preferences/proof.default-agent",
		body: { value: "" },
	});
	expect(externalRequests).toEqual([]);
	expect(browserErrors).toEqual([]);
});
