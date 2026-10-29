import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const STORY_URL = "/provider-login-dialog-proof.html";
// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
function evidencePath(name: string): string {
	const override = process.env.RYU_PROOF_EVIDENCE_DIR;
	if (override) {
		return path.join(override, name);
	}
	return fileURLToPath(
		new URL(
			`../../../docs/proof/test-coverage-sweep-20260924/evidence/${name}`,
			import.meta.url
		)
	);
}
const AUTH_URL_SCREENSHOT_PATH = evidencePath(
	"desktop-provider-login-auth-url.png"
);
const DEVICE_CODE_SCREENSHOT_PATH = evidencePath(
	"desktop-provider-login-device-code.png"
);
const ANSWER_RETRY_SCREENSHOT_PATH = evidencePath(
	"desktop-provider-login-answer-retry.png"
);
const START_ERROR_SCREENSHOT_PATH = evidencePath(
	"desktop-provider-login-start-error-retry.png"
);
const SELECT_PROMPT_SCREENSHOT_PATH = evidencePath(
	"desktop-provider-login-select-prompt.png"
);
const SUCCESS_SCREENSHOT_PATH = evidencePath(
	"desktop-provider-login-success.png"
);

interface ProviderLoginEvent {
	id?: string;
	instructions?: string;
	message?: string;
	prompt?: {
		message: string;
		options?: { id: string; label: string }[];
		placeholder?: string;
		type: string;
	};
	type: string;
	url?: string;
	userCode?: string;
	verificationUri?: string;
}

interface CapturedApiRequest {
	authorization: string | null;
	body: unknown;
	method: string;
	path: string;
}

interface CapturedTauriCall {
	args: unknown;
	command: string;
}

interface ProviderLoginProofSnapshot {
	abortedStreams: string[];
	requests: CapturedApiRequest[];
	streamRequests: string[];
	tauriCalls: CapturedTauriCall[];
}

interface ProviderLoginProofWindow extends Window {
	__providerLoginProof: {
		emitEvent: (sessionId: string, event: ProviderLoginEvent) => void;
		failNextStart: () => void;
		refreshNodeToken: (token: string) => void;
		setAnswerOutcomes: (
			outcomes: { accepted: boolean; error?: string; status?: number }[]
		) => void;
		snapshot: () => ProviderLoginProofSnapshot;
	};
}

async function readSnapshot(page: import("@playwright/test").Page) {
	return page.evaluate(() =>
		/* SAFETY: provider-login-dialog-proof.tsx installs __providerLoginProof before this proof page is evaluated. */ (
			window as ProviderLoginProofWindow
		).__providerLoginProof.snapshot()
	);
}

async function emitEvent(
	page: import("@playwright/test").Page,
	sessionId: string,
	event: ProviderLoginEvent
) {
	await page.evaluate(
		({ sessionId, event }) =>
			/* SAFETY: provider-login-dialog-proof.tsx installs __providerLoginProof before this proof page is evaluated. */ (
				window as ProviderLoginProofWindow
			).__providerLoginProof.emitEvent(sessionId, event),
		{ sessionId, event }
	);
}

async function openLoginDialog(page: import("@playwright/test").Page) {
	await page.goto(STORY_URL);
	await page.getByRole("button", { name: "Open provider login" }).click();
	await expect(page.getByTestId("provider-dialog-state")).toHaveAttribute(
		"data-open",
		"true"
	);
}

async function waitForLoginSession(
	page: import("@playwright/test").Page,
	index = 0
) {
	await expect
		.poll(async () => (await readSnapshot(page)).streamRequests.length)
		.toBe(index + 1);
	return (await readSnapshot(page)).streamRequests[index];
}

function requestsMatching(
	snapshot: ProviderLoginProofSnapshot,
	method: string,
	suffix: string
) {
	return snapshot.requests.filter(
		(request) => request.method === method && request.path.endsWith(suffix)
	);
}

