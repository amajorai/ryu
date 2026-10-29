import { expect, test } from "@playwright/test";
import { z } from "zod";

interface ProviderProofSnapshot {
	catalog: {
		agentModelOverrides?: Record<string, Record<string, boolean>>;
		providers: Array<{
			accounts?: Array<{
				accountId: string;
				active: boolean;
				gatewayActive?: boolean;
				label: string;
			}>;
			configured: boolean;
			custom: boolean;
			id: string;
			modelOverrides?: Record<string, boolean>;
			routing: string;
		}>;
	};
	config: {
		model: string | null;
		provider: string;
		providerRouting?: Record<string, string>;
		routing: string;
		thinkingLevel: string | null;
	};
	navigation: Array<{ open: boolean; section: string }>;
	preferences: Record<string, string>;
	requests: Array<{ body: unknown; method: string; path: string }>;
	settingsNavigation: Array<{ open: boolean; section: string }>;
	tauriCalls: Array<{ args: unknown; command: string; failed: boolean }>;
}

// Screenshots are run output, not tracked proof: they go to this run's
// Playwright output directory so a rerun never rewrites committed evidence.
const evidence = (name: string) => test.info().outputPath(name);

async function readState(
	page: import("@playwright/test").Page
): Promise<ProviderProofSnapshot> {
	return await page.evaluate(() => {
		const proof =
			/* SAFETY: gateway-ai-providers-proof.tsx installs __gatewayAiProvidersProof before this proof page is evaluated. */ (
				window as Window & {
					__gatewayAiProvidersProof: {
						snapshot: () => ProviderProofSnapshot;
					};
				}
			).__gatewayAiProvidersProof;
		return proof.snapshot();
	});
}

async function armFailure(
	page: import("@playwright/test").Page,
	operation: string
): Promise<void> {
	await page.evaluate((value) => {
		/* SAFETY: gateway-ai-providers-proof.tsx installs __gatewayAiProvidersProof before this proof page is evaluated. */ (
			window as Window & {
				__gatewayAiProvidersProof: {
					armFailure: (name: string) => void;
					failNextExternalLaunch: () => void;
				};
			}
		).__gatewayAiProvidersProof.armFailure(value);
	}, operation);
}

async function failNextExternalLaunch(
	page: import("@playwright/test").Page
): Promise<void> {
	await page.evaluate(() => {
		/* SAFETY: gateway-ai-providers-proof.tsx installs __gatewayAiProvidersProof before this proof page is evaluated. */ (
			window as Window & {
				__gatewayAiProvidersProof: {
					failNextExternalLaunch: () => void;
				};
			}
		).__gatewayAiProvidersProof.failNextExternalLaunch();
	});
}

async function openProvider(
	page: import("@playwright/test").Page,
	provider: string,
	api: string
): Promise<void> {
	await page
		.getByRole("button", { name: "Open provider command center" })
		.click();
	const dialog = page.getByRole("dialog").first();
	await expect(
		dialog.getByRole("option", { name: new RegExp(provider) })
	).toBeVisible();
	await dialog.getByRole("option", { name: new RegExp(provider) }).click();
	await expect(
		page.getByRole("button", { name: new RegExp(`${provider}.*${api}`) })
	).toBeVisible();
	await page
		.getByRole("button", { name: new RegExp(`${provider}.*${api}`) })
		.click();
}

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
	await expect(dialog.getByText(/failed: 503/u)).toBeVisible();
	await dialog.getByRole("button", { name: "Check" }).click();
	await expect(dialog.getByText("OK · 14ms · 3 models")).toBeVisible();

	await armFailure(page, "configure");
	await apiKey.fill("sk-openai-proof");
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
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
	await expect(dialog.getByText("Configured", { exact: true })).toBeVisible();
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

