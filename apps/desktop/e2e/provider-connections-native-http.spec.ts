import {
	type APIRequestContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import type { ProviderCall } from "./provider-connections-native-http-state.ts";

const core = "http://127.0.0.1:5691";
interface Snapshot {
	calls: ProviderCall[];
	catalog: {
		providers: Array<{
			id: string;
			routing: string;
			configured: boolean;
			modelOverrides?: Record<string, boolean>;
			accounts?: Array<{
				accountId: string;
				label: string;
				active: boolean;
				gatewayActive?: boolean;
			}>;
		}>;
	};
	config: {
		provider: string;
		model: string | null;
		thinkingLevel: string | null;
	};
	heldRequestKeys: string[];
	policy: unknown;
	secrets: Record<string, string>;
	unexpected: string[];
}
const state = async (request: APIRequestContext): Promise<Snapshot> => {
	const response = await request.get(`${core}/__provider-state`);
	expect(response.ok()).toBe(true);
	return response.json();
};
async function control(
	request: APIRequestContext,
	action: string,
	method?: string,
	path?: string,
	status?: number,
	model?: string
) {
	const response = await request.post(`${core}/__provider-control`, {
		headers: { "x-proof-control": "owned-fixture" },
		data: { action, method, path, status, model },
	});
	expect(response.ok()).toBe(true);
}
function cardButton(page: Page, label: string) {
	return page
		.getByRole("button")
		.filter({ has: page.getByText(label, { exact: true }) });
}
async function open(page: Page, label: string) {
	await cardButton(page, label).click();
}
const writes = (snapshot: Snapshot, path: string) =>
	snapshot.calls.filter((c) => c.path === path && c.method !== "GET");
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page, request }) => {
	const list: string[] = [];
	errors.set(page, list);
	page.on("pageerror", (error) => list.push(error.message));
	await control(request, "reset");
});
test.afterEach(async ({ page, request }) => {
	for (const key of (await state(request)).heldRequestKeys) {
		const split = key.indexOf(" ");
		await control(
			request,
			"release",
			key.slice(0, split),
			key.slice(split + 1)
		);
	}
	await expect
		.poll(async () =>
			(await state(request)).calls.every((call) => call.status !== 0)
		)
		.toBe(true);
	const snapshot = await state(request);
	expect(snapshot.unexpected).toEqual([]);
	expect(
		(await (await request.get(`${core}/__state`)).json()).unexpected
	).toEqual([]);
	expect(
		await page.evaluate(() =>
			Reflect.get(window, "__providerProofNativeUnexpected")
		)
	).toEqual([]);
	expect(errors.get(page)).toEqual([]);
});
test("real hook retries refused catalog then activates exact model and reloads current config", async ({
	page,
	request,
}) => {
	await control(request, "refuse", "GET", "/api/pi-config/catalog", 503);
	await page.goto("/provider-connections-native-http.html");
	await expect(page.getByText(/Failed to load providers:/)).toBeVisible();
	expect(writes(await state(request), "/api/pi-config")).toEqual([]);
	await control(request, "allow", "GET", "/api/pi-config/catalog");
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await open(page, "OpenRouter");
	await page.locator("#openrouter-model-custom").fill("remote-model");
	await page
		.getByRole("button", { name: "Use this provider", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "In use", exact: true })
	).toBeDisabled();
	const saved = await state(request);
	expect(
		writes(saved, "/api/pi-config").map((c) => ({
			body: c.body,
			status: c.status,
		}))
	).toEqual([
		{
			body: {
				provider: "openrouter",
				model: "remote-model",
				thinkingLevel: null,
				api: "openai-completions",
			},
			status: 200,
		},
	]);
	expect(saved.config).toMatchObject({
		provider: "openrouter",
		model: "remote-model",
	});
	await page.reload();
	await open(page, "OpenRouter");
	await expect(page.locator("#openrouter-model-custom")).toHaveValue(
		"remote-model"
	);
	await expect(
		page.getByRole("button", { name: "In use", exact: true })
	).toBeDisabled();
});
test("custom key refusal retains draft and identical retry saves actual credential without exposing it in catalog", async ({
	page,
	request,
}) => {
	await control(request, "refuse", "POST", "/api/pi-config/providers", 503);
	await page.goto("/provider-connections-native-http.html");
	await open(page, "Local model server");
	const key = page.locator("#key-local-model-server");
	await key.fill("synthetic-replacement-key");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByText("Could not save credential", { exact: true })
	).toBeVisible();
	await expect(key).toHaveValue("synthetic-replacement-key");
	expect((await state(request)).secrets).toEqual({});
	await control(request, "allow", "POST", "/api/pi-config/providers");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(key).toHaveValue("");
	const saved = await state(request);
	expect(saved.secrets).toEqual({
		"local-model-server": "synthetic-replacement-key",
	});
	expect(
		writes(saved, "/api/pi-config/providers").map((c) => ({
			body: c.body,
			status: c.status,
		}))
	).toEqual(
		[503, 200].map((status) => ({
			body: {
				provider: "local-model-server",
				apiKey: "synthetic-replacement-key",
			},
			status,
		}))
	);
	expect(JSON.stringify(saved.catalog)).not.toContain(
		"synthetic-replacement-key"
	);
	await page.reload();
	await open(page, "Local model server");
	await expect(key).toHaveValue("");
	expect((await state(request)).secrets["local-model-server"]).toBe(
		"synthetic-replacement-key"
	);
});
test("held key save keeps its action disabled and retains the draft until acknowledgment", async ({
	page,
	request,
}) => {
	await control(request, "hold", "POST", "/api/pi-config/providers");
	await page.goto("/provider-connections-native-http.html");
	await open(page, "Local model server");
	await page.locator("#key-local-model-server").fill("synthetic-held-key");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Saving…", exact: true })
	).toBeDisabled();
	await expect(page.locator("#key-local-model-server")).toHaveValue(
		"synthetic-held-key"
	);
	expect((await state(request)).secrets).toEqual({});
	expect(writes(await state(request), "/api/pi-config/providers")).toHaveLength(
		1
	);
	await control(request, "release", "POST", "/api/pi-config/providers");
	await expect(page.locator("#key-local-model-server")).toHaveValue("");
	expect(writes(await state(request), "/api/pi-config/providers")).toHaveLength(
		1
	);
	expect((await state(request)).secrets["local-model-server"]).toBe(
		"synthetic-held-key"
	);
});
test("routing refused write rolls back visible switch then identical retry persists and reloads", async ({
	page,
	request,
}) => {
	await control(request, "refuse", "POST", "/api/pi-config/providers", 503);
	await page.goto("/provider-connections-native-http.html");
	await open(page, "OpenRouter");
	const toggle = page
		.getByText("Route through Gateway", { exact: true })
		.locator("..")
		.getByRole("switch");
	await expect(toggle).not.toBeChecked();
	await toggle.click();
	await expect(
		page.getByText("Could not update routing", { exact: true })
	).toBeVisible();
	await expect(toggle).not.toBeChecked();
	expect(
		(await state(request)).catalog.providers.find((p) => p.id === "openrouter")
			?.routing
	).toBe("direct");
	await control(request, "allow", "POST", "/api/pi-config/providers");
	await toggle.click();
	await expect(toggle).toBeChecked();
	await expect
		.poll(
			async () =>
				(await state(request)).catalog.providers.find(
					(p) => p.id === "openrouter"
				)?.routing
		)
		.toBe("gateway");
	expect(
		writes(await state(request), "/api/pi-config/providers").map((c) => ({
			body: c.body,
			status: c.status,
		}))
	).toEqual(
		[503, 200].map((status) => ({
			body: { provider: "openrouter", routing: "gateway" },
			status,
		}))
	);
	await page.reload();
	await open(page, "OpenRouter");
	await expect(toggle).toBeChecked();
});
test("discovery genuine503 has visible failure and no hidden config write; retry displays acknowledged saved models", async ({
	page,
	request,
}) => {
	await control(
		request,
		"refuse",
		"POST",
		"/api/pi-config/discover-models",
		503
	);
	await page.goto("/provider-connections-native-http.html");
	await open(page, "Local model server");
	await expect(
		page.getByText("Could not discover models", { exact: true })
	).toBeVisible();
	expect(writes(await state(request), "/api/pi-config/providers")).toEqual([]);
	await control(request, "allow", "POST", "/api/pi-config/discover-models");
	await page
		.getByRole("button", { name: "Discover models", exact: true })
		.click();
	await expect(
		page.getByText("Showing models saved from the last successful discovery.")
	).toBeVisible();
	await expect(
		page.getByRole("switch", {
			name: "Enable Local model server model local-a",
			exact: true,
		})
	).toBeVisible();
	expect(
		writes(await state(request), "/api/pi-config/discover-models").map((c) => ({
			body: c.body,
			status: c.status,
		}))
	).toEqual(
		[503, 200].map((status) => ({
			body: { provider: "local-model-server" },
			status,
		}))
	);
});
test("individual model refusal leaves enabled state then exact retry and reload show disabled", async ({
	page,
	request,
}) => {
	await control(
		request,
		"refuse",
		"POST",
		"/api/pi-config/providers/model-enabled",
		503
	);
	await page.goto("/provider-connections-native-http.html");
	await open(page, "OpenRouter");
	const toggle = page.getByRole("switch", {
		name: "Enable OpenRouter model remote-model",
		exact: true,
	});
	await expect(toggle).toBeChecked();
	await toggle.click();
	await expect(
		page.getByText("Could not update model", { exact: true })
	).toBeVisible();
	await expect(toggle).toBeChecked();
	expect(
		(await state(request)).catalog.providers.find((p) => p.id === "openrouter")
			?.modelOverrides
	).toBeUndefined();
	await control(
		request,
		"allow",
		"POST",
		"/api/pi-config/providers/model-enabled"
	);
	await toggle.click();
	await expect(toggle).not.toBeChecked();
	expect(
		writes(await state(request), "/api/pi-config/providers/model-enabled").map(
			(c) => ({ body: c.body, status: c.status })
		)
	).toEqual(
		[503, 200].map((status) => ({
			body: { provider: "openrouter", model: "remote-model", enabled: false },
			status,
		}))
	);
	await page.reload();
	await open(page, "OpenRouter");
	await expect(toggle).not.toBeChecked();
});
test("physical OAuth routing priority refusal retries whole policy and fresh GET after reload", async ({
	page,
	request,
}) => {
	const path = "/api/pi-config/providers/chatgpt/account-pool";
	await control(request, "refuse", "PUT", path, 503);
	await page.goto("/provider-connections-native-http.html");
	await open(page, "ChatGPT");
	await page.getByLabel("Strategy").click();
	await page.getByRole("option", { name: "Round robin", exact: true }).click();
	await page.locator("#oauth-priority-chatgpt-b").fill("2");
	await page.getByRole("button", { name: "Save routing", exact: true }).click();
	await expect(
		page.getByText("Could not save account routing", { exact: true })
	).toBeVisible();
	expect((await state(request)).policy).toMatchObject({ strategy: "manual" });
	await control(request, "allow", "PUT", path);
	await page.getByRole("button", { name: "Save routing", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Save routing", exact: true })
	).toBeDisabled();
	const expected = {
		strategy: "round_robin",
		drainThresholdPercent: 80,
		accounts: {
			"chatgpt-a": { enabled: true, priority: 0 },
			"chatgpt-b": { enabled: true, priority: 2 },
		},
	};
	expect((await state(request)).policy).toEqual(expected);
	expect(
		writes(await state(request), path).map((c) => ({
			body: c.body,
			status: c.status,
		}))
	).toEqual([503, 200].map((status) => ({ body: expected, status })));
	await page.reload();
	await open(page, "ChatGPT");
	await expect(page.getByLabel("Strategy")).toContainText("Round robin");
	await expect(page.locator("#oauth-priority-chatgpt-b")).toHaveValue("2");
});
test("physical account switch refuses then identical retry changes only selected self account and reloads", async ({
	page,
	request,
}) => {
	const path = "/api/pi-config/providers/openrouter/accounts/switch";
	await control(request, "refuse", "POST", path, 503);
	await page.goto("/provider-connections-native-http.html");
	await open(page, "OpenRouter");
	await page
		.getByRole("button", { name: "OpenRouter key 2", exact: true })
		.click();
	await page.getByText("Use for yourself", { exact: true }).click();
	await expect(
		page.getByText("Could not switch account", { exact: true })
	).toBeVisible();
	expect(
		(await state(request)).catalog.providers
			.find((p) => p.id === "openrouter")
			?.accounts?.find((a) => a.accountId === "or-a")?.active
	).toBe(true);
	await control(request, "allow", "POST", path);
	await page
		.getByRole("button", { name: "OpenRouter key 2", exact: true })
		.click();
	await page.getByText("Use for yourself", { exact: true }).click();
	await expect(
		page.getByRole("button", { name: /OpenRouter key 2 You/ })
	).toBeVisible();
	const saved = await state(request);
	expect(
		writes(saved, path).map((c) => ({ body: c.body, status: c.status }))
	).toEqual(
		[503, 200].map((status) => ({
			body: { accountId: "or-b", target: "self" },
			status,
		}))
	);
	expect(
		saved.catalog.providers
			.find((p) => p.id === "openrouter")
			?.accounts?.map((a) => ({
				id: a.accountId,
				active: a.active,
				gateway: a.gatewayActive,
			}))
	).toEqual([
		{ id: "or-a", active: false, gateway: false },
		{ id: "or-b", active: true, gateway: false },
	]);
	await page.reload();
	await open(page, "OpenRouter");
	await expect(
		page.getByRole("button", { name: /OpenRouter key 2 You/ })
	).toBeVisible();
});
test("physical account rename writes exact label, retains peer and reloads", async ({
	page,
	request,
}) => {
	const path = "/api/pi-config/providers/openrouter/accounts/rename";
	await control(request, "refuse", "POST", path, 503);
	await page.goto("/provider-connections-native-http.html");
	await open(page, "OpenRouter");
	await page
		.getByRole("button", {
			name: "Rename account OpenRouter key 2",
			exact: true,
		})
		.click();
	await page
		.getByLabel("Label for OpenRouter key 2", { exact: true })
		.fill("Owned renamed key");
	const save = page
		.locator("form")
		.filter({
			has: page.getByLabel("Label for OpenRouter key 2", { exact: true }),
		})
		.getByRole("button", { name: "Save", exact: true });
	await save.click();
	await expect(
		page.getByText("Could not rename account", { exact: true })
	).toBeVisible();
	expect(
		(await state(request)).catalog.providers
			.find((p) => p.id === "openrouter")
			?.accounts?.find((a) => a.accountId === "or-b")?.label
	).toBe("OpenRouter key 2");
	await control(request, "allow", "POST", path);
	await save.click();
	await expect(
		page.getByRole("button", { name: "Owned renamed key", exact: true })
	).toBeVisible();
	expect(writes(await state(request), path).map((c) => c.body)).toEqual([
		{ accountId: "or-b", label: "Owned renamed key" },
		{ accountId: "or-b", label: "Owned renamed key" },
	]);
	await page.reload();
	await open(page, "OpenRouter");
	await expect(
		page.getByRole("button", { name: "Owned renamed key", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /OpenRouter key 1 You/ })
	).toBeVisible();
});
test("physical account removal refusal preserves both accounts then retry removes only requested account", async ({
	page,
	request,
}) => {
	const path = "/api/pi-config/providers/openrouter/accounts/remove";
	await control(request, "refuse", "POST", path, 503);
	await page.goto("/provider-connections-native-http.html");
	await open(page, "OpenRouter");
	await page
		.getByRole("button", { name: "Remove OpenRouter key 2", exact: true })
		.click();
	await expect(
		page.getByText("Could not remove account", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "OpenRouter key 2", exact: true })
	).toBeVisible();
	expect(
		(await state(request)).catalog.providers.find((p) => p.id === "openrouter")
			?.accounts
	).toHaveLength(2);
	await control(request, "allow", "POST", path);
	await page
		.getByRole("button", { name: "Remove OpenRouter key 2", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "OpenRouter key 2", exact: true })
	).toHaveCount(0);
	expect(
		(await state(request)).catalog.providers
			.find((p) => p.id === "openrouter")
			?.accounts?.map((a) => a.accountId)
	).toEqual(["or-a"]);
	expect(
		writes(await state(request), path).map((c) => ({
			body: c.body,
			status: c.status,
		}))
	).toEqual(
		[503, 200].map((status) => ({ body: { accountId: "or-b" }, status }))
	);
	await page.reload();
	await open(page, "OpenRouter");
	await expect(
		page.getByRole("button", { name: "OpenRouter key 2", exact: true })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: /OpenRouter key 1 You/ })
	).toBeVisible();
});
test("provider removal genuineDELETE refusal preserves custom card then retry and reload remove it", async ({
	page,
	request,
}) => {
	const path = "/api/pi-config/providers/local-model-server";
	await control(request, "refuse", "DELETE", path, 503);
	await page.goto("/provider-connections-native-http.html");
	await open(page, "Local model server");
	await page.getByRole("button", { name: "Remove", exact: true }).click();
	await expect(
		page.getByText("Could not remove credential", { exact: true })
	).toBeVisible();
	expect(
		(await state(request)).catalog.providers.some(
			(p) => p.id === "local-model-server"
		)
	).toBe(true);
	await control(request, "allow", "DELETE", path);
	await page.getByRole("button", { name: "Remove", exact: true }).click();
	await expect(cardButton(page, "Local model server")).toHaveCount(0);
	expect(
		writes(await state(request), path).map((c) => ({
			body: c.body,
			status: c.status,
		}))
	).toEqual([
		{ body: null, status: 503 },
		{ body: null, status: 200 },
	]);
	await page.reload();
	await expect(cardButton(page, "Local model server")).toHaveCount(0);
});
test("all-model switch sends every actual model override then reloads both disabled without atomicity claim", async ({
	page,
	request,
}) => {
	await page.goto("/provider-connections-native-http.html");
	await open(page, "Local model server");
	const all = page.getByRole("switch", {
		name: "Enable all Local model server models",
		exact: true,
	});
	await expect(all).toBeChecked();
	await all.click();
	await expect
		.poll(
			async () =>
				(await state(request)).catalog.providers.find(
					(p) => p.id === "local-model-server"
				)?.modelOverrides
		)
		.toEqual({ "local-a": false, "local-b": false });
	await expect(all).not.toBeChecked();
	const actual = writes(
		await state(request),
		"/api/pi-config/providers/model-enabled"
	);
	expect(actual.map((c) => ({ body: c.body, status: c.status }))).toEqual(
		["local-a", "local-b"].map((model) => ({
			body: { provider: "local-model-server", model, enabled: false },
			status: 200,
		}))
	);
	await page.reload();
	await open(page, "Local model server");
	await expect(all).not.toBeChecked();
	await expect(
		page.getByRole("switch", {
			name: "Enable Local model server model local-a",
			exact: true,
		})
	).not.toBeChecked();
	await expect(
		page.getByRole("switch", {
			name: "Enable Local model server model local-b",
			exact: true,
		})
	).not.toBeChecked();
});
test("Gateway account selection persists exact target while preserving personal active account", async ({
	page,
	request,
}) => {
	await page.goto("/provider-connections-native-http.html");
	await open(page, "OpenRouter");
	await page
		.getByRole("button", { name: "OpenRouter key 2", exact: true })
		.click();
	await page.getByText("Set for Gateway", { exact: true }).click();
	await expect
		.poll(async () =>
			(await state(request)).catalog.providers
				.find((p) => p.id === "openrouter")
				?.accounts?.map((a) => ({
					id: a.accountId,
					active: a.active,
					gateway: a.gatewayActive,
				}))
		)
		.toEqual([
			{ id: "or-a", active: true, gateway: false },
			{ id: "or-b", active: false, gateway: true },
		]);
	expect(
		writes(
			await state(request),
			"/api/pi-config/providers/openrouter/accounts/switch"
		).map((c) => c.body)
	).toEqual([{ accountId: "or-b", target: "gateway" }]);
	await page.reload();
	await open(page, "OpenRouter");
	await expect(
		page.getByRole("button", { name: /OpenRouter key 1 You/ })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /OpenRouter key 2 Gateway/ })
	).toBeVisible();
});

