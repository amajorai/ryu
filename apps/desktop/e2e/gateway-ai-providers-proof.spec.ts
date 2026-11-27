import { expect, test } from "@playwright/test";
import { z } from "zod";
import {
	armFailure,
	backToList,
	evidence,
	openListPage,
	openPage,
	openProvider,
	providerRow,
	readState,
} from "./gateway-ai-providers-proof-helpers.ts";

test.describe.configure({ timeout: 90_000 });

test("configures a provider, handles retries, and keeps the active model and routing current", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto("/gateway-ai-providers-proof.html?reset=true");
	await armFailure(page, "discover");
	await openProvider(page, "OpenAI", "openai-completions");
	const opened = openPage(page);
	const meta = opened.locator("[data-provider-page-meta]");
	// A page shows every section at once, in one fixed order: nothing is left
	// to unfold. Without a stored credential there is no danger zone yet.
	await expect(meta).toHaveText("openai-completions · API key · Not connected");
	await expect(opened.locator("[data-provider-page-section]")).toHaveCount(4);
	await expect(
		opened.locator('[data-provider-page-section="danger"]')
	).toHaveCount(0);
	await expect(opened.getByLabel("API key")).toBeVisible();
	await expect(
		opened.getByRole("button", { name: "Discover models" })
	).toBeVisible();
	await expect(page.getByText("Could not discover models")).toBeVisible();
	await opened.getByRole("button", { name: "Discover models" }).click();
	await expect(
		opened.getByText("Models discovered live from the provider.")
	).toBeVisible();

	const apiKey = opened.getByLabel("API key");
	await expect(
		opened.getByRole("button", { name: "Save", exact: true })
	).toBeDisabled();
	await apiKey.fill("   ");
	await expect(
		opened.getByRole("button", { name: "Save", exact: true })
	).toBeDisabled();
	await apiKey.fill("sk-check-only");
	await armFailure(page, "check");
	await opened.getByRole("button", { name: "Check" }).click();
	// The card shows Core's own reason over the generic "<path> failed: <status>"
	// text (errMessage prefers ApiError.serverMessage, which parses legacy string
	// error bodies since the Core error contract landed before Ryu Quiet).
	await expect(opened.getByText("provider_probe_unavailable")).toBeVisible();
	await opened.getByRole("button", { name: "Check" }).click();
	await expect(opened.getByText("OK · 14ms · 3 models")).toBeVisible();

	await armFailure(page, "configure");
	await apiKey.fill("sk-openai-proof");
	// Saving a key needs the spending-limit acknowledgement (SpendLimitConfirm).
	const save = opened.getByRole("button", { name: "Save", exact: true });
	await expect(save).toBeDisabled();
	await opened
		.getByRole("checkbox", {
			name: "I have set a spending limit for this key at OpenAI",
		})
		.click();
	await save.click();
	await expect(page.getByText("Could not save credential")).toBeVisible();
	await expect(apiKey).toHaveValue("sk-openai-proof");
	let snapshot = await readState(page);
	expect(
		snapshot.requests.filter(
			(request) =>
				request.path.endsWith("/api/pi-config/providers") &&
				request.method === "POST"
		)
	).toEqual([
		{
			body: { provider: "openai", apiKey: "sk-openai-proof" },
			method: "POST",
			path: "/api/pi-config/providers",
		},
	]);

	await opened.getByRole("button", { name: "Save", exact: true }).click();
	// The saved state reads in the line under the page title: the kind of
	// provider and the account its key belongs to. Remove appears in the
	// danger zone, the last section, and nowhere else.
	await expect(meta).toHaveText(
		"openai-completions · API key · work@example.com"
	);
	await expect(
		opened
			.locator('[data-provider-page-section="danger"]')
			.getByRole("button", { name: "Remove", exact: true })
	).toBeVisible();
	await expect(
		opened.getByRole("button", { name: "Remove", exact: true })
	).toHaveCount(1);
	await expect(apiKey).toHaveValue("");
	await armFailure(page, "configure");
	await opened.getByRole("switch", { name: "Route through Gateway" }).click();
	await expect(page.getByText("Could not update routing")).toBeVisible();
	await expect(
		opened.getByRole("switch", { name: "Route through Gateway" })
	).not.toBeChecked();
	await opened.getByRole("switch", { name: "Route through Gateway" }).click();
	await expect(
		opened.getByRole("switch", { name: "Route through Gateway" })
	).toBeChecked();
	const modelSwitch = opened.getByRole("switch", {
		name: "Enable OpenAI model GPT-4.1 mini",
	});
	await armFailure(page, "model-enabled");
	await modelSwitch.click();
	await expect(page.getByText("Could not update model")).toBeVisible();
	await expect(modelSwitch).toBeChecked();
	await modelSwitch.click();
	await expect(modelSwitch).not.toBeChecked();
	await expect(
		opened.getByText("Some disabled", { exact: true })
	).toBeVisible();

	const modelPicker = opened.getByRole("combobox", { name: "Model" });
	await modelPicker.click();
	await page.getByRole("option", { name: "GPT-4.1", exact: true }).click();
	await expect(modelPicker).toContainText("GPT-4.1");
	await opened
		.getByPlaceholder("Or type any model id")
		.fill("custom-llm-preview");
	const thinkingPicker = opened.getByRole("combobox", {
		name: "Thinking level",
	});
	await thinkingPicker.click();
	await page.getByRole("option", { name: "high", exact: true }).click();
	await opened.getByText("Enabled models", { exact: true }).click();
	await expect(
		page.getByRole("option", { name: "high", exact: true })
	).toHaveCount(0);

	await armFailure(page, "activate");
	await opened.getByRole("button", { name: "Use this provider" }).click();
	await expect(page.getByText("Could not activate provider")).toBeVisible();
	const failedActivation = await readState(page);
	expect(failedActivation.config.provider).toBe("local");
	await opened.getByRole("button", { name: "Use this provider" }).click();
	await expect(opened.getByRole("button", { name: "In use" })).toBeDisabled();

	snapshot = await readState(page);
	const providerPosts = snapshot.requests.filter(
		(request) =>
			request.path.endsWith("/api/pi-config/providers") &&
			request.method === "POST"
	);
	expect(providerPosts).toEqual([
		{
			body: { provider: "openai", apiKey: "sk-openai-proof" },
			method: "POST",
			path: "/api/pi-config/providers",
		},
		{
			body: { provider: "openai", apiKey: "sk-openai-proof" },
			method: "POST",
			path: "/api/pi-config/providers",
		},
		{
			body: { provider: "openai", routing: "gateway" },
			method: "POST",
			path: "/api/pi-config/providers",
		},
		{
			body: { provider: "openai", routing: "gateway" },
			method: "POST",
			path: "/api/pi-config/providers",
		},
	]);
	expect(
		snapshot.requests
			.filter((request) =>
				request.path.endsWith("/api/pi-config/providers/model-enabled")
			)
			.map((request) => request.body)
	).toEqual([
		{ provider: "openai", model: "gpt-4.1-mini", enabled: false },
		{ provider: "openai", model: "gpt-4.1-mini", enabled: false },
	]);
	const checkPosts = snapshot.requests.filter((request) =>
		request.path.endsWith("/api/pi-config/providers/check")
	);
	expect(checkPosts.map((request) => request.body)).toEqual([
		{ provider: "openai", apiKey: "sk-check-only" },
		{ provider: "openai", apiKey: "sk-check-only" },
	]);
	const discoveryPosts = snapshot.requests.filter((request) =>
		request.path.endsWith("/api/pi-config/discover-models")
	);
	expect(discoveryPosts.map((request) => request.body)).toEqual([
		{ provider: "openai" },
		{ provider: "openai" },
	]);
	const activatePosts = snapshot.requests.filter(
		(request) =>
			request.path.endsWith("/api/pi-config") && request.method === "PUT"
	);
	expect(activatePosts.map((request) => request.body)).toEqual([
		{
			provider: "openai",
			model: "custom-llm-preview",
			thinkingLevel: "high",
			api: "openai-completions",
		},
		{
			provider: "openai",
			model: "custom-llm-preview",
			thinkingLevel: "high",
			api: "openai-completions",
		},
	]);
	expect(snapshot.config).toMatchObject({
		model: "custom-llm-preview",
		provider: "openai",
		thinkingLevel: "high",
	});
	await page.screenshot({
		fullPage: true,
		path: evidence("gateway-ai-providers-active-openai.png"),
	});

	await page.reload();
	await openProvider(page, "OpenAI", "openai-completions");
	const reloaded = openPage(page);
	await expect(reloaded.getByRole("button", { name: "In use" })).toBeDisabled();
	await expect(reloaded.getByRole("combobox", { name: "Model" })).toContainText(
		"custom-llm-preview"
	);
	await expect(
		reloaded.getByRole("switch", { name: "Route through Gateway" })
	).toBeChecked();
	await expect(
		reloaded.getByRole("switch", {
			name: "Enable OpenAI model GPT-4.1 mini",
		})
	).not.toBeChecked();
	await reloaded
		.getByRole("switch", { name: "Enable all OpenAI models" })
		.click();
	await expect(
		reloaded.getByRole("switch", { name: "Enable all OpenAI models" })
	).toBeChecked();
	snapshot = await readState(page);
	const modelVisibilityWrites = snapshot.requests
		.filter((request) =>
			request.path.endsWith("/api/pi-config/providers/model-enabled")
		)
		.map((request) =>
			z
				.object({
					enabled: z.boolean(),
					model: z.string(),
					provider: z.string(),
				})
				.parse(request.body)
		)
		.sort((a, b) => a.model.localeCompare(b.model));
	expect(modelVisibilityWrites).toEqual(
		[
			{ provider: "openai", model: "gpt-4.1", enabled: true },
			{ provider: "openai", model: "gpt-4.1-mini", enabled: true },
			{ provider: "openai", model: "gpt-4o-mini", enabled: true },
			{ provider: "openai", model: "custom-llm-preview", enabled: true },
		].sort((a, b) => a.model.localeCompare(b.model))
	);
	await armFailure(page, "delete-provider");
	await reloaded.getByRole("button", { name: "Remove", exact: true }).click();
	await expect(page.getByText("Could not remove credential")).toBeVisible();
	await expect(
		reloaded.getByRole("button", { name: "Remove", exact: true })
	).toBeVisible();
	await reloaded.getByRole("button", { name: "Remove", exact: true }).click();
	await expect(
		reloaded.getByRole("button", { name: "Remove", exact: true })
	).toHaveCount(0);
	snapshot = await readState(page);
	expect(
		snapshot.requests.filter(
			(request) =>
				request.path.endsWith("/api/pi-config/providers/openai") &&
				request.method === "DELETE"
		)
	).toHaveLength(2);
	await expect(pageErrors).toEqual([]);
});