function externalCalls(snapshot: ProviderLoginProofSnapshot) {
	return snapshot.tauriCalls.filter((call) => call.command === "open_external");
}

test("authorization login survives node-token refresh and refreshes provider state on success", async ({
	page,
}) => {
	await page.setViewportSize({ height: 920, width: 1280 });
	await openLoginDialog(page);
	const sessionId = await waitForLoginSession(page);
	const authUrl = "https://login.example.test/authorize?state=fixture-state";
	await emitEvent(page, sessionId, {
		instructions: "Approve access in the browser, then return to Ryu.",
		type: "auth_url",
		url: authUrl,
	});
	// The fallback is a real link to the consent page (Tauri intercepts the
	// click and opens the system browser instead of a webview tab).
	const authorizationLink = page.getByRole("link", {
		name: "Open the authorization page",
		exact: true,
	});
	await expect(authorizationLink).toBeVisible();
	await expect(authorizationLink).toHaveAttribute("href", authUrl);
	await expect(authorizationLink).toHaveAttribute("rel", "noopener noreferrer");
	await expect(
		page.getByText("Approve access in the browser, then return to Ryu.", {
			exact: true,
		})
	).toBeVisible();
	await expect
		.poll(async () => externalCalls(await readSnapshot(page)).at(-1) ?? null)
		.toEqual({ command: "open_external", args: { url: authUrl } });
	await page.screenshot({
		fullPage: true,
		path: AUTH_URL_SCREENSHOT_PATH,
	});

	await authorizationLink.click();
	await expect
		.poll(async () => externalCalls(await readSnapshot(page)).length)
		.toBe(2);

	await page.keyboard.press("Escape");
	await expect(page.getByTestId("provider-dialog-state")).toHaveAttribute(
		"data-open",
		"true"
	);
	const beforeRefresh = await readSnapshot(page);
	expect(
		requestsMatching(
			beforeRefresh,
			"POST",
			"/api/pi-config/providers/openai-codex/login"
		)
	).toHaveLength(1);
	expect(
		requestsMatching(
			beforeRefresh,
			"POST",
			`/api/pi-config/login/${sessionId}/cancel`
		)
	).toHaveLength(0);

	await page.evaluate(() =>
		/* SAFETY: provider-login-dialog-proof.tsx installs __providerLoginProof before this proof page is evaluated. */ (
			window as ProviderLoginProofWindow
		).__providerLoginProof.refreshNodeToken("provider-login-node-token-rotated")
	);
	await expect(page.getByTestId("active-node-token")).toHaveText(
		"provider-login-node-token-rotated"
	);
	const afterRefresh = await readSnapshot(page);
	expect(
		requestsMatching(
			afterRefresh,
			"POST",
			"/api/pi-config/providers/openai-codex/login"
		)
	).toHaveLength(1);
	expect(
		requestsMatching(
			afterRefresh,
			"POST",
			`/api/pi-config/login/${sessionId}/cancel`
		)
	).toHaveLength(0);

	await emitEvent(page, sessionId, {
		id: "authorization-code",
		prompt: {
			message: "Enter the authorization code",
			placeholder: "Code from browser",
			type: "text",
		},
		type: "prompt",
	});
	const answerInput = page.getByRole("textbox", {
		name: "Enter the authorization code",
	});
	await expect(answerInput).toBeVisible();
	await page.evaluate(() =>
		/* SAFETY: provider-login-dialog-proof.tsx installs __providerLoginProof before this proof page is evaluated. */ (
			window as ProviderLoginProofWindow
		).__providerLoginProof.setAnswerOutcomes([
			{
				accepted: false,
				error: "The authorization code was already used.",
				status: 400,
			},
			{ accepted: true },
		])
	);
	await answerInput.fill("used-code");
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	await expect(
		page.getByText("The authorization code was already used.", { exact: true })
	).toBeVisible();
	await expect(answerInput).toHaveValue("used-code");
	await page.screenshot({
		fullPage: true,
		path: ANSWER_RETRY_SCREENSHOT_PATH,
	});

	await answerInput.fill("fresh-code");
	await answerInput.press("Enter");
	await expect(
		page.getByText("The authorization code was already used.", { exact: true })
	).toHaveCount(0);
	await expect(page.getByText("Working…", { exact: true })).toBeVisible();
	const answerRequests = requestsMatching(
		await readSnapshot(page),
		"POST",
		`/api/pi-config/login/${sessionId}/answer`
	);
	expect(answerRequests).toEqual([
		{
			authorization: "Bearer provider-login-node-token-rotated",
			body: { prompt_id: "authorization-code", value: "used-code" },
			method: "POST",
			path: `/api/pi-config/login/${sessionId}/answer`,
		},
		{
			authorization: "Bearer provider-login-node-token-rotated",
			body: { prompt_id: "authorization-code", value: "fresh-code" },
			method: "POST",
			path: `/api/pi-config/login/${sessionId}/answer`,
		},
	]);

	await emitEvent(page, sessionId, { type: "success" });
	await expect(
		page.getByText("Connected. OpenAI Codex is ready to use.", { exact: true })
	).toBeVisible();
	await expect(page.getByTestId("provider-account-state")).toHaveText(
		"Connected"
	);
	await expect(page.getByTestId("provider-refresh-count")).toHaveText("1");
	await page.screenshot({ fullPage: true, path: SUCCESS_SCREENSHOT_PATH });
	await page.getByRole("button", { name: "Done", exact: true }).click();
	await expect(page.getByTestId("provider-dialog-state")).toHaveAttribute(
		"data-open",
		"false"
	);
	await expect
		.poll(
			async () =>
				requestsMatching(await readSnapshot(page), "POST", "/cancel").length
		)
		.toBe(1);
	expect(requestsMatching(await readSnapshot(page), "POST", "/cancel")).toEqual(
		[
			{
				authorization: "Bearer provider-login-node-token-rotated",
				body: null,
				method: "POST",
				path: `/api/pi-config/login/${sessionId}/cancel`,
			},
		]
	);
});

