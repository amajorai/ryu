import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const committedProofDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/shadow-computer-use"
);
// Ordinary runs write screenshots to Playwright's output directory. Set
// RYU_REFRESH_SHADOW_PROOF=1 to deliberately regenerate the committed proof.
const refreshCommittedProof = process.env.RYU_REFRESH_SHADOW_PROOF === "1";
const proofPath = (fileName: string) => {
	if (!refreshCommittedProof) {
		return test.info().outputPath(fileName);
	}
	mkdirSync(committedProofDir, { recursive: true });
	return path.join(committedProofDir, fileName);
};
// Capture preferences already saved on this device (companion.bin). Shadow
// keeps capture state in memory, so the settings tab re-pushes these on mount.
const savedCapture = {
	frames: false,
	paused: false,
	app_allowlist: ["Terminal", "Code"],
	history_retention_days: 14,
};
const initialConfig = {
	applied: false,
	jevApiKeyConfigured: false,
	jevModel: "jev-latest",
	jevUrl: "https://api.typesafe.ai/v1/systemone",
	layaUrl: "http://127.0.0.1:8980/api/ext/@ryu/laya/predict",
	localPluginId: "",
	localModelId: "",
	maxSteps: 12,
	planner: "native",
};

const plannerModels = [
	{
		id: "laya.router",
		label: "Laya · Router",
		model_id: "router",
		plugin: "@ryu/laya",
	},
	{
		id: "needle3.base",
		label: "Needle 3 · Base",
		model_id: "needle3",
		plugin: "@ryu/needle3",
	},
	{
		id: "functiongemma.base",
		label: "FunctionGemma · 270M",
		model_id: "google/functiongemma-270m-it",
		plugin: "@ryu/functiongemma",
	},
];

