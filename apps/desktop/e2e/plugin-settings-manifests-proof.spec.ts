import { expect, test } from "@playwright/test";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";

const STORY_URL = "/plugin-settings-manifests-proof.html?reset=true";

interface RequestRecord {
	body: unknown;
	method: string;
	path: string;
}

interface ProofSnapshot {
	externalRequests: string[];
	preferences: Record<string, string>;
	requests: RequestRecord[];
	secretRequests: {
		authorization: string | null;
		method: string;
		url: string;
	}[];
	secretStates: Record<
		string,
		{ readable: boolean; set: boolean; updated_at: number | null }
	>;
}

async function proofSnapshot(page: import("@playwright/test").Page) {
	return await page.evaluate(() =>
		/* SAFETY: plugin-settings-manifests-proof.tsx installs __pluginSettingsManifestsProof before this proof page is evaluated. */ (
			window as Window & {
				__pluginSettingsManifestsProof: { snapshot: () => ProofSnapshot };
			}
		).__pluginSettingsManifestsProof.snapshot()
	);
}

async function openSettings(
	page: import("@playwright/test").Page,
	{ holdSecretRead = false }: { holdSecretRead?: boolean } = {}
) {
	const browserErrors: string[] = [];
	const externalRequests: string[] = [];
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
			url.origin !== "http://127.0.0.1:5359"
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
		/* SAFETY: plugin-settings-manifests-proof.tsx installs __pluginSettingsManifestsProof before this proof page is evaluated. */ (
			window as Window & {
				__pluginSettingsManifestsProof: { clearRequestLog: () => void };
			}
		).__pluginSettingsManifestsProof.clearRequestLog()
	);
}

async function armFailure(
	page: import("@playwright/test").Page,
	method: string,
	path: string
) {
	await page.evaluate(
		({ failureMethod, failurePath }) =>
			/* SAFETY: plugin-settings-manifests-proof.tsx installs __pluginSettingsManifestsProof before this proof page is evaluated. */ (
				window as Window & {
					__pluginSettingsManifestsProof: {
						armFailure: (method: string, path: string) => void;
					};
				}
			).__pluginSettingsManifestsProof.armFailure(failureMethod, failurePath),
		{ failureMethod: method, failurePath: path }
	);
}

test("persists preference fields as exact strings and reads them back after reload", async ({
	page,
}) => {
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
}) => {
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
	const token = page.getByLabel("API token", { exact: true });
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
		/* SAFETY: plugin-settings-manifests-proof.tsx installs __pluginSettingsManifestsProof before this proof page is evaluated. */ (
			window as Window & {
				__pluginSettingsManifestsProof: { releaseSecretRead: () => void };
			}
		).__pluginSettingsManifestsProof.releaseSecretRead()
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
	const reloadedToken = page.getByLabel("API token", { exact: true });
	await expect(reloadedToken).toHaveValue("");
	await expect(reloadedToken).toHaveAttribute(
		"placeholder",
		"Stored — enter a new value to replace"
	);
	await expect(page.getByText(/Set ·/)).toBeVisible();

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
	// Toast dismissal pauses on hover; leave its area after Clear disappears.
	await page.mouse.move(0, 0);
	await expect(
		page.getByText("Couldn't clear this secret", { exact: true })
	).toBeHidden({ timeout: 10_000 });
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
}) => {
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

// Every row below comes from the shipped manifest, never a handwritten key list.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface DeclaredField {
	default?: string | number | boolean;
	label: string;
	max?: number;
	min?: number;
	options?: (string | { value: string; label?: string })[];
	pref_key: string;
	step?: number;
	type: string;
}
const declaredFields: {
	packageName: string;
	pluginId: string;
	field: DeclaredField;
}[] = [];
for (const cluster of ["plugins", "lsp", "external_plugins"]) {
	const root = resolve(import.meta.dirname, "../../../plugins-store", cluster);
	for (const packageName of readdirSync(root)) {
		let manifest: {
			id: string;
			contributes?: { settings_tabs?: { fields?: DeclaredField[] }[] };
		};
		try {
			manifest = JSON.parse(
				readFileSync(resolve(root, packageName, "manifest.json"), "utf8")
			);
		} catch {
			continue;
		}
		for (const tab of manifest.contributes?.settings_tabs ?? []) {
			for (const field of tab.fields ?? []) {
				declaredFields.push({ packageName, pluginId: manifest.id, field });
			}
		}
	}
}

async function pickProofModel(
	page: import("@playwright/test").Page,
	label: string
) {
	await page.getByRole("button", { name: label, exact: true }).click();
	await page
		.getByRole("dialog", { name: "Choose provider and model" })
		.getByRole("option", { name: "OpenAI", exact: true })
		.click();
	await page
		.getByRole("dialog", { name: "OpenAI", exact: true })
		.getByRole("option", { name: /Model\s+proof-model/ })
		.click();
	await page
		.getByRole("dialog", { name: "Model", exact: true })
		.getByRole("option", { name: "proof-model", exact: true })
		.click();
}