test("device-code login opens its verification page and Cancel cancels the session", async ({
	page,
}) => {
	await page.setViewportSize({ height: 920, width: 1280 });
	await openLoginDialog(page);
	const sessionId = await waitForLoginSession(page);
	const verificationUri = "https://login.example.test/device";
	await emitEvent(page, sessionId, {
		type: "device_code",
		userCode: "ABCD-EFGH",
		verificationUri,
	});
	await expect(
		page.getByText("Enter this code on the verification page:", { exact: true })
	).toBeVisible();
	// The code renders in the read-only OTP display (separator stripped, the
	// way the verification page accepts it); Copy code copies Core's code.
	await expect(
		page.getByRole("textbox", { name: "OpenAI Codex device code" })
	).toHaveValue("ABCDEFGH");
	const copyCode = page.getByRole("button", { name: "Copy code", exact: true });
	await copyCode.click();
	await expect(
		page.getByRole("button", { name: "Copied", exact: true })
	).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		"ABCD-EFGH"
	);
	await expect
		.poll(async () => externalCalls(await readSnapshot(page)).at(-1) ?? null)
		.toEqual({ command: "open_external", args: { url: verificationUri } });
	await page.screenshot({
		fullPage: true,
		path: DEVICE_CODE_SCREENSHOT_PATH,
	});

	await page
		.getByRole("button", {
			name: "Open the verification page",
			exact: true,
		})
		.click();
	await expect
		.poll(async () => externalCalls(await readSnapshot(page)).length)
		.toBe(2);
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(page.getByTestId("provider-dialog-state")).toHaveAttribute(
		"data-open",
		"false"
	);
	await expect
		.poll(
			async () =>
				requestsMatching(await readSnapshot(page), "POST", "/cancel").length
		)
		.toBe(1);
	expect(requestsMatching(await readSnapshot(page), "POST", "/cancel")).toEqual(
		[
			{
				authorization: "Bearer provider-login-node-token-1",
				body: null,
				method: "POST",
				path: `/api/pi-config/login/${sessionId}/cancel`,
			},
		]
	);
});

