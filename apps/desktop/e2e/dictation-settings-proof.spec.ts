import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { z } from "zod";

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
	status: number | null;
}

interface DictationProofSnapshot {
	appEnabled: boolean;
	preferences: Record<string, string>;
	requests: CapturedRequest[];
	tauriCalls: Array<{ args: unknown; command: string }>;
}

interface DictationProofWindow {
	__dictationSettingsProof: {
		armFailure: (method: string, path: string, status?: number) => void;
		snapshot: () => DictationProofSnapshot;
	};
}

// Verification runs set RYU_PROOF_OUTPUT_ROOT so screenshots land in scratch
// space instead of rewriting the tracked sweep evidence.
const evidence = (name: string) =>
	process.env.RYU_PROOF_OUTPUT_ROOT
		? path.resolve(process.env.RYU_PROOF_OUTPUT_ROOT, name)
		: path.resolve(
				import.meta.dirname,
				"../../../docs/proof/test-coverage-sweep-20260924/evidence",
				name
			);

const emptySelection = {
	access_mode: "",
	agent_id: "",
	effort: "",
	model: "",
	provider: "",
	thinking_level: "",
};

const defaultPreferences = {
	ask: {
		enabled: false,
		mode: "push-to-talk",
		prompt:
			"You answer the user's spoken question. Be concise and directly useful. Output ONLY the answer text that should be pasted into their focused app — no preamble, no quotes, no commentary about the fact they dictated.",
		selection: emptySelection,
		shortcut: "CommandOrControl+Shift+A",
	},
	autoSend: false,
	enabled: true,
	engine: "parakeet",
	insertMode: "type",
	mode: "push-to-talk",
	pasteKeys: "",
	postProcess: {
		enabled: true,
		prompt:
			"You clean up dictated speech into polished written text. Fix grammar, punctuation, and capitalization, and remove filler words (um, uh, like, you know) and false starts. Preserve the original meaning and wording as much as possible. Output ONLY the cleaned text, with no preamble, quotes, or commentary.",
		selection: emptySelection,
	},
	restoreClipboard: true,
	shortcut: "CommandOrControl+Shift+D",
};

const selectionSchema = z.object({
	access_mode: z.string(),
	agent_id: z.string(),
	effort: z.string(),
	model: z.string(),
	provider: z.string(),
	thinking_level: z.string(),
});
const dictationSchema = z.object({
	ask: z.object({
		enabled: z.boolean(),
		mode: z.string(),
		prompt: z.string(),
		selection: selectionSchema,
		shortcut: z.string(),
	}),
	autoSend: z.boolean(),
	enabled: z.boolean(),
	engine: z.string(),
	insertMode: z.string(),
	mode: z.string(),
	pasteKeys: z.string(),
	postProcess: z.object({
		enabled: z.boolean(),
		prompt: z.string(),
		selection: selectionSchema,
	}),
	restoreClipboard: z.boolean(),
	shortcut: z.string(),
});
async function readSnapshot(page: Page): Promise<DictationProofSnapshot> {
	return await page.evaluate(() =>
		/* SAFETY: dictation-settings-proof.tsx installs __dictationSettingsProof before this proof page is evaluated. */ (
			window as DictationProofWindow
		).__dictationSettingsProof.snapshot()
	);
}

async function armFailure(
	page: Page,
	method: string,
	path: string,
	status = 503
): Promise<void> {
	await page.evaluate(
		({ requestMethod, requestPath, responseStatus }) =>
			/* SAFETY: dictation-settings-proof.tsx installs __dictationSettingsProof before this proof page is evaluated. */ (
				window as DictationProofWindow
			).__dictationSettingsProof.armFailure(
				requestMethod,
				requestPath,
				responseStatus
			),
		{ requestMethod: method, requestPath: path, responseStatus: status }
	);
}

async function openDictation(page: Page, url: string): Promise<Locator> {
	await page.goto(url);
	await page.getByRole("button", { name: "Open Gateway settings" }).click();
	const gatewayDialog = page.getByRole("dialog").first();
	await expect(gatewayDialog).toBeVisible();
	await gatewayDialog
		.getByRole("button", { name: "Dictation", exact: true })
		.click();
	await expect(
		gatewayDialog.getByRole("heading", { name: "Transcribe" })
	).toBeVisible();
	return gatewayDialog;
}