function expectSecretTarget(snapshot: ProofSnapshot): void {
	expect(snapshot.secretRequests.length).toBeGreaterThan(0);
	for (const request of snapshot.secretRequests) {
		expect(new URL(request.url).origin).toBe("http://127.0.0.1:5359");
		expect(request.authorization).toBe("Bearer plugin-settings-proof-token");
	}
}

async function revealManifestSecret(
	page: import("@playwright/test").Page,
	pluginId: string
): Promise<void> {
	if (pluginId === "@ryu/shadow") {
		const planner = page.getByRole("combobox", {
			name: "Shadow computer-use planner",
			exact: true,
		});
		await planner.click();
		await page
			.getByRole("option", { name: "Jev Ultrafast", exact: true })
			.click();
		await expect(planner.locator('[data-slot="select-value"]')).toHaveText(
			"Jev Ultrafast"
		);
	}
}

for (const { packageName, pluginId, field } of declaredFields) {
	test(`manifest ${packageName}: ${field.type} ${field.pref_key} saves/reloads/resets`, async ({
		page,
	}) => {
		await page.goto(
			`/plugin-settings-manifests-proof.html?reset=true&package=${encodeURIComponent(packageName)}`,
			{ waitUntil: "commit" }
		);
		await page.waitForFunction(
			() => document.body.dataset.harnessReady === "1",
			null,
			{ timeout: 60_000 }
		);
		const label = field.label ?? field.pref_key;
		const path =
			field.type === "secret"
				? `/api/plugins/${encodeURIComponent(pluginId)}/secrets/${encodeURIComponent(field.pref_key)}`
				: `/api/preferences/${encodeURIComponent(field.pref_key)}`;
		let value = "";
		if (field.type === "toggle") {
			const control = page.getByRole("switch", { name: label, exact: true });
			await expect(control).toHaveAttribute(
				"aria-checked",
				String(field.default === true)
			);
			value = String(field.default !== true);
			await control.click();
		} else if (field.type === "select") {
			const options = (field.options ?? []).map((option) =>
				isNativeText(option)
					? { value: option, label: option }
					: { value: option.value, label: option.label ?? option.value }
			);
			const control = page.getByRole("combobox", { name: label, exact: true });
			const defaultOption = options.find(
				(option) => option.value === field.default
			);
			if (defaultOption) {
				await expect(control).toContainText(defaultOption.label);
			}
			const next =
				options.find((option) => option.value !== field.default) ?? options[0];
			value = next.value;
			await control.click();
			await page.getByRole("option", { name: next.label, exact: true }).click();
		} else if (field.type === "model_picker") {
			value = "proof-model";
			await pickProofModel(page, label);
		} else if (field.type === "secret") {
			await revealManifestSecret(page, pluginId);
			const control = page.getByLabel(label, { exact: true });
			await expect(control).toHaveAttribute("type", "password");
			await expect(control).toHaveValue("");
			value = `synthetic-${packageName}-${field.pref_key}`;
			await control.fill(value);
			await control
				.locator("..")
				.getByRole("button", {
					name: pluginId === "@ryu/shadow" ? "Save key" : "Save",
					exact: true,
				})
				.click();
			await expect(control).toHaveValue("");
		} else {
			const control = page.getByRole(
				field.type === "number" ? "spinbutton" : "textbox",
				{ name: label, exact: true }
			);
			await expect(control).toHaveValue(
				field.default === undefined ? "" : String(field.default)
			);
			value =
				field.type === "number"
					? String(
							field.default === (field.min ?? 0) + (field.step ?? 1)
								? (field.min ?? 0)
								: Math.min(
										field.max ?? Number.POSITIVE_INFINITY,
										(field.min ?? 0) + (field.step ?? 1)
									)
						)
					: field.type === "textarea" && isNativeText(field.default)
						? field.default.trim()
						: `saved-${packageName}-${field.pref_key}`;
			await control.fill(value);
			await control.press("Tab");
		}
		await expect
			.poll(async () =>
				(await proofSnapshot(page)).requests.some(
					(request) =>
						request.method === "PUT" &&
						request.path === path &&
						JSON.stringify(request.body) === JSON.stringify({ value })
				)
			)
			.toBe(true);
		if (field.type === "secret") {
			const snapshot = await proofSnapshot(page);
			expectSecretTarget(snapshot);
			expect(snapshot.secretRequests).toContainEqual({
				authorization: "Bearer plugin-settings-proof-token",
				method: "PUT",
				url: `http://127.0.0.1:5359${path}`,
			});
		}
		await page.reload({ waitUntil: "domcontentloaded" });
		if (field.type === "toggle") {
			await expect(
				page.getByRole("switch", { name: label, exact: true })
			).toHaveAttribute("aria-checked", value);
		} else if (field.type === "model_picker") {
			await expect(
				page.getByRole("button", { name: label, exact: true })
			).toContainText(value);
		} else if (field.type === "select") {
			const chosen = (field.options ?? []).find(
				(option) => (isNativeText(option) ? option : option.value) === value
			)!;
			await expect(
				page.getByRole("combobox", { name: label, exact: true })
			).toContainText(
				isNativeText(chosen) ? chosen : (chosen.label ?? chosen.value)
			);
		} else if (field.type === "secret") {
			await revealManifestSecret(page, pluginId);
			const control = page.getByLabel(label, { exact: true });
			await expect(control).toHaveValue("");
			await expect(
				control
					.locator("..")
					.getByRole("button", { name: "Clear", exact: true })
			).toBeVisible();
			expect(
				JSON.stringify((await proofSnapshot(page)).secretStates)
			).not.toContain(value);
			expect((await proofSnapshot(page)).preferences).not.toHaveProperty(
				field.pref_key
			);
			await control
				.locator("..")
				.getByRole("button", { name: "Clear", exact: true })
				.click();
			await expect(
				control
					.locator("..")
					.getByRole("button", { name: "Clear", exact: true })
			).toHaveCount(0);
			const clearedSnapshot = await proofSnapshot(page);
			expectSecretTarget(clearedSnapshot);
			expect(clearedSnapshot.secretRequests).toContainEqual({
				authorization: "Bearer plugin-settings-proof-token",
				method: "DELETE",
				url: `http://127.0.0.1:5359${path}`,
			});
			await page.reload({ waitUntil: "domcontentloaded" });
			await revealManifestSecret(page, pluginId);
			await expect(control).toHaveValue("");
			await expect(
				control
					.locator("..")
					.getByRole("button", { name: "Clear", exact: true })
			).toHaveCount(0);
			expect(
				(await proofSnapshot(page)).requests.some(
					(request) => request.method === "GET" && request.path === path
				)
			).toBe(false);
		} else {
			await expect(
				page.getByRole(field.type === "number" ? "spinbutton" : "textbox", {
					name: label,
					exact: true,
				})
			).toHaveValue(value);
		}
		if (field.type === "number") {
			const control = page.getByRole("spinbutton", {
				name: label,
				exact: true,
			});
			const before = (await proofSnapshot(page)).requests.filter(
				(request) => request.method === "PUT" && request.path === path
			).length;
			for (const invalid of [
				field.max === undefined ? undefined : field.max + (field.step ?? 1),
				field.min === undefined ? undefined : field.min - (field.step ?? 1),
			]) {
				if (invalid === undefined) {
					continue;
				}
				await control.fill(String(invalid));
				await control.press("Tab");
				await expect(control).toHaveValue(value);
				expect(
					(await proofSnapshot(page)).requests.filter(
						(request) => request.method === "PUT" && request.path === path
					)
				).toHaveLength(before);
			}
		}
		if (field.type === "model_picker") {
			await page
				.getByRole("button", { name: `Use default for ${label}`, exact: true })
				.click();
			await expect
				.poll(
					async () => (await proofSnapshot(page)).preferences[field.pref_key]
				)
				.toBe("");
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(
				page.getByRole("button", {
					name: `Use default for ${label}`,
					exact: true,
				})
			).toHaveCount(0);
		} else if (field.type === "select") {
			const option = (field.options ?? []).find(
				(option) =>
					(isNativeText(option) ? option : option.value) === field.default
			);
			if (option) {
				await page.getByRole("combobox", { name: label, exact: true }).click();
				await page
					.getByRole("option", {
						name: isNativeText(option)
							? option
							: (option.label ?? option.value),
						exact: true,
					})
					.click();
				await expect
					.poll(
						async () => (await proofSnapshot(page)).preferences[field.pref_key]
					)
					.toBe(String(field.default));
				await page.reload({ waitUntil: "domcontentloaded" });
				await expect(
					page.getByRole("combobox", { name: label, exact: true })
				).toContainText(
					isNativeText(option) ? option : (option.label ?? option.value)
				);
			}
		} else if (field.type === "toggle") {
			await page.getByRole("switch", { name: label, exact: true }).click();
			await expect
				.poll(
					async () => (await proofSnapshot(page)).preferences[field.pref_key]
				)
				.toBe(String(field.default === true));
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(
				page.getByRole("switch", { name: label, exact: true })
			).toHaveAttribute("aria-checked", String(field.default === true));
		} else if (
			field.type === "number" ||
			field.type === "text" ||
			field.type === "textarea"
		) {
			const control = page.getByRole(
				field.type === "number" ? "spinbutton" : "textbox",
				{ name: label, exact: true }
			);
			await control.fill("");
			await control.press("Tab");
			await expect
				.poll(
					async () => (await proofSnapshot(page)).preferences[field.pref_key]
				)
				.toBe("");
			await page.reload({ waitUntil: "domcontentloaded" });
			await expect(control).toHaveValue("");
		}
		if (field.type === "secret") {
			expectSecretTarget(await proofSnapshot(page));
		}
		expect((await proofSnapshot(page)).externalRequests).toEqual([]);
	});
}