test("completes a subscription provider sign-in prompt and updates the catalog", async ({
	page,
}) => {
	await page.goto("/gateway-ai-providers-proof.html?reset=true");
	await openProvider(page, "Claude Code", "anthropic-messages");
	const providerDialog = page.getByRole("dialog").first();
	await providerDialog.getByRole("button", { name: "Login" }).click();
	const loginDialog = page.getByRole("dialog", {
		name: "Sign in to Claude Code",
	});
	await expect(
		loginDialog.getByText("Choose the subscription profile")
	).toBeVisible();
	await armFailure(page, "login-answer");
	await loginDialog.getByRole("button", { name: "Work subscription" }).click();
	await expect(loginDialog.getByText("profile_rejected")).toBeVisible();
	await loginDialog.getByRole("button", { name: "Work subscription" }).click();
	await expect(
		loginDialog.getByText("Connected. Claude Code is ready to use.")
	).toBeVisible();
	await expect(loginDialog.getByText("profile_rejected")).toHaveCount(0);
	const snapshot = await readState(page);
	expect(
		snapshot.requests.filter((request) =>
			request.path.endsWith("/providers/claude-code/login")
		)
	).toHaveLength(1);
	expect(
		snapshot.requests
			.filter((request) =>
				request.path.endsWith("/login/provider-login-session/answer")
			)
			.map((request) => request.body)
	).toEqual([
		{ prompt_id: "choose-profile", value: "work" },
		{ prompt_id: "choose-profile", value: "work" },
	]);
	expect(
		snapshot.catalog.providers.find((provider) => provider.id === "claude-code")
	).toMatchObject({ configured: true });
	await page.screenshot({
		fullPage: true,
		path: evidence("gateway-ai-providers-subscription-connected.png"),
	});
	await loginDialog.getByRole("button", { name: "Done" }).click();
	await page.reload();
	await openProvider(page, "Claude Code", "anthropic-messages");
	// A connected subscription provider keeps its saved account across reload
	// and offers another sign-in as "Add account" (multi-account OAuth).
	const reopened = page.getByRole("dialog").first();
	await expect(
		reopened.getByText("OAuth connected", { exact: true })
	).toBeVisible();
	await expect(
		reopened.getByRole("button", { name: "Add account", exact: true })
	).toBeVisible();
});

test("submits a text verification prompt with Enter, retries by button, and cancels a pending login", async ({
	page,
}) => {
	await page.goto(
		"/gateway-ai-providers-proof.html?reset=true&loginPrompt=text"
	);
	await openProvider(page, "Claude Code", "anthropic-messages");
	await page
		.getByRole("dialog")
		.first()
		.getByRole("button", { name: "Login" })
		.click();
	let loginDialog = page.getByRole("dialog", {
		name: "Sign in to Claude Code",
	});
	const answer = loginDialog.getByPlaceholder("Paste the code here");
	await expect(answer).toBeVisible();
	await answer.fill("verify-123456");
	const expectedAnswer = {
		body: { prompt_id: "manual-code", value: "verify-123456" },
		method: "POST",
		path: "/api/pi-config/login/provider-login-session/answer",
	};
	await armFailure(page, "login-answer");
	await answer.press("Enter");
	await expect(loginDialog.getByText("profile_rejected")).toBeVisible();
	await expect(answer).toHaveValue("verify-123456");
	let snapshot = await readState(page);
	expect(
		snapshot.requests.filter((request) =>
			request.path.endsWith("/login/provider-login-session/answer")
		)
	).toEqual([expectedAnswer]);
	await page.screenshot({
		fullPage: true,
		path: evidence("gateway-ai-providers-enter-verification-retry.png"),
	});

	await loginDialog
		.getByRole("button", { name: "Continue", exact: true })
		.click();
	await expect(
		loginDialog.getByText("Connected. Claude Code is ready to use.")
	).toBeVisible();
	await expect(loginDialog.getByText("profile_rejected")).toHaveCount(0);
	snapshot = await readState(page);
	expect(
		snapshot.requests.filter((request) =>
			request.path.endsWith("/login/provider-login-session/answer")
		)
	).toEqual([expectedAnswer, expectedAnswer]);

	await page.reload();
	await openProvider(page, "Claude Code", "anthropic-messages");
	await page
		.getByRole("dialog")
		.first()
		.getByRole("button", { name: "Add account", exact: true })
		.click();
	loginDialog = page.getByRole("dialog", { name: "Sign in to Claude Code" });
	await expect(
		loginDialog.getByPlaceholder("Paste the code here")
	).toBeVisible();
	await loginDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(loginDialog).toBeHidden();
	snapshot = await readState(page);
	expect(
		snapshot.requests
			.filter((request) =>
				request.path.endsWith("/login/provider-login-session/cancel")
			)
			.map((request) => request.body)
	).toEqual([null]);
});