async function chooseOption(
	page: Page,
	dialog: Locator,
	label: string,
	option: string
): Promise<void> {
	await dialog.getByRole("combobox", { name: label }).click();
	await page.getByRole("option", { name: option, exact: true }).click();
	await expect(dialog.getByRole("combobox", { name: label })).toContainText(
		option
	);
}

async function chooseCustomModel(
	page: Page,
	dialog: Locator,
	label: string,
	model: string
): Promise<void> {
	await dialog.getByRole("button", { name: label }).click();
	const picker = page.getByRole("dialog").last();
	await picker.getByLabel("Custom model id").fill(model);
	await picker.getByRole("button", { name: "Use this model" }).click();
	await expect(dialog.getByRole("button", { name: label })).toContainText(
		model
	);
}

function lastDictationWrite(snapshot: DictationProofSnapshot) {
	const write = [...snapshot.requests]
		.reverse()
		.find(
			(request: CapturedRequest) =>
				request.method === "PUT" &&
				request.path === "/api/preferences/dictation"
		);
	if (!write) {
		throw new Error("No dictation preference write was captured");
	}
	const { value } = z.object({ value: z.string() }).parse(write.body);
	return dictationSchema.parse(JSON.parse(value));
}

test.describe.configure({ timeout: 120_000 });

test("resolves the manifest-owned Gateway Dictation tab and recovers from a denied enable", async ({
	page,
}) => {
	await page.goto("/dictation-settings-proof.html?reset=true&disabled=true");
	await page.getByRole("button", { name: "Open Gateway settings" }).click();
	const gatewayDialog = page.getByRole("dialog").first();
	await expect(gatewayDialog).toBeVisible();
	await gatewayDialog
		.getByRole("button", { name: "Dictation", exact: true })
		.click();
	await expect(
		gatewayDialog.getByText("Dictation is turned off", { exact: true })
	).toBeVisible();
	await expect(
		gatewayDialog.getByRole("heading", { name: "Transcribe" })
	).toHaveCount(0);
	let snapshot = await readSnapshot(page);
	expect(snapshot.appEnabled).toBe(false);
	expect(
		snapshot.requests.filter(
			(request) =>
				request.path === "/api/preferences/dictation" &&
				request.method === "GET"
		)
	).toEqual([]);

	await armFailure(page, "POST", "/api/plugins/@ryu/dictation/enable", 403);
	await gatewayDialog.getByRole("button", { name: "Turn on" }).click();
	await expect(
		gatewayDialog.getByText("Gateway denied one or more permission grants.")
	).toBeVisible();
	await expect(
		gatewayDialog.getByRole("button", { name: "Turn on" })
	).toBeEnabled();
	await gatewayDialog.getByRole("button", { name: "Turn on" }).click();
	await expect(
		gatewayDialog.getByRole("heading", { name: "Transcribe" })
	).toBeVisible();
	await expect(
		gatewayDialog.getByText("Gateway settings → Plugins", { exact: true })
	).toBeVisible();
	snapshot = await readSnapshot(page);
	expect(snapshot.appEnabled).toBe(true);
	expect(
		snapshot.requests
			.filter(
				(request) =>
					request.path === "/api/plugins/@ryu/dictation/enable" &&
					request.method === "POST"
			)
			.map((request) => request.status)
	).toEqual([403, 200]);
	expect(
		snapshot.tauriCalls.filter((call) =>
			/dictation|microphone|record|shortcut/i.test(call.command)
		)
	).toEqual([]);
	await page.screenshot({
		fullPage: true,
		path: evidence("desktop-dictation-enabled-settings.png"),
	});
});

