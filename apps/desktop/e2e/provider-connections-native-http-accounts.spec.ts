import { expect, test } from "@playwright/test";
import {
	cardButton,
	control,
	open,
	registerProviderProofHooks,
	state,
	writes,
} from "./provider-connections-native-http-support.ts";

registerProviderProofHooks();
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