test("opens a subscription authorization URL and lets the user retry a failed browser handoff", async ({
	page,
}) => {
	await page.goto(
		"/gateway-ai-providers-proof.html?reset=true&loginFlow=auth-url"
	);
	await openProvider(page, "Claude Code", "anthropic-messages");
	await failNextExternalLaunch(page);
	await page
		.getByRole("dialog")
		.first()
		.getByRole("button", { name: "Login" })
		.click();
	const loginDialog = page.getByRole("dialog", {
		name: "Sign in to Claude Code",
	});
	const authUrl = "https://login.example.test/authorize?state=fixture-state";
	await expect(
		loginDialog.getByText(
			"Approve access in the browser, then return to Ryu.",
			{ exact: true }
		)
	).toBeVisible();
	await expect(loginDialog.getByRole("alert")).toHaveText(
		"Could not open your browser. Use the button below to retry."
	);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidence("gateway-ai-providers-auth-url-launch-error.png"),
	});
	// The authorization page is a real link (href kept for non-Tauri hosts);
	// inside the desktop shell its click is routed through open_external.
	const authorizationLink = loginDialog.getByRole("link", {
		name: "Open the authorization page",
	});
	await expect(authorizationLink).toHaveAttribute("href", authUrl);
	await failNextExternalLaunch(page);
	await authorizationLink.click();
	await expect(loginDialog.getByRole("alert")).toBeVisible();
	await authorizationLink.click();
	await expect(loginDialog.getByRole("alert")).toHaveCount(0);
	let snapshot = await readState(page);
	expect(
		snapshot.requests.filter((request) =>
			request.path.endsWith("/providers/claude-code/login")
		)
	).toEqual([
		{
			body: null,
			method: "POST",
			path: "/api/pi-config/providers/claude-code/login",
		},
	]);
	expect(
		snapshot.tauriCalls.filter((call) => call.command === "open_external")
	).toEqual([
		{
			args: { url: authUrl },
			command: "open_external",
			failed: true,
		},
		{
			args: { url: authUrl },
			command: "open_external",
			failed: true,
		},
		{
			args: { url: authUrl },
			command: "open_external",
			failed: false,
		},
	]);
	await page.screenshot({
		fullPage: true,
		path: evidence("gateway-ai-providers-auth-url-login.png"),
	});
	await loginDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(loginDialog).toBeHidden();
	snapshot = await readState(page);
	expect(
		snapshot.requests.filter((request) =>
			request.path.endsWith("/login/provider-login-session/cancel")
		)
	).toEqual([
		{
			body: null,
			method: "POST",
			path: "/api/pi-config/login/provider-login-session/cancel",
		},
	]);
});

test("shows and launches the subscription device-code verification flow", async ({
	page,
}) => {
	await page.goto(
		"/gateway-ai-providers-proof.html?reset=true&loginFlow=device-code"
	);
	await openProvider(page, "Claude Code", "anthropic-messages");
	await page
		.getByRole("dialog")
		.first()
		.getByRole("button", { name: "Login" })
		.click();
	const loginDialog = page.getByRole("dialog", {
		name: "Sign in to Claude Code",
	});
	const verificationUri = "https://login.example.test/device";
	await expect(
		loginDialog.getByText("Enter this code on the verification page:", {
			exact: true,
		})
	).toBeVisible();
	// The device code renders as a read-only segmented code (ABCD EFGH).
	await expect(
		loginDialog.getByRole("textbox", { name: "Claude Code device code" })
	).toHaveValue("ABCDEFGH");
	await loginDialog
		.getByRole("button", { name: "Open the verification page" })
		.click();
	const snapshot = await readState(page);
	expect(
		snapshot.tauriCalls.filter((call) => call.command === "open_external")
	).toEqual([
		{
			args: { url: verificationUri },
			command: "open_external",
			failed: false,
		},
		{
			args: { url: verificationUri },
			command: "open_external",
			failed: false,
		},
	]);
	await page.screenshot({
		fullPage: true,
		path: evidence("gateway-ai-providers-device-code-login.png"),
	});
	await loginDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(loginDialog).toBeHidden();
});