test("select prompts submit the option id, not its visible label", async ({
	page,
}) => {
	await page.setViewportSize({ height: 920, width: 1280 });
	await openLoginDialog(page);
	const sessionId = await waitForLoginSession(page);
	await emitEvent(page, sessionId, {
		id: "account-choice",
		prompt: {
			message: "Choose the account type",
			options: [
				{ id: "personal-account-id", label: "Personal account" },
				{ id: "work-account-id", label: "Work account" },
			],
			type: "select",
		},
		type: "prompt",
	});
	await expect(
		page.getByText("Choose the account type", { exact: true })
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: SELECT_PROMPT_SCREENSHOT_PATH,
	});
	await page.getByRole("button", { name: "Work account", exact: true }).click();
	await expect(page.getByText("Working…", { exact: true })).toBeVisible();
	expect(
		requestsMatching(
			await readSnapshot(page),
			"POST",
			`/api/pi-config/login/${sessionId}/answer`
		)
	).toEqual([
		{
			authorization: "Bearer provider-login-node-token-1",
			body: { prompt_id: "account-choice", value: "work-account-id" },
			method: "POST",
			path: `/api/pi-config/login/${sessionId}/answer`,
		},
	]);
	await emitEvent(page, sessionId, { type: "success" });
	await expect(page.getByTestId("provider-refresh-count")).toHaveText("1");
	await expect(page.getByTestId("provider-account-state")).toHaveText(
		"Connected"
	);
});

test("a failed start can be retried and a stream error remains dismissible", async ({
	page,
}) => {
	await page.setViewportSize({ height: 920, width: 1280 });
	await page.goto(STORY_URL);
	await page.evaluate(() =>
		/* SAFETY: provider-login-dialog-proof.tsx installs __providerLoginProof before this proof page is evaluated. */ (
			window as ProviderLoginProofWindow
		).__providerLoginProof.failNextStart()
	);
	await page.getByRole("button", { name: "Open provider login" }).click();
	await expect(
		page.getByText("Provider login is temporarily unavailable.", {
			exact: true,
		})
	).toBeVisible();
	await expect(page.getByTestId("provider-dialog-state")).toHaveAttribute(
		"data-open",
		"true"
	);
	await page.screenshot({
		fullPage: true,
		path: START_ERROR_SCREENSHOT_PATH,
	});
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(page.getByTestId("provider-dialog-state")).toHaveAttribute(
		"data-open",
		"false"
	);
	expect(
		requestsMatching(await readSnapshot(page), "POST", "/cancel")
	).toHaveLength(0);

	await page.getByRole("button", { name: "Open provider login" }).click();
	const retrySessionId = await waitForLoginSession(page);
	expect(retrySessionId).toBe("login-session-1");
	expect(
		requestsMatching(
			await readSnapshot(page),
			"POST",
			"/api/pi-config/providers/openai-codex/login"
		)
	).toHaveLength(2);
	await emitEvent(page, retrySessionId, {
		message: "The provider rejected this authorization attempt.",
		type: "error",
	});
	await expect(
		page.getByText("The provider rejected this authorization attempt.", {
			exact: true,
		})
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Close", exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await expect(page.getByTestId("provider-dialog-state")).toHaveAttribute(
		"data-open",
		"false"
	);
	await expect
		.poll(
			async () =>
				requestsMatching(await readSnapshot(page), "POST", "/cancel").length
		)
		.toBe(1);
	expect(requestsMatching(await readSnapshot(page), "POST", "/cancel")).toEqual(
		[
			{
				authorization: "Bearer provider-login-node-token-1",
				body: null,
				method: "POST",
				path: `/api/pi-config/login/${retrySessionId}/cancel`,
			},
		]
	);
});