test("chooses a contributed local model and saves while Shadow is stopped", async ({
	page,
}) => {
	const requests: string[] = [];
	let savedBody: unknown;
	let storedJevSecret: unknown;
	let shadowRunning = false;
	const captureWrites: Array<{ body: unknown; status: number }> = [];
	await page.addInitScript(
		(seed) => {
			sessionStorage.setItem(
				"shadow-proof-store:companion.bin",
				JSON.stringify(seed)
			);
		},
		{
			companion_frames: savedCapture.frames,
			companion_paused: savedCapture.paused,
			companion_app_allowlist: savedCapture.app_allowlist,
			shadow_history_retention_days: savedCapture.history_retention_days,
		}
	);
	const corsHeaders = {
		"access-control-allow-credentials": "true",
		"access-control-allow-headers":
			"authorization,content-type,x-ryu-user-jwt,x-ryu-buyer-token",
		"access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
		"access-control-allow-origin": "http://127.0.0.1:5228",
	};

	page.on("request", (request) => requests.push(request.url()));
	await page.route("**/api/shadow/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (request.method() === "OPTIONS") {
			await route.fulfill({ status: 204, headers: corsHeaders });
			return;
		}
		if (url.pathname.endsWith("/computer-use/config")) {
			if (request.method() === "GET") {
				await route.fulfill({
					status: 200,
					headers: corsHeaders,
					json: initialConfig,
				});
				return;
			}
			const update = request.postDataJSON();
			savedBody = update;
			await route.fulfill({
				status: 200,
				headers: corsHeaders,
				json: {
					...initialConfig,
					planner: update.planner,
					jevUrl: update.jevUrl,
					jevModel: update.jevModel,
					layaUrl: update.layaUrl,
					localPluginId: update.localPluginId,
					localModelId: update.localModelId,
					maxSteps: update.maxSteps,
					applied: false,
				},
			});
			return;
		}
		if (url.pathname.endsWith("/capture/control")) {
			if (request.method() === "GET") {
				await route.fulfill(
					shadowRunning
						? { status: 200, headers: corsHeaders, json: savedCapture }
						: {
								status: 502,
								headers: corsHeaders,
								json: { error: "Shadow is stopped" },
							}
				);
				return;
			}
			const body = request.postDataJSON();
			if (!shadowRunning) {
				captureWrites.push({ body, status: 502 });
				await route.fulfill({
					status: 502,
					headers: corsHeaders,
					json: { error: "Shadow is stopped" },
				});
				return;
			}
			captureWrites.push({ body, status: 200 });
			await route.fulfill({
				status: 200,
				headers: corsHeaders,
				json: { ...savedCapture, ...body },
			});
			return;
		}
		await route.fulfill({ status: 404, headers: corsHeaders });
	});
	await page.route("**/api/plugins/**/secrets**", async (route) => {
		if (route.request().method() === "PUT") {
			storedJevSecret = route.request().postDataJSON();
			await route.fulfill({
				status: 200,
				headers: corsHeaders,
				json: { ok: true },
			});
			return;
		}
		await route.fulfill({
			status: 200,
			headers: corsHeaders,
			json: { secrets: [] },
		});
	});
	await page.route("**/api/plugins/contributions", async (route) => {
		if (route.request().method() === "OPTIONS") {
			await route.fulfill({ status: 204, headers: corsHeaders });
			return;
		}
		await route.fulfill({
			status: 200,
			headers: corsHeaders,
			json: { computer_use_planners: plannerModels },
		});
	});

	const pageErrors: string[] = [];
	page.on("pageerror", (error) =>
		pageErrors.push(error.stack ?? error.message)
	);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto("/shadow-computer-use-proof.html", {
		waitUntil: "domcontentloaded",
	});
	await expect(
		page.getByRole("heading", { name: "Computer use" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Save computer-use settings" })
	).toBeEnabled();
	// Stopped Shadow: the saved preferences are read from the device store and
	// pushed once; Shadow's refusal is surfaced with a retry instead of
	// claiming capture changed. The saved values stay on screen.
	const captureRefusal = page
		.getByRole("alert")
		.filter({ hasText: "Capture settings could not be applied" });
	await expect(captureRefusal).toContainText(
		"Check that Shadow is available, then retry."
	);
	expect(captureWrites).toEqual([{ body: savedCapture, status: 502 }]);
	await expect(
		page
			.getByRole("list")
			.filter({ hasText: "Screen recording" })
			.getByRole("switch")
	).not.toBeChecked();
	await expect(
		page.getByRole("spinbutton", { name: "Shadow history retention in days" })
	).toHaveValue("14");
	await expect(
		page.getByRole("textbox", {
			name: "App allowlist, comma-separated app names",
		})
	).toHaveValue("Terminal, Code");
	await expect(
		page.getByRole("button", { name: "Retry capture settings" })
	).toBeEnabled();

	await page
		.getByRole("combobox", { name: "Shadow computer-use planner" })
		.click();
	await page.getByRole("option", { name: "Local model plugin" }).click();
	await page
		.getByRole("combobox", { name: "Local computer-use model" })
		.click();
	await expect(page.getByRole("option", { name: /Laya/ })).toBeVisible();
	await expect(
		page.getByRole("option", { name: /FunctionGemma/ })
	).toBeVisible();
	await page.getByRole("option", { name: /Needle 3/ }).click();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("option", { name: /Needle 3/ })).toBeHidden();
	await page.getByRole("heading", { name: "Shadow" }).click();
	await page
		.getByRole("button", { name: "Save computer-use settings" })
		.click();
	await expect(
		page.getByRole("status").filter({
			hasText:
				"Computer-use settings saved; they will apply when Shadow starts.",
		})
	).toBeVisible();
	expect(savedBody).toMatchObject({
		planner: "local",
		localPluginId: "@ryu/needle3",
		localModelId: "needle3",
		maxSteps: 12,
	});
	expect(requests.some((url) => url.includes("/api/sidecar/start"))).toBe(
		false
	);
	expect(requests.some((url) => url.includes("/api/sidecars"))).toBe(false);

	await page.screenshot({
		fullPage: true,
		path: proofPath("shadow-settings-needle3-offline-light.png"),
	});

	await page
		.locator("html")
		.evaluate((element) => element.classList.add("dark"));
	await page.screenshot({
		fullPage: true,
		path: proofPath("shadow-settings-needle3-offline-dark.png"),
	});

	await page.setViewportSize({ width: 820, height: 900 });
	const overflowsHorizontally = await page.evaluate(
		() => document.documentElement.scrollWidth > window.innerWidth
	);
	expect(overflowsHorizontally).toBe(false);

	await page.setViewportSize({ width: 1440, height: 1000 });
	await page
		.getByRole("combobox", { name: "Shadow computer-use planner" })
		.click();
	await page.getByRole("option", { name: "Jev Ultrafast" }).click();
	await page.getByRole("heading", { name: "Shadow" }).click();
	await page.getByLabel("Jev API key").fill("jev-test-key-not-real");
	await page.getByRole("button", { name: "Save key" }).click();
	await expect(
		page.getByRole("status").filter({
			hasText:
				"Jev key saved encrypted. Shadow will load it when it next starts.",
		})
	).toBeVisible();
	expect(storedJevSecret).toMatchObject({ value: "jev-test-key-not-real" });
	await expect(page.getByLabel("Jev API key")).toHaveValue("");
	expect(await page.locator("body").innerText()).not.toContain(
		"jev-test-key-not-real"
	);
	expect(requests.some((url) => url.includes("SHADOW_JEV_API_KEY"))).toBe(true);
	expect(requests.some((url) => url.includes("/api/sidecars"))).toBe(false);

	// Shadow starts later: Retry re-pushes the same saved preferences and the
	// refusal clears only after Shadow acknowledges them.
	shadowRunning = true;
	await page.getByRole("button", { name: "Retry capture settings" }).click();
	await expect(captureRefusal).toBeHidden();
	await expect(
		page.getByRole("button", { name: "Retry capture settings" })
	).toBeHidden();
	expect(captureWrites).toEqual([
		{ body: savedCapture, status: 502 },
		{ body: savedCapture, status: 200 },
	]);
	await expect(
		page.getByRole("spinbutton", { name: "Shadow history retention in days" })
	).toHaveValue("14");

	const nativeLedger = await page.evaluate(
		() =>
			(
				window as unknown as {
					__shadowProofNative: { calls: string[]; refused: string[] };
				}
			).__shadowProofNative
	);
	expect(nativeLedger.refused).toEqual([]);
	expect(nativeLedger.calls).toContain("plugin:store|load");
	expect(nativeLedger.calls).toContain("plugin:store|get");
	// Retry re-persists the desired preferences before pushing them; the device
	// store must still hold exactly the saved values, and the signed-out
	// account vault is only read, never saved.
	const persisted = await page.evaluate(() => ({
		auth: sessionStorage.getItem("shadow-proof-store:auth.bin"),
		companion: JSON.parse(
			sessionStorage.getItem("shadow-proof-store:companion.bin") ?? "null"
		),
	}));
	expect(persisted).toEqual({
		auth: null,
		companion: {
			companion_frames: savedCapture.frames,
			companion_paused: savedCapture.paused,
			companion_app_allowlist: savedCapture.app_allowlist,
			shadow_history_retention_days: savedCapture.history_retention_days,
		},
	});
	expect(pageErrors).toEqual([]);
});