test("adds and removes a custom compatible provider with normalized values and reload persistence", async ({
	page,
}) => {
	await page.goto("/gateway-ai-providers-proof.html?reset=true");
	await openListPage(page, "capabilities");
	const opened = openPage(page);
	await expect(
		opened.getByRole("heading", { name: "Other capabilities" })
	).toHaveCount(1);
	await expect(opened.getByText("Key set", { exact: true })).toHaveCount(1);
	await expect(opened.getByText("No key", { exact: true })).toHaveCount(1);
	await backToList(page);
	await expect(
		page.locator('[data-provider-page-row="capabilities"]')
	).toBeFocused();
	await openListPage(page, "custom-provider");
	const initialState = await readState(page);
	const initialWrites = initialState.requests.filter(
		(request) =>
			request.method !== "GET" &&
			(request.path.startsWith("/api/pi-config") ||
				request.path.startsWith("/api/gateway"))
	);
	await expect(
		opened.getByRole("button", { name: "Add provider" })
	).toBeDisabled();
	await opened.getByLabel("Provider id").fill(" ollama ");
	await expect(
		opened.getByRole("button", { name: "Add provider" })
	).toBeDisabled();
	await opened.getByLabel("Provider id").fill(" my-ollama ");
	await expect(
		opened.getByRole("button", { name: "Add provider" })
	).toBeDisabled();
	await opened.getByLabel("Base URL").fill(" http://127.0.0.1:11434/v1 ");
	await opened.getByLabel("API key (optional)").fill(" custom-key ");
	await opened.getByRole("combobox", { name: "API type" }).click();
	await page
		.getByRole("option", { name: "openai-responses", exact: true })
		.click();
	// A keyed custom provider stays blocked until the spending-limit
	// acknowledgement (SpendLimitConfirm) is ticked; a keyless one does not.
	await expect(
		opened.getByRole("button", { name: "Add provider" })
	).toBeDisabled();
	await opened
		.getByRole("checkbox", {
			name: "I have set a spending limit for this key at this provider",
		})
		.click();
	await armFailure(page, "configure");
	await opened.getByRole("button", { name: "Add provider" }).click();
	await expect(page.getByText("Could not add provider")).toBeVisible();
	await expect(opened.getByLabel("Provider id")).toHaveValue(" my-ollama ");
	await expect(opened.getByLabel("Base URL")).toHaveValue(
		" http://127.0.0.1:11434/v1 "
	);
	await expect(opened.getByLabel("API key (optional)")).toHaveValue(
		" custom-key "
	);
	await opened.getByRole("button", { name: "Add provider" }).click();
	// The new provider joins the list, and the list comes back on its row.
	await expect(providerRow(page, "my-ollama")).toBeFocused();
	let snapshot = await readState(page);
	const customPosts = snapshot.requests.filter(
		(request) =>
			request.path.endsWith("/api/pi-config/providers") &&
			request.method === "POST"
	);
	expect(customPosts).toEqual([
		{
			body: {
				provider: "my-ollama",
				baseUrl: "http://127.0.0.1:11434/v1",
				apiKey: "custom-key",
				api: "openai-responses",
			},
			method: "POST",
			path: "/api/pi-config/providers",
		},
		{
			body: {
				provider: "my-ollama",
				baseUrl: "http://127.0.0.1:11434/v1",
				apiKey: "custom-key",
				api: "openai-responses",
			},
			method: "POST",
			path: "/api/pi-config/providers",
		},
	]);
	expect(initialWrites).toEqual([]);
	await page.reload();
	const search = page.getByPlaceholder("Search providers and models…");
	await search.fill("my-ollama");
	await expect(page.locator("[data-provider-page-row]")).toHaveCount(1);
	await expect(providerRow(page, "my-ollama")).toBeVisible();
	await search.fill("no such provider");
	await expect(page.locator("[data-provider-page-row]")).toHaveCount(0);
	await expect(page.locator("[data-provider-list-empty]")).toHaveText(
		"Nothing matches your search."
	);
	await search.fill("");
	await openProvider(page, "my-ollama", "openai-responses");
	await openPage(page)
		.getByRole("button", { name: "Remove", exact: true })
		.click();
	// A removed custom provider leaves the catalog: its page closes and the
	// list takes the focus on its first control.
	await expect(page.locator("[data-provider-list]")).toBeVisible();
	await expect(providerRow(page, "my-ollama")).toHaveCount(0);
	await expect(search).toBeFocused();
	snapshot = await readState(page);
	expect(
		snapshot.requests.filter(
			(request) =>
				request.method === "DELETE" &&
				request.path.endsWith("/providers/my-ollama")
		)
	).toHaveLength(1);
	await page.screenshot({
		fullPage: true,
		path: evidence("gateway-ai-providers-custom-provider-removed.png"),
	});
});

