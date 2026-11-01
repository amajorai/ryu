import { expect, test } from "@playwright/test";
import {
	armFailure,
	evidence,
	failNextExternalLaunch,
	openProvider,
	readState,
} from "./gateway-ai-providers-proof-helpers.ts";

test.describe.configure({ timeout: 90_000 });

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
