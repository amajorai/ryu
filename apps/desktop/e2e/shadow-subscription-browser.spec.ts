import { expect, type Page, test } from "@playwright/test";

// Real-Chromium proof for two ShadowSettings rows, mounted by the shipping
// Shadow settings harness. Core's computer-use, plugin and capture routes are
// answered by page routes. Capture preferences go through the installed Tauri
// Store frontend to the harness's own finite store contract
// (harness/shadow-computer-use-proof.tsx): `companion.bin` is seeded from, and
// saved to, sessionStorage under `shadow-proof-store:companion.bin`, so it
// survives a reload. The spec never installs its own IPC. No screenshot or
// proof file is written.

interface Policy {
	jevModel: string;
	jevUrl: string;
	layaUrl: string;
	localModelId: string;
	localPluginId: string;
	maxSteps: number;
	planner: string;
}

// The harness's sessionStorage key for the `companion.bin` Tauri store.
const COMPANION_STORE_KEY = "shadow-proof-store:companion.bin";

const basePolicy: Policy = {
	planner: "local",
	jevUrl: "https://jev.example.test/v1/decide",
	jevModel: "saved-jev-model",
	layaUrl: "http://127.0.0.1:7980/api/ext/@ryu/laya/predict",
	localPluginId: "@ryu/needle3",
	localModelId: "needle3",
	maxSteps: 9,
};
const planners = [
	{
		id: "needle3.base",
		label: "Needle 3 · Base",
		model_id: "needle3",
		plugin: "@ryu/needle3",
	},
	{
		id: "laya.router",
		label: "Laya · Router",
		model_id: "router",
		plugin: "@ryu/laya",
	},
];

async function serve(page: Page, initial: Policy) {
	const state = {
		policy: structuredClone(initial),
		policyWrites: [] as unknown[],
		captureWrites: [] as Record<string, unknown>[],
		capture: {
			frames: true,
			paused: false,
			app_allowlist: [] as string[],
			history_retention_days: 3650,
		},
		pageErrors: [] as string[],
	};
	page.on("pageerror", (error) =>
		state.pageErrors.push(error.stack ?? error.message)
	);
	const headers = (origin: string) => ({
		"access-control-allow-credentials": "true",
		"access-control-allow-headers":
			"authorization,content-type,accept,x-ryu-user-jwt,x-ryu-buyer-token,x-ryu-client,x-ryu-device-id",
		"access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
		"access-control-allow-origin": origin,
	});
	// Only Core API paths; Vite serves modules such as `/@fs/…/lib/api/…`.
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const request = route.request();
			const origin = request.headers().origin ?? "http://127.0.0.1:5231";
			const url = new URL(request.url());
			if (request.method() === "OPTIONS") {
				await route.fulfill({ status: 204, headers: headers(origin) });
				return;
			}
			const reply = (json: unknown, status = 200) =>
				route.fulfill({ status, headers: headers(origin), json });
			if (url.pathname === "/api/shadow/computer-use/config") {
				if (request.method() === "POST") {
					const body = request.postDataJSON() as Policy;
					state.policyWrites.push(body);
					state.policy = body;
				}
				await reply({
					...state.policy,
					applied: false,
					jevApiKeyConfigured: false,
				});
				return;
			}
			if (url.pathname === "/api/shadow/capture/control") {
				if (request.method() === "POST") {
					const body = request.postDataJSON() as Record<string, unknown>;
					state.captureWrites.push(body);
					state.capture = { ...state.capture, ...body };
				}
				await reply(state.capture);
				return;
			}
			if (url.pathname.endsWith("/secrets")) {
				await reply({ secrets: [] });
				return;
			}
			if (url.pathname === "/api/plugins/contributions") {
				await reply({ computer_use_planners: planners });
				return;
			}
			await reply({ error: `Undeclared ${url.pathname}` }, 404);
		}
	);
	// Seed only an empty tab: a reload must read what the product saved.
	await page.addInitScript(
		({ key, values }) => {
			if (sessionStorage.getItem(key) === null) {
				sessionStorage.setItem(key, JSON.stringify(values));
			}
		},
		{
			key: COMPANION_STORE_KEY,
			values: { shadow_history_retention_days: 3650 },
		}
	);
	return state;
}