for (const refusedModel of ["local-a", "local-b"] as const) {
	test(`bulk model save stops on ${refusedModel} refusal, exposes acknowledged prefix and physically retries remaining choices`, async ({
		page,
		request,
	}) => {
		const path = "/api/pi-config/providers/model-enabled";
		await control(request, "refuse", "POST", path, 503, refusedModel);
		await control(request, "hold", "POST", path);
		await page.goto("/provider-connections-native-http.html");
		await open(page, "Local model server");
		const all = page.getByRole("switch", {
			name: "Enable all Local model server models",
			exact: true,
		});
		const first = page.getByRole("switch", {
			name: "Enable Local model server model local-a",
			exact: true,
		});
		const second = page.getByRole("switch", {
			name: "Enable Local model server model local-b",
			exact: true,
		});
		await expect(first).toBeChecked();
		await expect(second).toBeChecked();
		await all.click();
		await expect
			.poll(async () => writes(await state(request), path).length)
			.toBe(1);
		await expect(all).toBeDisabled();
		await expect(first).toBeDisabled();
		await expect(second).toBeDisabled();
		expect(
			(await state(request)).catalog.providers.find(
				(p) => p.id === "local-model-server"
			)?.modelOverrides
		).toBeUndefined();
		await control(request, "release", "POST", path);
		await expect(
			page.getByText("Could not update all models", { exact: true })
		).toBeVisible();
		await expect(
			page.getByText(
				new RegExp(
					`${refusedModel === "local-a" ? 0 : 1} of 2 model settings saved\\.`
				)
			)
		).toBeVisible();
		const body = (model: string) => ({
			provider: "local-model-server",
			model,
			enabled: false,
		});
		const initial =
			refusedModel === "local-a"
				? [{ body: body("local-a"), status: 503 }]
				: [
						{ body: body("local-a"), status: 200 },
						{ body: body("local-b"), status: 503 },
					];
		expect(
			writes(await state(request), path).map((c) => ({
				body: c.body,
				status: c.status,
			}))
		).toEqual(initial);
		expect(
			(await state(request)).catalog.providers.find(
				(p) => p.id === "local-model-server"
			)?.modelOverrides
		).toEqual(refusedModel === "local-a" ? undefined : { "local-a": false });
		await expect(first).toBeEnabled();
		await expect(second).toBeEnabled();
		if (refusedModel === "local-a") {
			await expect(first).toBeChecked();
		} else {
			await expect(first).not.toBeChecked();
		}
		await expect(second).toBeChecked();
		await control(request, "allow", "POST", path, undefined, refusedModel);
		// After a partial acknowledgement, retry the still-enabled individual model.
		// The already saved choice remains unchanged; no bulk rollback is promised.
		if (refusedModel === "local-a") {
			await all.click();
		} else {
			await second.click();
		}
		await expect
			.poll(
				async () =>
					(await state(request)).catalog.providers.find(
						(p) => p.id === "local-model-server"
					)?.modelOverrides
			)
			.toEqual({ "local-a": false, "local-b": false });
		const retry =
			refusedModel === "local-a"
				? [
						{ body: body("local-a"), status: 200 },
						{ body: body("local-b"), status: 200 },
					]
				: [{ body: body("local-b"), status: 200 }];
		expect(
			writes(await state(request), path).map((c) => ({
				body: c.body,
				status: c.status,
			}))
		).toEqual([...initial, ...retry]);
		await page.reload();
		await open(page, "Local model server");
		await expect(first).not.toBeChecked();
		await expect(second).not.toBeChecked();
		await expect(all).not.toBeChecked();
	});
}