for (const policy of ["denied", "shadowed"]) {
	test(`real secret fields retain ${policy} metadata after replacement and reload`, async ({
		page,
	}) => {
		await page.goto(
			`/plugin-settings-manifests-proof.html?reset=true&package=cloudflare-clef&secretPolicy=${policy}`,
			{ waitUntil: "commit" }
		);
		await page.waitForFunction(
			() => document.body.dataset.harnessReady === "1",
			null,
			{ timeout: 60_000 }
		);
		const status =
			policy === "denied"
				? "Stored, but this plugin is not allowed to read this name"
				: "Overridden by an environment variable on this node";
		await expect(page.getByText(status, { exact: true })).toHaveCount(2);
		const control = page.getByLabel("Cloudflare API token", { exact: true });
		await expect(control).toHaveValue("");
		await control.fill("synthetic-replacement-only");
		await control
			.locator("..")
			.getByRole("button", { name: "Save", exact: true })
			.click();
		await expect(control).toHaveValue("");
		await expect(page.getByText(status, { exact: true })).toHaveCount(2);
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(control).toHaveValue("");
		await expect(page.getByText(status, { exact: true })).toHaveCount(2);
		expect((await proofSnapshot(page)).externalRequests).toEqual([]);
	});
}

test("completed manifest settings state survives reload and is captured for review", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto(
		"/plugin-settings-manifests-proof.html?reset=true&package=cloudflare-clef",
		{ waitUntil: "commit" }
	);
	await page.waitForFunction(
		() => document.body.dataset.harnessReady === "1",
		null,
		{ timeout: 60_000 }
	);
	for (const [label, value] of [
		["Cloudflare account ID", "0123456789abcdef0123456789abcdef"],
		["Cloudflare API token", "synthetic-completed-proof-token"],
	]) {
		const control = page.getByLabel(label, { exact: true });
		await control.fill(value);
		await control
			.locator("..")
			.getByRole("button", { name: "Save", exact: true })
			.click();
		await expect(control).toHaveValue("");
	}
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(page.getByText(/Set ·/)).toHaveCount(2);
	await expect(
		page.getByLabel("Cloudflare API token", { exact: true })
	).toHaveValue("");
	await expect(
		page.getByLabel("Cloudflare account ID", { exact: true })
	).toHaveValue("");
	// Capture a completed real manifest with the changed select and model controls.
	await page.goto(
		"/plugin-settings-manifests-proof.html?reset=true&package=recap",
		{ waitUntil: "commit" }
	);
	await page.waitForFunction(() => document.body.dataset.harnessReady === "1");
	await pickProofModel(page, "Recap model");
	await expect(
		page.getByRole("button", {
			name: "Use default for Recap model",
			exact: true,
		})
	).toBeVisible();
	const threshold = page.getByRole("spinbutton", {
		name: "Recap turns longer than (characters)",
		exact: true,
	});
	await threshold.fill("1300");
	await threshold.press("Tab");
	// Blur starts an async preference write; observe durable readback before reload.
	await expect
		.poll(
			async () => (await proofSnapshot(page)).preferences["recap-min-chars"]
		)
		.toBe("1300");
	await expect
		.poll(async () => (await proofSnapshot(page)).preferences["recap-model"])
		.toBe("proof-model");
	expect((await proofSnapshot(page)).requests).toContainEqual({
		method: "PUT",
		path: "/api/preferences/recap-min-chars",
		body: { value: "1300" },
	});
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForFunction(
		() => document.body.dataset.harnessReady === "1",
		null,
		{ timeout: 60_000 }
	);
	expect(pageErrors).toEqual([]);
	await expect(threshold).toHaveValue("1300");
	await expect(
		page.getByRole("button", { name: "Recap model", exact: true })
	).toContainText("proof-model");
	await expect(
		page.getByRole("combobox", { name: "Detail", exact: true })
	).toContainText("Standard");
	await page.screenshot({
		path: test.info().outputPath("settings-manifests-completed.png"),
		fullPage: true,
	});
	expect((await proofSnapshot(page)).externalRequests).toEqual([]);
});