test("sends a managed-inference user without prepaid credits to the Credits view", async ({
	page,
}) => {
	await page.goto("/gateway-ai-providers-proof.html?reset=true");
	await openProvider(page, "Ryu Managed", "openai-completions");
	const dialog = page.getByRole("dialog").first();
	await expect(
		dialog.getByText("Use Ryu-managed models with prepaid credits")
	).toBeVisible();
	await page.screenshot({
		fullPage: false,
		path: evidence("gateway-ai-providers-prepaid-credit-nudge.png"),
	});
	await dialog
		.getByRole("button", { name: "Add prepaid credits", exact: true })
		.click();
	await expect
		.poll(async () => (await readState(page)).settingsNavigation.at(-1))
		.toEqual({ open: true, section: "credits" });
});

test("keeps external agent model visibility scoped and capability summary read-only", async ({
	page,
}) => {
	await page.goto("/gateway-ai-providers-proof.html?reset=true");
	await page
		.getByRole("button", { name: "Open provider command center" })
		.click();
	const dialog = page.getByRole("dialog").first();
	await expect(
		dialog.getByRole("heading", { name: "Other capabilities" })
	).toHaveCount(1);
	await expect(
		dialog.getByRole("heading", { name: "Media provider keys" })
	).toHaveCount(1);
	await expect(
		dialog.getByText("fal · flux-fast", { exact: true })
	).toBeVisible();
	await expect(dialog.getByText("local", { exact: true })).toBeVisible();
	await expect(
		dialog.getByText("openai · speech-1", { exact: true })
	).toBeVisible();
	await expect(dialog.getByText("Key set", { exact: true })).toHaveCount(1);
	await expect(dialog.getByText("No key", { exact: true })).toHaveCount(1);
	await expect(dialog.getByRole("heading", { name: "Codex" })).toHaveCount(0);
	await dialog
		.getByRole("button", { name: /Codex.*All models visible/u })
		.click();
	await expect(dialog.getByText("Codex Pro", { exact: true })).toBeVisible();
	await dialog
		.getByText("Codex Pro", { exact: true })
		.locator("..")
		.getByRole("switch")
		.click();
	await expect(
		dialog.getByText("1 model hidden", { exact: true })
	).toBeVisible();
	let snapshot = await readState(page);
	expect(
		snapshot.requests
			.filter((request) =>
				request.path.endsWith("/api/pi-config/providers/model-enabled")
			)
			.map((request) => request.body)
	).toEqual([{ provider: "agent:codex", model: "codex-pro", enabled: false }]);

	snapshot = await readState(page);
	expect(
		snapshot.requests.filter(
			(request) =>
				request.path.endsWith("/api/gateway/config") && request.method !== "GET"
		)
	).toEqual([]);
	expect(
		snapshot.requests.filter(
			(request) =>
				(request.path === "/api/preferences/fal-api-key" ||
					request.path === "/api/preferences/replicate-api-key") &&
				request.method !== "GET"
		)
	).toEqual([]);
	await dialog
		.getByRole("heading", { name: "Other capabilities" })
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		fullPage: false,
		path: evidence("gateway-ai-providers-capability-summary.png"),
	});
});

test("opens the Gateway editors from capability and media-key summaries", async ({
	page,
}) => {
	await page.goto("/gateway-ai-providers-proof.html?reset=true");
	await page
		.getByRole("button", { name: "Open provider command center" })
		.click();
	await page
		.getByRole("dialog")
		.first()
		.getByRole("button", { name: "Edit capability routing" })
		.click();
	await expect
		.poll(async () => (await readState(page)).navigation.at(-1))
		.toEqual({ open: true, section: "routing" });

	await page.goto("/gateway-ai-providers-proof.html?reset=true");
	await page
		.getByRole("button", { name: "Open provider command center" })
		.click();
	await page
		.getByRole("dialog")
		.first()
		.getByRole("button", { name: "Manage media keys" })
		.click();
	await expect
		.poll(async () => (await readState(page)).navigation.at(-1))
		.toEqual({ open: true, section: "keys" });
});