/** The harness's native ledger and the companion.bin it last saved. */
function harnessStore(page: Page) {
	return page.evaluate((key) => {
		const ledger = Reflect.get(window, "__shadowProofNative") as {
			calls: string[];
			refused: string[];
		};
		return {
			calls: [...ledger.calls],
			refused: [...ledger.refused],
			saved: JSON.parse(sessionStorage.getItem(key) ?? "null") as Record<
				string,
				unknown
			> | null,
		};
	}, COMPANION_STORE_KEY);
}

async function open(page: Page) {
	await page.goto("/shadow-computer-use-proof.html", {
		waitUntil: "domcontentloaded",
	});
	await expect(
		page.getByRole("heading", { name: "Computer use" })
	).toBeVisible();
	await expect(page.getByText("Loading computer-use settings")).toHaveCount(0);
}

test("closed Local model trigger names the saved model by label; an unadvertised one reads Unavailable and blocks Save", async ({
	page,
}) => {
	const state = await serve(page, basePolicy);
	await open(page);
	const local = page.getByRole("combobox", {
		name: "Local computer-use model",
	});
	const localValue = local.locator('[data-slot="select-value"]');
	await expect(localValue).toHaveText("Needle 3 · Base · @ryu/needle3");
	await expect(local).not.toContainText("needle3.base");
	await local.click();
	await page.getByRole("option", { name: "Laya · Router · @ryu/laya" }).click();
	await expect(localValue).toHaveText("Laya · Router · @ryu/laya");
	await page
		.getByRole("button", { name: "Save computer-use settings" })
		.click();
	await expect(
		page.getByRole("status").filter({
			hasText:
				"Computer-use settings saved; they will apply when Shadow starts.",
		})
	).toBeVisible();
	expect(state.policyWrites).toEqual([
		{ ...basePolicy, localPluginId: "@ryu/laya", localModelId: "router" },
	]);

	state.policy = {
		...basePolicy,
		localPluginId: "@ryu/removed-planner",
		localModelId: "gone-model",
	};
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(
		page.getByRole("heading", { name: "Computer use" })
	).toBeVisible();
	await expect(localValue).toHaveText(
		"Unavailable model · @ryu/removed-planner"
	);
	await expect(
		page.getByRole("button", { name: "Save computer-use settings" })
	).toBeDisabled();
	expect(state.policyWrites).toHaveLength(1);
	expect(state.pageErrors).toEqual([]);
});

test("Keep history shows the window Shadow keeps after Tab leaves a clamped entry, and after reload", async ({
	page,
}) => {
	const state = await serve(page, basePolicy);
	await open(page);
	const retention = page.getByRole("spinbutton", {
		name: "Shadow history retention in days",
	});
	await expect(retention).toHaveValue("3650");
	await expect(retention).toBeEnabled();
	// The mount read the seeded window from the harness store and pushed it.
	expect(state.captureWrites).toEqual([
		{
			frames: true,
			paused: false,
			app_allowlist: [],
			history_retention_days: 3650,
		},
	]);
	const before = state.captureWrites.length;
	await retention.fill("5000");
	await retention.press("Tab");
	await expect.poll(() => state.captureWrites.length).toBe(before + 1);
	expect(state.captureWrites.at(-1)).toEqual({ history_retention_days: 3650 });
	await expect(retention).toHaveValue("3650");
	await expect(retention).not.toBeFocused();
	await retention.fill("");
	await retention.press("Tab");
	await expect.poll(() => state.captureWrites.length).toBe(before + 2);
	expect(state.captureWrites.at(-1)).toEqual({ history_retention_days: 3650 });
	await expect(retention).toHaveValue("3650");
	// A window different from the seed, so the reload below can only show it if
	// the product saved it to the device store.
	await retention.fill("120");
	await retention.press("Tab");
	await expect.poll(() => state.captureWrites.length).toBe(before + 3);
	expect(state.captureWrites.at(-1)).toEqual({ history_retention_days: 120 });
	await expect(retention).toHaveValue("120");
	await expect
		.poll(async () => (await harnessStore(page)).saved)
		.toEqual({ shadow_history_retention_days: 120 });
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(retention).toHaveValue("120");
	expect(state.captureWrites.at(-1)).toEqual({
		frames: true,
		paused: false,
		app_allowlist: [],
		history_retention_days: 120,
	});
	expect((await harnessStore(page)).refused).toEqual([]);
	expect(state.pageErrors).toEqual([]);
});