test("persists transcription, paste, cleanup engine and model choices through the real Gateway tab", async ({
	page,
}) => {
	let dialog = await openDictation(
		page,
		"/dictation-settings-proof.html?reset=true"
	);
	await expect(
		dialog.getByRole("combobox", { name: "Dictation activation mode" })
	).toContainText("Hold to talk");
	await expect(
		dialog.getByRole("combobox", { name: "Dictation engine" })
	).toContainText("Parakeet v3");
	await expect(
		dialog.getByRole("combobox", { name: "Dictation insertion method" })
	).toContainText("Type (synthetic keystrokes)");

	const dictationShortcut = dialog.getByRole("button", {
		name: "Set dictation shortcut",
	});
	await dictationShortcut.click();
	await page.keyboard.press("Control+Alt+K");
	await expect(dictationShortcut).toContainText("K");
	await dialog
		.getByRole("button", { name: "Reset", exact: true })
		.first()
		.click();
	await expect(dictationShortcut).toContainText("D");
	await chooseOption(
		page,
		dialog,
		"Dictation activation mode",
		"Press to start / stop"
	);
	await chooseOption(page, dialog, "Dictation engine", "Cloud (via gateway)");
	await chooseOption(
		page,
		dialog,
		"Dictation insertion method",
		"Paste (clipboard)"
	);
	await dialog.getByLabel("Paste command").fill("ctrl+shift+v");
	await dialog
		.getByRole("switch", { name: "Restore clipboard after paste" })
		.click();
	await dialog
		.getByRole("switch", { name: "Auto-send after dictation" })
		.click();

	const cleanupToggle = dialog.getByRole("switch", {
		name: "Clean up dictation with Speech Processing",
	});
	await cleanupToggle.click();
	await expect(
		dialog.getByRole("combobox", { name: "Speech Processing engine" })
	).toHaveCount(0);
	await expect(dialog.getByLabel("Dictation cleanup prompt")).toHaveCount(0);
	await cleanupToggle.click();
	await expect(
		dialog.getByRole("combobox", { name: "Speech Processing engine" })
	).toContainText("S1-mini by Superwhisper");
	await dialog
		.getByRole("combobox", { name: "Speech Processing engine" })
		.click();
	await expect(
		page.getByRole("option", {
			name: "S1-mini by Superwhisper",
			exact: true,
		})
	).toBeVisible();
	await page
		.getByRole("option", { name: "S1-mini by Superwhisper", exact: true })
		.click();
	await expect(
		dialog.getByRole("combobox", { name: "Speech Processing engine" })
	).toContainText("S1-mini by Superwhisper");

	await chooseCustomModel(
		page,
		dialog,
		"Dictation cleanup agent or model",
		"cleanup-local-model"
	);
	await dialog
		.getByLabel("Dictation cleanup prompt")
		.fill("Keep only the spoken facts.");

	const snapshot = await readSnapshot(page);
	const expected = structuredClone(defaultPreferences);
	expected.mode = "toggle";
	expected.engine = "gateway";
	expected.insertMode = "paste";
	expected.pasteKeys = "ctrl+shift+v";
	expected.restoreClipboard = false;
	expected.autoSend = true;
	expected.postProcess.prompt = "Keep only the spoken facts.";
	expected.postProcess.selection = {
		...emptySelection,
		model: "cleanup-local-model",
	};
	expect(lastDictationWrite(snapshot)).toEqual(expected);
	expect(
		snapshot.requests.filter(
			(request) =>
				request.method === "PUT" &&
				request.path === "/api/preferences/speech-processing"
		)
	).toEqual([
		{
			body: {
				value: JSON.stringify({
					context: "general",
					engine: "s1-mini",
					structure: "prose",
					styling: "semi-formal",
				}),
			},
			method: "PUT",
			path: "/api/preferences/speech-processing",
			status: 200,
		},
	]);
	await page.screenshot({
		fullPage: true,
		path: evidence("desktop-dictation-transcribe-cleanup-settings.png"),
	});

	await page.reload();
	dialog = await openDictation(page, "/dictation-settings-proof.html");
	await expect(
		dialog.getByRole("combobox", { name: "Dictation activation mode" })
	).toContainText("Press to start / stop");
	await expect(
		dialog.getByRole("combobox", { name: "Dictation engine" })
	).toContainText("Cloud (via gateway)");
	await expect(dialog.getByLabel("Paste command")).toHaveValue("ctrl+shift+v");
	await expect(
		dialog.getByRole("switch", { name: "Restore clipboard after paste" })
	).not.toBeChecked();
	await expect(
		dialog.getByRole("switch", { name: "Auto-send after dictation" })
	).toBeChecked();
	await expect(
		dialog.getByRole("combobox", { name: "Speech Processing engine" })
	).toContainText("S1-mini by Superwhisper");
	await expect(
		dialog.getByRole("button", { name: "Dictation cleanup agent or model" })
	).toContainText("cleanup-local-model");
	await expect(dialog.getByLabel("Dictation cleanup prompt")).toHaveValue(
		"Keep only the spoken facts."
	);
});