test("validates custom provider identity and URL while allowing a keyless local endpoint", async ({
	page,
}) => {
	await page.goto("/gateway-ai-providers-proof.html?reset=true");
	await openListPage(page, "custom-provider");
	const opened = openPage(page);
	const addProvider = opened.getByRole("button", { name: "Add provider" });
	await expect(addProvider).toBeDisabled();
	await opened.getByLabel("Provider id").fill("local-llama");
	await expect(addProvider).toBeDisabled();
	await opened.getByLabel("Base URL").fill("http://127.0.0.1:11434/v1");
	await expect(addProvider).toBeEnabled();
	await opened.getByRole("button", { name: "Add provider" }).click();
	// No key is needed, so the new row is connected at once and says so.
	await expect(providerRow(page, "local-llama")).toBeFocused();
	await expect(providerRow(page, "local-llama")).toContainText(
		"Custom · Ready"
	);
	const snapshot = await readState(page);
	expect(
		snapshot.requests.filter(
			(request) =>
				request.method === "POST" &&
				request.path.endsWith("/api/pi-config/providers")
		)
	).toEqual([
		{
			body: {
				provider: "local-llama",
				baseUrl: "http://127.0.0.1:11434/v1",
				apiKey: null,
				api: "openai-completions",
			},
			method: "POST",
			path: "/api/pi-config/providers",
		},
	]);
	expect(
		snapshot.catalog.providers.find((provider) => provider.id === "local-llama")
	).toMatchObject({ custom: true, configured: false });

	await page.reload();
	await expect(providerRow(page, "local-llama")).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: evidence("gateway-ai-providers-keyless-custom-provider.png"),
	});
});

