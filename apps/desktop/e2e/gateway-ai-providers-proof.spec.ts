import { expect, test } from "@playwright/test";
import { z } from "zod";
import {
	armFailure,
	evidence,
	openProvider,
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
	const dialog = page.getByRole("dialog").first();
	const openaiCard = dialog.getByRole("button", {
		name: /OpenAI.*openai-completions/u,
	});
	await expect(openaiCard).toHaveAttribute("aria-expanded", "true");
	await openaiCard.click();
	await expect(openaiCard).toHaveAttribute("aria-expanded", "false");
	await expect(dialog.getByLabel("API key")).toBeHidden();
	await openaiCard.click();
	await expect(openaiCard).toHaveAttribute("aria-expanded", "true");
	await expect(dialog.getByLabel("API key")).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: "Discover models" })
	).toBeVisible();
	await expect(page.getByText("Could not discover models")).toBeVisible();
	await dialog.getByRole("button", { name: "Discover models" }).click();
	await expect(
		dialog.getByText("Models discovered live from the provider.")
	).toBeVisible();

	const apiKey = dialog.getByLabel("API key");
	await expect(
		dialog.getByRole("button", { name: "Save", exact: true })
	).toBeDisabled();
	await apiKey.fill("   ");
	await expect(
		dialog.getByRole("button", { name: "Save", exact: true })
	).toBeDisabled();
	await apiKey.fill("sk-check-only");
	await armFailure(page, "check");
	await dialog.getByRole("button", { name: "Check" }).click();
	// The card shows Core's own reason over the generic "<path> failed: <status>"
	// text (errMessage prefers ApiError.serverMessage, which parses legacy string
	// error bodies since the Core error contract landed before Ryu Quiet).
	await expect(dialog.getByText("provider_probe_unavailable")).toBeVisible();
	await dialog.getByRole("button", { name: "Check" }).click();
	await expect(dialog.getByText("OK · 14ms · 3 models")).toBeVisible();

	await armFailure(page, "configure");
	await apiKey.fill("sk-openai-proof");
	// Saving a key needs the spending-limit acknowledgement (SpendLimitConfirm).
	const save = dialog.getByRole("button", { name: "Save", exact: true });
	await expect(save).toBeDisabled();
	await dialog
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

	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	// 1ca1de7ee8 (Ryu Quiet) folded the "Configured" badge into the card's meta
	// line, so the saved state reads in the provider card's caption.
	await expect(openaiCard).toContainText("openai-completions · Configured");
	await expect(apiKey).toHaveValue("");
	await armFailure(page, "configure");
	await dialog.getByRole("switch", { name: "Route through Gateway" }).click();
	await expect(page.getByText("Could not update routing")).toBeVisible();
	await expect(
		dialog.getByRole("switch", { name: "Route through Gateway" })
	).not.toBeChecked();
	await dialog.getByRole("switch", { name: "Route through Gateway" }).click();
	await expect(
		dialog.getByRole("switch", { name: "Route through Gateway" })
	).toBeChecked();
	const modelSwitch = dialog.getByRole("switch", {
		name: "Enable OpenAI model GPT-4.1 mini",
	});
	await armFailure(page, "model-enabled");
	await modelSwitch.click();
	await expect(page.getByText("Could not update model")).toBeVisible();
	await expect(modelSwitch).toBeChecked();
	await modelSwitch.click();
	await expect(modelSwitch).not.toBeChecked();
	await expect(
		dialog.getByText("Some disabled", { exact: true })
	).toBeVisible();

	const modelPicker = dialog.getByRole("combobox", { name: "Model" });
	await modelPicker.click();
	await page.getByRole("option", { name: "GPT-4.1", exact: true }).click();
	await expect(modelPicker).toContainText("GPT-4.1");
	await dialog
		.getByPlaceholder("Or type any model id")
		.fill("custom-llm-preview");
	const thinkingPicker = dialog.getByRole("combobox", {
		name: "Thinking level",
	});
	await thinkingPicker.click();
	await page.getByRole("option", { name: "high", exact: true }).click();
	await dialog.getByText("Enabled models", { exact: true }).click();
	await expect(
		page.getByRole("option", { name: "high", exact: true })
	).toHaveCount(0);

	await armFailure(page, "activate");
	await dialog.getByRole("button", { name: "Use this provider" }).click();
	await expect(page.getByText("Could not activate provider")).toBeVisible();
	const failedActivation = await readState(page);
	expect(failedActivation.config.provider).toBe("local");
	await dialog.getByRole("button", { name: "Use this provider" }).click();
	await expect(dialog.getByRole("button", { name: "In use" })).toBeDisabled();

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
	const reloadedDialog = page.getByRole("dialog").first();
	await expect(
		reloadedDialog.getByRole("button", { name: "In use" })
	).toBeDisabled();
	await expect(
		reloadedDialog.getByRole("combobox", { name: "Model" })
	).toContainText("custom-llm-preview");
	await expect(
		reloadedDialog.getByRole("switch", { name: "Route through Gateway" })
	).toBeChecked();
	await expect(
		reloadedDialog.getByRole("switch", {
			name: "Enable OpenAI model GPT-4.1 mini",
		})
	).not.toBeChecked();
	await reloadedDialog
		.getByRole("switch", { name: "Enable all OpenAI models" })
		.click();
	await expect(
		reloadedDialog.getByRole("switch", { name: "Enable all OpenAI models" })
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
	await reloadedDialog
		.getByRole("button", { name: "Remove", exact: true })
		.click();
	await expect(page.getByText("Could not remove credential")).toBeVisible();
	await expect(
		reloadedDialog.getByRole("button", { name: "Remove", exact: true })
	).toBeVisible();
	await reloadedDialog
		.getByRole("button", { name: "Remove", exact: true })
		.click();
	await expect(
		reloadedDialog.getByRole("button", { name: "Remove", exact: true })
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
	await page
		.getByRole("button", { name: "Open provider command center" })
		.click();
	const command = page.getByRole("dialog").first();
	await expect(
		command.getByRole("heading", { name: "Other capabilities" })
	).toHaveCount(1);
	await expect(command.getByText("Key set", { exact: true })).toHaveCount(1);
	await expect(command.getByText("No key", { exact: true })).toHaveCount(1);
	const initialState = await readState(page);
	const initialWrites = initialState.requests.filter(
		(request) =>
			request.method !== "GET" &&
			(request.path.startsWith("/api/pi-config") ||
				request.path.startsWith("/api/gateway"))
	);
	await expect(
		command.getByRole("button", { name: "Add provider" })
	).toBeDisabled();
	await command.getByLabel("Provider id").fill(" ollama ");
	await expect(
		command.getByRole("button", { name: "Add provider" })
	).toBeDisabled();
	await command.getByLabel("Provider id").fill(" my-ollama ");
	await expect(
		command.getByRole("button", { name: "Add provider" })
	).toBeDisabled();
	await command.getByLabel("Base URL").fill(" http://127.0.0.1:11434/v1 ");
	await command.getByLabel("API key (optional)").fill(" custom-key ");
	await command.getByRole("combobox", { name: "API type" }).click();
	await page
		.getByRole("option", { name: "openai-responses", exact: true })
		.click();
	// A keyed custom provider stays blocked until the spending-limit
	// acknowledgement (SpendLimitConfirm) is ticked; a keyless one does not.
	await expect(
		command.getByRole("button", { name: "Add provider" })
	).toBeDisabled();
	await command
		.getByRole("checkbox", {
			name: "I have set a spending limit for this key at this provider",
		})
		.click();
	await armFailure(page, "configure");
	await command.getByRole("button", { name: "Add provider" }).click();
	await expect(page.getByText("Could not add provider")).toBeVisible();
	await expect(command.getByLabel("Provider id")).toHaveValue(" my-ollama ");
	await expect(command.getByLabel("Base URL")).toHaveValue(
		" http://127.0.0.1:11434/v1 "
	);
	await expect(command.getByLabel("API key (optional)")).toHaveValue(
		" custom-key "
	);
	await command.getByRole("button", { name: "Add provider" }).click();
	await expect(
		command.getByRole("option", { name: /my-ollama/u })
	).toBeVisible();
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
	await page
		.getByRole("button", { name: "Open provider command center" })
		.click();
	const reloadedCommand = page.getByRole("dialog").first();
	const search = reloadedCommand.getByPlaceholder(
		"Search providers and models…"
	);
	await search.fill("my-ollama");
	await expect(
		reloadedCommand.getByRole("option", { name: /my-ollama/u })
	).toBeVisible();
	await search.fill("");
	await reloadedCommand.getByRole("option", { name: /my-ollama/u }).click();
	await expect(
		page.getByRole("button", { name: /my-ollama.*openai-responses/u })
	).toBeVisible();
	await page
		.getByRole("button", { name: /my-ollama.*openai-responses/u })
		.click();
	await page
		.getByRole("dialog")
		.first()
		.getByRole("button", { name: "Remove" })
		.click();
	await expect(
		page
			.getByRole("dialog")
			.first()
			.getByRole("option", { name: /my-ollama/u })
	).toHaveCount(0);
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
	await page
		.getByRole("button", { name: "Open provider command center" })
		.click();
	let command = page.getByRole("dialog").first();
	const addProvider = command.getByRole("button", { name: "Add provider" });
	await expect(addProvider).toBeDisabled();
	await command.getByLabel("Provider id").fill("local-llama");
	await expect(addProvider).toBeDisabled();
	await command.getByLabel("Base URL").fill("http://127.0.0.1:11434/v1");
	await expect(addProvider).toBeEnabled();
	await command.getByRole("button", { name: "Add provider" }).click();
	await expect(
		command.getByRole("option", { name: /local-llama/u })
	).toBeVisible();
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
	await page
		.getByRole("button", { name: "Open provider command center" })
		.click();
	command = page.getByRole("dialog").first();
	await expect(
		command.getByRole("option", { name: /local-llama/u })
	).toBeVisible();
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
	let dialog = page.getByRole("dialog").first();
	await dialog.getByRole("option", { name: /work@example.com/u }).click();
	await armFailure(page, "switch-account");
	await page.getByRole("option", { name: "Set for Gateway" }).click();
	await expect(page.getByText("Could not switch account")).toBeVisible();
	await openProvider(page, "OpenAI", "openai-completions");
	dialog = page.getByRole("dialog").first();
	await dialog.getByRole("option", { name: /work@example.com/u }).click();
	await page.getByRole("option", { name: "Set for Gateway" }).click();
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
	await openProvider(page, "OpenAI", "openai-completions");
	await page.getByRole("button", { name: "Remove work@example.com" }).click();
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
		dialog = page.getByRole("dialog").first();
		await dialog.getByRole("option", { name: /work@example.com/u }).click();
		const gatewayAccountOption = page.getByRole("option", {
			name: /Set for Gateway \(admin only\)/u,
		});
		await expect(gatewayAccountOption).toBeDisabled();
		const before = await readState(page);
		await page.getByRole("option", { name: "Use for yourself" }).click();
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