test("persists agent-ask mode, shortcut, model and prompt, then reloads them", async ({
	page,
}) => {
	let dialog = await openDictation(
		page,
		"/dictation-settings-proof.html?reset=true"
	);
	await dialog.getByRole("switch", { name: "Enable agent ask" }).click();
	await expect(
		dialog.getByRole("button", { name: "Set agent-ask shortcut" })
	).toBeVisible();
	await chooseOption(
		page,
		dialog,
		"Agent-ask activation mode",
		"Press to start / stop"
	);
	const askShortcut = dialog.getByRole("button", {
		name: "Set agent-ask shortcut",
	});
	await askShortcut.click();
	await page.keyboard.press("Control+Alt+L");
	await expect(askShortcut).toContainText("L");
	await chooseCustomModel(
		page,
		dialog,
		"Agent-ask agent or model",
		"ask-local-model"
	);
	await dialog.getByLabel("Agent-ask prompt").fill("Return a concise answer.");

	const snapshot = await readSnapshot(page);
	const expected = structuredClone(defaultPreferences);
	expected.ask.enabled = true;
	expected.ask.mode = "toggle";
	expected.ask.shortcut = "CommandOrControl+Alt+L";
	expected.ask.selection = { ...emptySelection, model: "ask-local-model" };
	expected.ask.prompt = "Return a concise answer.";
	expect(lastDictationWrite(snapshot)).toEqual(expected);
	await page.screenshot({
		fullPage: true,
		path: evidence("desktop-dictation-agent-ask-settings.png"),
	});

	await page.reload();
	dialog = await openDictation(page, "/dictation-settings-proof.html");
	await expect(
		dialog.getByRole("switch", { name: "Enable agent ask" })
	).toBeChecked();
	await expect(
		dialog.getByRole("combobox", { name: "Agent-ask activation mode" })
	).toContainText("Press to start / stop");
	await expect(
		dialog.getByRole("button", { name: "Set agent-ask shortcut" })
	).toContainText("L");
	await expect(
		dialog.getByRole("button", { name: "Agent-ask agent or model" })
	).toContainText("ask-local-model");
	await expect(dialog.getByLabel("Agent-ask prompt")).toHaveValue(
		"Return a concise answer."
	);
});

test("shows read and write failures and retries without losing user changes", async ({
	page,
}) => {
	await page.goto(
		"/dictation-settings-proof.html?reset=true&failFirstDictationRead=true"
	);
	await page.getByRole("button", { name: "Open Gateway settings" }).click();
	let dialog = page.getByRole("dialog").first();
	await dialog.getByRole("button", { name: "Dictation", exact: true }).click();
	await expect(dialog.getByRole("alert")).toContainText(
		"Could not load Dictation settings."
	);
	await expect(
		dialog.getByRole("switch", { name: "Auto-send after dictation" })
	).toHaveCount(0);
	await dialog.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(
		dialog.getByRole("switch", { name: "Auto-send after dictation" })
	).toBeVisible();
	let snapshot = await readSnapshot(page);
	expect(
		snapshot.requests
			.filter(
				(request) =>
					request.method === "GET" &&
					request.path === "/api/preferences/dictation"
			)
			.map((request) => request.status)
	).toEqual([503, 200]);

	await armFailure(page, "PUT", "/api/preferences/dictation");
	await dialog
		.getByRole("switch", { name: "Auto-send after dictation" })
		.click();
	await expect(dialog.getByRole("alert")).toContainText(
		"Could not save Dictation settings."
	);
	await expect(
		dialog.getByRole("switch", { name: "Auto-send after dictation" })
	).toBeChecked();
	await dialog.getByRole("button", { name: "Retry save" }).click();
	await expect(dialog.getByRole("alert")).toHaveCount(0);
	snapshot = await readSnapshot(page);
	const writes = snapshot.requests.filter(
		(request) =>
			request.method === "PUT" && request.path === "/api/preferences/dictation"
	);
	expect(writes.map((request) => request.status)).toEqual([503, 200]);
	const expected = structuredClone(defaultPreferences);
	expected.autoSend = true;
	expect(
		writes.map((request) =>
			dictationSchema.parse(
				JSON.parse(z.object({ value: z.string() }).parse(request.body).value)
			)
		)
	).toEqual([expected, expected]);

	await page.reload();
	dialog = await openDictation(page, "/dictation-settings-proof.html");
	await expect(
		dialog.getByRole("switch", { name: "Auto-send after dictation" })
	).toBeChecked();
});