test("switches an account, reports a failed switch for retry, and enforces permission and managed read-only", async ({
	page,
}) => {
	await page.goto("/gateway-ai-providers-proof.html?reset=true");
	await openProvider(page, "OpenAI", "openai-completions");
	// The account's own row opens its menu. Rename and remove are separate
	// buttons whose names start with their verb.
	const accountRow = openPage(page).getByRole("button", {
		name: /^work@example\.com/u,
	});
	await armFailure(page, "switch-account");
	await accountRow.click();
	await page.getByRole("menuitem", { name: /^Set for Gateway/u }).click();
	await expect(page.getByText("Could not switch account")).toBeVisible();
	await accountRow.click();
	await page.getByRole("menuitem", { name: /^Set for Gateway/u }).click();
	await expect(accountRow).toContainText("Gateway");
	let snapshot = await readState(page);
	expect(
		snapshot.requests
			.filter((request) => request.path.endsWith("/accounts/switch"))
			.map((request) => request.body)
	).toEqual([
		{ accountId: "openai-work", target: "gateway" },
		{ accountId: "openai-work", target: "gateway" },
	]);
	expect(
		snapshot.catalog.providers.find((provider) => provider.id === "openai")
			?.accounts?.[0]
	).toMatchObject({ gatewayActive: true, accountId: "openai-work" });
	await page.getByRole("button", { name: "Remove work@example.com" }).click();
	await expect(accountRow).toHaveCount(0);
	snapshot = await readState(page);
	expect(
		snapshot.requests
			.filter((request) => request.path.endsWith("/accounts/remove"))
			.map((request) => request.body)
	).toEqual([{ accountId: "openai-work" }]);
	expect(
		snapshot.catalog.providers.find((provider) => provider.id === "openai")
			?.accounts
	).toEqual([]);

	for (const suffix of ["permission=denied", "managed=true"]) {
		await page.goto(`/gateway-ai-providers-proof.html?reset=true&${suffix}`);
		await openProvider(page, "OpenAI", "openai-completions");
		await accountRow.click();
		const gatewayAccountOption = page.getByRole("menuitem", {
			name: /Set for Gateway \(admin only\)/u,
		});
		await expect(gatewayAccountOption).toBeDisabled();
		const before = await readState(page);
		await page.getByRole("menuitem", { name: /^Use for yourself/u }).click();
		await expect(page.getByRole("menuitem")).toHaveCount(0);
		snapshot = await readState(page);
		expect(
			snapshot.requests.filter((request) =>
				request.path.endsWith("/accounts/switch")
			)
		).toHaveLength(1);
		expect(
			snapshot.requests.filter((request) =>
				request.path.endsWith("/accounts/switch")
			)[0]?.body
		).toEqual({ accountId: "openai-work", target: "self" });
		expect(
			before.requests.filter((request) =>
				request.path.endsWith("/accounts/switch")
			)
		).toEqual([]);
	}
});
