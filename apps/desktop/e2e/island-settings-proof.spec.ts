import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { IslandSettingsProofPublisher } from "./harness/island-settings-proof.tsx";

const WINDOWS_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

interface IslandSettingsProofWindow extends Window {
	__islandSettingsProof: IslandSettingsProofPublisher;
}
declare const window: IslandSettingsProofWindow;
type IslandSettingsSnapshot = ReturnType<
	IslandSettingsProofPublisher["snapshot"]
>;
type CapturedRequest = IslandSettingsSnapshot["requests"][number];

const NODE_TOKEN = "island-settings-proof-token";
const ISLAND_PREFERENCE_KEYS = new Set([
	"island-appearance",
	"island-edge-offset",
	"island-auto-jump",
	"island-hide-on-fullscreen",
	"island-screen-privacy",
	"island-agents",
	"voice-input",
	"island-command-shortcut",
	"island-tts",
	"island-consent",
]);

// Verification runs set RYU_PROOF_OUTPUT_ROOT so screenshots land in scratch
// space instead of rewriting the tracked sweep evidence.
function evidencePath(name: string): string {
	return process.env.RYU_PROOF_OUTPUT_ROOT
		? path.resolve(process.env.RYU_PROOF_OUTPUT_ROOT, `${name}.png`)
		: path.resolve(
				import.meta.dirname,
				`../../../docs/proof/test-coverage-sweep-20260924/evidence/${name}.png`
			);
}

async function readProof(page: Page): Promise<IslandSettingsSnapshot> {
	return page.evaluate(() =>
		/* SAFETY: island-settings-proof.tsx installs __islandSettingsProof before this proof page is evaluated. */ (
			window as IslandSettingsProofWindow
		).__islandSettingsProof.snapshot()
	);
}

function preferenceWrite(
	key: string,
	value: string,
	status = 200
): CapturedRequest {
	return {
		body: { value },
		headerAuthorization: `Bearer ${NODE_TOKEN}`,
		method: "PUT",
		path: `/api/preferences/${key}`,
		status,
	};
}

function expectNodeAuthorization(requests: CapturedRequest[]): void {
	expect(requests.length).toBeGreaterThan(0);
	for (const request of requests) {
		expect(request.headerAuthorization).toBe(`Bearer ${NODE_TOKEN}`);
	}
}

function preferenceWrites(
	snapshot: IslandSettingsSnapshot,
	key: string
): CapturedRequest[] {
	return snapshot.requests.filter(
		(request) =>
			request.path === `/api/preferences/${key}` && request.method === "PUT"
	);
}

function islandPreferenceWrites(
	snapshot: IslandSettingsSnapshot
): CapturedRequest[] {
	return snapshot.requests.filter(
		(request) =>
			request.method === "PUT" &&
			ISLAND_PREFERENCE_KEYS.has(request.path.slice("/api/preferences/".length))
	);
}

function shadowWrites(snapshot: IslandSettingsSnapshot): CapturedRequest[] {
	return snapshot.requests.filter(
		(request) =>
			request.path.endsWith("/api/shadow/capture/control") &&
			request.method === "POST"
	);
}

async function openIslandSettings(page: Page, query = ""): Promise<void> {
	await page.goto(`/island-settings-proof.html${query}`);
	await page.getByRole("button", { name: "Island", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Privacy & permissions" })
	).toBeVisible();
	await expect(
		page.getByText("Island is turned off", { exact: true })
	).toHaveCount(0);
}

async function armFailure(
	page: Page,
	method: string,
	path: string,
	status = 503
): Promise<void> {
	await page.evaluate(
		({ requestMethod, requestPath, responseStatus }) =>
			/* SAFETY: island-settings-proof.tsx installs __islandSettingsProof before this proof page is evaluated. */ (
				window as IslandSettingsProofWindow
			).__islandSettingsProof.armFailure(
				requestMethod,
				requestPath,
				responseStatus
			),
		{ requestMethod: method, requestPath: path, responseStatus: status }
	);
}

async function expectPreferenceReadsReady(page: Page): Promise<void> {
	await expect
		.poll(async () => {
			const { requests } = await readProof(page);
			return requests
				.filter(
					(request) =>
						request.method === "GET" &&
						request.path.startsWith("/api/preferences/")
				)
				.map((request) => request.path);
		})
		.toEqual(
			expect.arrayContaining([
				"/api/preferences/island-appearance",
				"/api/preferences/island-edge-offset",
				"/api/preferences/island-auto-jump",
				"/api/preferences/island-hide-on-fullscreen",
				"/api/preferences/island-screen-privacy",
				"/api/preferences/island-agents",
				"/api/preferences/voice-input",
				"/api/preferences/island-command-shortcut",
				"/api/preferences/island-tts",
				"/api/preferences/island-consent",
			])
		);
}

async function selectOption(
	page: Page,
	label: string,
	option: string
): Promise<void> {
	await page.getByRole("combobox", { exact: true, name: label }).click();
	if (label === "Proactive suggestion agent") {
		await page.screenshot({
			animations: "disabled",
			fullPage: true,
			path: evidencePath("island-settings-agent-routing-options-open"),
		});
	}
	await page.getByRole("option", { name: option, exact: true }).click();
}

async function expectPreference(
	page: Page,
	key: string,
	value: string
): Promise<void> {
	await expect
		.poll(async () => (await readProof(page)).preferences[key])
		.toBe(value);
}

test.describe.configure({ timeout: 120_000 });

test("uses the documented defaults when Island preferences are unset", async ({
	page,
}) => {
	await openIslandSettings(page, "?preferences=missing");
	await expectPreferenceReadsReady(page);

	await expect(
		page.getByRole("combobox", { name: "Background" })
	).toContainText("Native glass (default)");
	await expect(
		page.getByRole("slider", { name: "Offset from edge" })
	).toHaveAttribute("aria-valuenow", "20");
	await expect(
		page.getByRole("switch", { name: "Auto-jump to active monitor" })
	).not.toBeChecked();
	await expect(
		page.getByRole("switch", { name: "Hide on fullscreen apps" })
	).toBeDisabled();
	await expect(
		page.getByRole("switch", { name: "Hide from screen capture" })
	).toBeChecked();
	await expect(page.getByRole("switch", { name: "Chat" })).toBeChecked();
	await expect(
		page.getByRole("switch", { name: "Screen context" })
	).not.toBeChecked();
	await expect(
		page.getByRole("switch", { name: "Proactive suggestions" })
	).toBeDisabled();
	await expect(
		page.getByRole("combobox", { name: "Chat agent (Voice Recognition)" })
	).toContainText("Ryu");
	await expect(
		page.getByRole("combobox", { name: "Proactive suggestion agent" })
	).toContainText("Ryu");
	await expect(
		page.getByRole("button", { name: "Set command bar shortcut" })
	).toContainText("Space");
	await expect(
		page.getByRole("switch", {
			name: "Enable push-to-talk Voice Recognition",
		})
	).toBeChecked();
	await expect(
		page.getByRole("combobox", { name: "Voice activation mode" })
	).toContainText("Press to start / stop");
	await expect(
		page.getByRole("combobox", { name: "Voice input engine" })
	).toContainText("Parakeet");
	await expect(
		page.getByRole("switch", { name: "Always read back responses" })
	).toBeChecked();
	await expect(
		page.getByRole("combobox", { name: "Audio engine" })
	).toContainText("Kokoro 82M");
	await expect(
		page.getByRole("combobox", { name: "Voice", exact: true })
	).toContainText("af_heart");
	await expect(
		page.getByRole("switch", { name: "Screen recording (frames)" })
	).toBeEnabled();
	await expect(
		page.getByRole("switch", { name: "Screen recording (frames)" })
	).toBeChecked();
	await expect(
		page.getByRole("switch", { name: "Pause all capture (incognito)" })
	).not.toBeChecked();

	const snapshot = await readProof(page);
	expect(islandPreferenceWrites(snapshot)).toEqual([]);
	expectNodeAuthorization(
		snapshot.requests.filter((request) =>
			request.path.startsWith("/api/preferences/")
		)
	);
	expect(snapshot.requests).toContainEqual(
		expect.objectContaining({
			headerAuthorization: `Bearer ${NODE_TOKEN}`,
			method: "GET",
			path: "/api/agents",
			status: 200,
		})
	);
	expect(snapshot.requests).toContainEqual(
		expect.objectContaining({
			headerAuthorization: `Bearer ${NODE_TOKEN}`,
			method: "GET",
			path: "/api/voice/tts-engines",
			status: 200,
		})
	);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("island-settings-defaults-loaded"),
	});
});

test("normalizes malformed Island preferences to safe defaults", async ({
	browser,
	page,
}) => {
	await openIslandSettings(page, "?preferences=malformed");
	await expectPreferenceReadsReady(page);

	await expect(
		page.getByRole("combobox", { name: "Background" })
	).toContainText("Native glass (default)");
	await expect(
		page.getByRole("slider", { name: "Offset from edge" })
	).toHaveAttribute("aria-valuenow", "20");
	await expect(
		page.getByRole("switch", { name: "Auto-jump to active monitor" })
	).not.toBeChecked();
	await expect(page.getByRole("switch", { name: "Chat" })).toBeChecked();
	await expect(
		page.getByRole("switch", { name: "Screen context" })
	).not.toBeChecked();
	await expect(
		page.getByRole("switch", { name: "Proactive suggestions" })
	).toBeDisabled();
	await expect(
		page.getByRole("combobox", { name: "Chat agent (Voice Recognition)" })
	).toContainText("Ryu");
	await expect(
		page.getByRole("combobox", { name: "Proactive suggestion agent" })
	).toContainText("Ryu");
	await expect(
		page.getByRole("button", { name: "Set command bar shortcut" })
	).toContainText("Space");
	await expect(
		page.getByRole("switch", {
			name: "Enable push-to-talk Voice Recognition",
		})
	).toBeChecked();
	await expect(
		page.getByRole("button", { name: "Set push-to-talk shortcut" })
	).toContainText("A");
	await expect(
		page.getByRole("combobox", { name: "Voice activation mode" })
	).toContainText("Press to start / stop");
	await expect(
		page.getByRole("combobox", { name: "Voice input engine" })
	).toContainText("Parakeet");
	await expect(
		page.getByRole("switch", { name: "Always read back responses" })
	).toBeChecked();
	await expect(
		page.getByRole("combobox", { name: "Audio engine" })
	).toContainText("Kokoro 82M");
	await expect(
		page.getByRole("combobox", { name: "Voice", exact: true })
	).toContainText("af_heart");
	await expect(
		page.getByRole("switch", { name: "Screen recording (frames)" })
	).toBeEnabled();
	const snapshot = await readProof(page);
	expect(islandPreferenceWrites(snapshot)).toEqual([]);
	await page
		.getByRole("combobox", { name: "Background" })
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("island-settings-malformed-preferences"),
	});

	const windowsContext = await browser.newContext({
		userAgent: WINDOWS_USER_AGENT,
		viewport: { height: 900, width: 1440 },
	});
	try {
		const windowsPage = await windowsContext.newPage();
		await openIslandSettings(windowsPage, "?preferences=malformed");
		await expectPreferenceReadsReady(windowsPage);
		const windowsFullscreen = windowsPage.getByRole("switch", {
			name: "Hide on fullscreen apps",
		});
		await expect(windowsFullscreen).toBeEnabled();
		await expect(windowsFullscreen).toBeChecked();
		expect(
			preferenceWrites(
				await readProof(windowsPage),
				"island-hide-on-fullscreen"
			)
		).toEqual([]);
	} finally {
		await windowsContext.close();
	}
});

test("persists Island privacy consent and per-surface agent routing", async ({
	page,
}) => {
	await openIslandSettings(page);

	const chat = page.getByRole("switch", { name: "Chat" });
	const screenContext = page.getByRole("switch", { name: "Screen context" });
	const proactive = page.getByRole("switch", {
		name: "Proactive suggestions",
	});
	await expect(chat).toBeChecked();
	await expect(screenContext).not.toBeChecked();
	await expect(proactive).toBeDisabled();
	await expect(
		preferenceWrites(await readProof(page), "island-consent")
	).toEqual([]);

	await chat.click();
	await expect(chat).not.toBeChecked();
	await expectPreference(
		page,
		"island-consent",
		JSON.stringify({ chat: false, contextRead: null, proactive: null })
	);
	await screenContext.click();
	await expect(screenContext).toBeChecked();
	await expect(proactive).toBeEnabled();
	await expectPreference(
		page,
		"island-consent",
		JSON.stringify({ chat: false, contextRead: true, proactive: null })
	);
	await proactive.click();
	await expect(proactive).toBeChecked();
	await expectPreference(
		page,
		"island-consent",
		JSON.stringify({ chat: false, contextRead: true, proactive: true })
	);

	await selectOption(page, "Chat agent (Voice Recognition)", "Support agent");
	await expectPreference(
		page,
		"island-agents",
		JSON.stringify({ voiceAgent: "support-agent", proactiveAgent: "ryu" })
	);
	await selectOption(
		page,
		"Proactive suggestion agent",
		"Default local model (fast)"
	);
	await expectPreference(
		page,
		"island-agents",
		JSON.stringify({ voiceAgent: "support-agent", proactiveAgent: "" })
	);

	const saved = await readProof(page);
	expect(preferenceWrites(saved, "island-consent")).toEqual([
		preferenceWrite(
			"island-consent",
			JSON.stringify({ chat: false, contextRead: null, proactive: null })
		),
		preferenceWrite(
			"island-consent",
			JSON.stringify({ chat: false, contextRead: true, proactive: null })
		),
		preferenceWrite(
			"island-consent",
			JSON.stringify({ chat: false, contextRead: true, proactive: true })
		),
	]);
	expect(preferenceWrites(saved, "island-agents")).toEqual([
		preferenceWrite(
			"island-agents",
			JSON.stringify({ voiceAgent: "support-agent", proactiveAgent: "ryu" })
		),
		preferenceWrite(
			"island-agents",
			JSON.stringify({ voiceAgent: "support-agent", proactiveAgent: "" })
		),
	]);

	await page.reload();
	await page.getByRole("button", { name: "Island", exact: true }).click();
	await expect(page.getByRole("switch", { name: "Chat" })).not.toBeChecked();
	await expect(
		page.getByRole("switch", { name: "Screen context" })
	).toBeChecked();
	await expect(
		page.getByRole("switch", { name: "Proactive suggestions" })
	).toBeChecked();
	await expect(
		page.getByRole("combobox", { name: "Chat agent (Voice Recognition)" })
	).toContainText("Support agent");
	await expect(
		page.getByRole("combobox", { name: "Proactive suggestion agent" })
	).toContainText("Default local model (fast)");
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("island-settings-privacy-agents-persisted"),
	});
});

test("records command and push-to-talk shortcuts and saves voice recognition choices", async ({
	page,
}) => {
	await openIslandSettings(page);
	const commandShortcut = page.getByRole("button", {
		name: "Set command bar shortcut",
	});
	const enableVoice = page.getByRole("switch", {
		name: "Enable push-to-talk Voice Recognition",
	});
	await expect(enableVoice).not.toBeChecked();
	await expect(
		page.getByRole("combobox", { name: "Voice activation mode" })
	).toHaveCount(0);

	await commandShortcut.click();
	await expect(commandShortcut).toContainText("Press keys…");
	await page.keyboard.press("Control");
	await expect(commandShortcut).toContainText("Press keys…");
	await page.keyboard.press("Escape");
	await expect(commandShortcut).not.toContainText("Press keys…");
	expect(
		preferenceWrites(await readProof(page), "island-command-shortcut")
	).toEqual([]);

	await commandShortcut.click();
	await page.keyboard.press("Control+Alt+K");
	await expectPreference(
		page,
		"island-command-shortcut",
		"CommandOrControl+Alt+K"
	);

	await enableVoice.click();
	await expect(enableVoice).toBeChecked();
	let voicePrefs = {
		enabled: true,
		engine: "parakeet",
		mode: "toggle",
		model: "parakeet-tdt-0.6b-v3",
		shortcut: "CommandOrControl+Shift+A",
	};
	await expectPreference(page, "voice-input", JSON.stringify(voicePrefs));

	await page.getByRole("button", { name: "Set push-to-talk shortcut" }).click();
	await page.keyboard.press("Control+Shift+P");
	voicePrefs = { ...voicePrefs, shortcut: "CommandOrControl+Shift+P" };
	await expectPreference(page, "voice-input", JSON.stringify(voicePrefs));

	await selectOption(page, "Voice activation mode", "Hold to talk");
	voicePrefs = { ...voicePrefs, mode: "push-to-talk" };
	await expectPreference(page, "voice-input", JSON.stringify(voicePrefs));
	await selectOption(page, "Voice input engine", "Whisper");
	voicePrefs = { ...voicePrefs, engine: "whisper", model: "ggml-base.en" };
	await expectPreference(page, "voice-input", JSON.stringify(voicePrefs));

	const saved = await readProof(page);
	expect(preferenceWrites(saved, "island-command-shortcut")).toEqual([
		preferenceWrite("island-command-shortcut", "CommandOrControl+Alt+K"),
	]);
	expect(preferenceWrites(saved, "voice-input")).toEqual([
		preferenceWrite(
			"voice-input",
			JSON.stringify({
				enabled: true,
				engine: "parakeet",
				mode: "toggle",
				model: "parakeet-tdt-0.6b-v3",
				shortcut: "CommandOrControl+Shift+A",
			})
		),
		preferenceWrite(
			"voice-input",
			JSON.stringify({
				...voicePrefs,
				shortcut: "CommandOrControl+Shift+P",
				mode: "toggle",
				engine: "parakeet",
				model: "parakeet-tdt-0.6b-v3",
			})
		),
		preferenceWrite(
			"voice-input",
			JSON.stringify({
				...voicePrefs,
				shortcut: "CommandOrControl+Shift+P",
				mode: "push-to-talk",
				engine: "parakeet",
				model: "parakeet-tdt-0.6b-v3",
			})
		),
		preferenceWrite("voice-input", JSON.stringify(voicePrefs)),
	]);

	await page.reload();
	await page.getByRole("button", { name: "Island", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Set command bar shortcut" })
	).toContainText("K");
	await expect(
		page.getByRole("button", { name: "Set push-to-talk shortcut" })
	).toContainText("P");
	await expect(
		page.getByRole("combobox", { name: "Voice activation mode" })
	).toContainText("Hold to talk");
	await expect(
		page.getByRole("combobox", { name: "Voice input engine" })
	).toContainText("Whisper");
	await page
		.getByRole("combobox", { exact: true, name: "Voice activation mode" })
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("island-settings-voice-shortcuts-persisted"),
	});

	const resetButtons = page.getByRole("button", {
		name: "Reset",
		exact: true,
	});
	await expect(resetButtons).toHaveCount(2);
	await resetButtons.nth(0).click();
	await expect(commandShortcut).toContainText("Space");
	await expectPreference(
		page,
		"island-command-shortcut",
		"CommandOrControl+Shift+Space"
	);
	await resetButtons.nth(1).click();
	voicePrefs = { ...voicePrefs, shortcut: "CommandOrControl+Shift+A" };
	await expect(
		page.getByRole("button", { name: "Set push-to-talk shortcut" })
	).toContainText("A");
	await expectPreference(page, "voice-input", JSON.stringify(voicePrefs));

	const resetSnapshot = await readProof(page);
	expect(preferenceWrites(resetSnapshot, "island-command-shortcut")).toEqual([
		preferenceWrite("island-command-shortcut", "CommandOrControl+Alt+K"),
		preferenceWrite("island-command-shortcut", "CommandOrControl+Shift+Space"),
	]);
	expect(preferenceWrites(resetSnapshot, "voice-input").at(-1)).toEqual(
		preferenceWrite("voice-input", JSON.stringify(voicePrefs))
	);
	expectNodeAuthorization(
		resetSnapshot.requests.filter((request) =>
			request.path.startsWith("/api/preferences/")
		)
	);
	await page.reload();
	await page.getByRole("button", { name: "Island", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Set command bar shortcut" })
	).toContainText("Space");
	await expect(
		page.getByRole("button", { name: "Set push-to-talk shortcut" })
	).toContainText("A");
	await expect(
		page.getByRole("combobox", { name: "Voice input engine" })
	).toContainText("Whisper");
	await page
		.getByRole("button", { name: "Set push-to-talk shortcut" })
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("island-settings-shortcut-reset-persisted"),
	});
});

test("enables read-back and persists the selected audio engine and voice", async ({
	page,
}) => {
	await openIslandSettings(page);
	const readBack = page.getByRole("switch", {
		name: "Always read back responses",
	});
	await expect(readBack).not.toBeChecked();
	await expect(
		page.getByRole("combobox", { name: "Audio engine" })
	).toHaveCount(0);
	await readBack.click();
	await expect(readBack).toBeChecked();
	await expectPreference(
		page,
		"island-tts",
		JSON.stringify({ enabled: true, engine: "kokoro", voice: "af_heart" })
	);
	await selectOption(page, "Audio engine", "OuteTTS");
	await expectPreference(
		page,
		"island-tts",
		JSON.stringify({ enabled: true, engine: "outetts", voice: "Mika" })
	);
	await selectOption(page, "Voice", "Nova");
	await expectPreference(
		page,
		"island-tts",
		JSON.stringify({ enabled: true, engine: "outetts", voice: "Nova" })
	);

	expect(preferenceWrites(await readProof(page), "island-tts")).toEqual([
		preferenceWrite(
			"island-tts",
			JSON.stringify({ enabled: true, engine: "kokoro", voice: "af_heart" })
		),
		preferenceWrite(
			"island-tts",
			JSON.stringify({ enabled: true, engine: "outetts", voice: "Mika" })
		),
		preferenceWrite(
			"island-tts",
			JSON.stringify({ enabled: true, engine: "outetts", voice: "Nova" })
		),
	]);

	await page.reload();
	await page.getByRole("button", { name: "Island", exact: true }).click();
	await expect(
		page.getByRole("switch", { name: "Always read back responses" })
	).toBeChecked();
	await expect(
		page.getByRole("combobox", { name: "Audio engine" })
	).toContainText("OuteTTS");
	await expect(
		page.getByRole("combobox", { exact: true, name: "Voice" })
	).toContainText("Nova");
	await page
		.getByRole("combobox", { exact: true, name: "Audio engine" })
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("island-settings-audio-readback-persisted"),
	});
});

test("persists all background choices, debounced edge offsets, and visibility settings", async ({
	browser,
	page,
}) => {
	// The page clock runs naturally until the offset section pauses it, so
	// the 200 ms write debounce elapses only when the test advances it. With
	// real time, a loaded host spaces drag steps more than 200 ms apart and the
	// product correctly writes the intermediate values as well.
	await page.clock.install();
	await openIslandSettings(page);
	const fullscreen = page.getByRole("switch", {
		name: "Hide on fullscreen apps",
	});
	await expect(fullscreen).toBeDisabled();
	await expect(
		preferenceWrites(await readProof(page), "island-hide-on-fullscreen")
	).toEqual([]);

	const background = page.getByRole("combobox", { name: "Background" });
	await expect(background).toContainText("Native glass (default)");
	await armFailure(page, "PUT", "/api/preferences/island-appearance", 503);
	await selectOption(page, "Background", "Translucent (tinted glass)");
	await expect(page.getByRole("alert")).toHaveText(
		"Couldn't save Island setting. The previous value was restored. Choose the setting again to retry."
	);
	await expect(background).toContainText("Native glass (default)");
	await expectPreference(
		page,
		"island-appearance",
		JSON.stringify({ background: "acrylic" })
	);
	await page.getByRole("alert").scrollIntoViewIfNeeded();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("island-settings-background-write-rollback"),
	});
	await selectOption(page, "Background", "Translucent (tinted glass)");
	await expect(background).toContainText("Translucent (tinted glass)");
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expectPreference(
		page,
		"island-appearance",
		JSON.stringify({ background: "translucent" })
	);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("island-settings-translucent-persisted"),
	});
	await selectOption(page, "Background", "Mica (Windows 11 native blur)");
	await expect(background).toContainText("Mica (Windows 11 native blur)");
	await expectPreference(
		page,
		"island-appearance",
		JSON.stringify({ background: "mica" })
	);
	await selectOption(page, "Background", "Native glass (default)");
	await expect(background).toContainText("Native glass (default)");
	await expectPreference(
		page,
		"island-appearance",
		JSON.stringify({ background: "acrylic" })
	);

	const offset = page.getByRole("slider", { name: "Offset from edge" });
	await expect(offset).toHaveAttribute("aria-valuenow", "20");
	const offsetWrites = async () =>
		preferenceWrites(await readProof(page), "island-edge-offset");
	// Freeze page time: every change below lands at one instant, and the
	// debounced write fires only when the test runs the clock past 200 ms.
	await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
	await offset.focus();
	for (let step = 0; step < 5; step += 1) {
		await page.keyboard.press("ArrowRight");
	}
	await expect(offset).toHaveAttribute("aria-valuenow", "25");
	await page.clock.runFor(199);
	expect(await offsetWrites()).toEqual([]);
	await page.clock.runFor(1);
	await expect
		.poll(offsetWrites)
		.toEqual([preferenceWrite("island-edge-offset", "25")]);
	const offsetBox = await offset.boundingBox();
	if (!offsetBox) {
		throw new Error("Offset slider has no layout box");
	}
	const sliderY = offsetBox.y + offsetBox.height / 2;
	await page.mouse.move(offsetBox.x + offsetBox.width * 0.2, sliderY);
	await page.mouse.down();
	await page.mouse.move(offsetBox.x + offsetBox.width * 0.5, sliderY, {
		steps: 4,
	});
	await page.mouse.up();
	await expect(offset).toHaveAttribute("aria-valuenow", "48");
	// The drag's intermediate values (real time on a loaded host wrote 19, 26,
	// 34 and 41) all land inside one paused instant, so none is written.
	expect(await offsetWrites()).toEqual([
		preferenceWrite("island-edge-offset", "25"),
	]);
	await page.clock.runFor(200);
	await expect
		.poll(offsetWrites)
		.toEqual([
			preferenceWrite("island-edge-offset", "25"),
			preferenceWrite("island-edge-offset", "48"),
		]);
	await offset.focus();
	await page.keyboard.press("End");
	await expect(offset).toHaveAttribute("aria-valuenow", "96");
	await page.clock.runFor(200);
	await expect
		.poll(offsetWrites)
		.toEqual([
			preferenceWrite("island-edge-offset", "25"),
			preferenceWrite("island-edge-offset", "48"),
			preferenceWrite("island-edge-offset", "96"),
		]);
	await page.keyboard.press("Home");
	await expect(offset).toHaveAttribute("aria-valuenow", "0");
	await page.clock.runFor(200);
	await expect
		.poll(offsetWrites)
		.toEqual([
			preferenceWrite("island-edge-offset", "25"),
			preferenceWrite("island-edge-offset", "48"),
			preferenceWrite("island-edge-offset", "96"),
			preferenceWrite("island-edge-offset", "0"),
		]);
	await page.clock.resume();

	const autoJump = page.getByRole("switch", {
		name: "Auto-jump to active monitor",
	});
	await expect(autoJump).not.toBeChecked();
	await autoJump.click();
	await expect(autoJump).toBeChecked();
	await expectPreference(page, "island-auto-jump", "true");

	const screenPrivacy = page.getByRole("switch", {
		name: "Hide from screen capture",
	});
	await expect(screenPrivacy).toBeChecked();
	await screenPrivacy.click();
	await expect(screenPrivacy).not.toBeChecked();
	await expectPreference(page, "island-screen-privacy", "false");

	await page.reload();
	await page.getByRole("button", { name: "Island", exact: true }).click();
	await expect(
		page.getByRole("combobox", { name: "Background" })
	).toContainText("Native glass (default)");
	await expect(
		page.getByRole("slider", { name: "Offset from edge" })
	).toHaveAttribute("aria-valuenow", "0");
	await expect(
		page.getByRole("switch", { name: "Auto-jump to active monitor" })
	).toBeChecked();
	await expect(
		page.getByRole("switch", { name: "Hide from screen capture" })
	).not.toBeChecked();
	await expect(
		page.getByRole("switch", { name: "Hide on fullscreen apps" })
	).toBeDisabled();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("island-settings-native-glass-persisted"),
	});
	await page
		.getByRole("switch", { exact: true, name: "Hide from screen capture" })
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("island-settings-visibility-persisted"),
	});

	const saved = await readProof(page);
	expect(preferenceWrites(saved, "island-appearance")).toEqual([
		preferenceWrite(
			"island-appearance",
			JSON.stringify({ background: "translucent" }),
			503
		),
		preferenceWrite(
			"island-appearance",
			JSON.stringify({ background: "translucent" })
		),
		preferenceWrite(
			"island-appearance",
			JSON.stringify({ background: "mica" })
		),
		preferenceWrite(
			"island-appearance",
			JSON.stringify({ background: "acrylic" })
		),
	]);
	expect(preferenceWrites(saved, "island-edge-offset")).toEqual([
		preferenceWrite("island-edge-offset", "25"),
		preferenceWrite("island-edge-offset", "48"),
		preferenceWrite("island-edge-offset", "96"),
		preferenceWrite("island-edge-offset", "0"),
	]);
	expect(preferenceWrites(saved, "island-auto-jump")).toEqual([
		preferenceWrite("island-auto-jump", "true"),
	]);
	expect(preferenceWrites(saved, "island-screen-privacy")).toEqual([
		preferenceWrite("island-screen-privacy", "false"),
	]);
	expectNodeAuthorization(
		saved.requests.filter((request) =>
			request.path.startsWith("/api/preferences/")
		)
	);

	const windowsContext = await browser.newContext({
		userAgent: WINDOWS_USER_AGENT,
		viewport: { height: 900, width: 1440 },
	});
	try {
		const windowsPage = await windowsContext.newPage();
		await openIslandSettings(windowsPage);
		const windowsFullscreen = windowsPage.getByRole("switch", {
			name: "Hide on fullscreen apps",
		});
		await expect(windowsFullscreen).toBeEnabled();
		await expect(windowsFullscreen).toBeChecked();
		await windowsFullscreen.click();
		await expect(windowsFullscreen).not.toBeChecked();
		await expectPreference(windowsPage, "island-hide-on-fullscreen", "false");
		expect(
			preferenceWrites(
				await readProof(windowsPage),
				"island-hide-on-fullscreen"
			)
		).toEqual([preferenceWrite("island-hide-on-fullscreen", "false")]);

		await windowsPage.reload();
		await windowsPage
			.getByRole("button", { name: "Island", exact: true })
			.click();
		await expect(
			windowsPage.getByRole("switch", { name: "Hide on fullscreen apps" })
		).toBeEnabled();
		await expect(
			windowsPage.getByRole("switch", { name: "Hide on fullscreen apps" })
		).not.toBeChecked();
		await windowsPage
			.getByRole("switch", {
				exact: true,
				name: "Hide on fullscreen apps",
			})
			.scrollIntoViewIfNeeded();
		await windowsPage.screenshot({
			animations: "disabled",
			fullPage: true,
			path: evidencePath("island-settings-windows-fullscreen-persisted"),
		});
	} finally {
		await windowsContext.close();
	}
});

test("persists Shadow capture switches through the local store and control API fixtures", async ({
	page,
}) => {
	await openIslandSettings(page);
	const frames = page.getByRole("switch", {
		name: "Screen recording (frames)",
	});
	const paused = page.getByRole("switch", {
		name: "Pause all capture (incognito)",
	});
	await expect(frames).toBeEnabled();
	await expect(frames).toBeChecked();
	await expect(paused).not.toBeChecked();

	await frames.click();
	await expect(frames).not.toBeChecked();
	await expect
		.poll(async () => shadowWrites(await readProof(page)).at(-1)?.body)
		.toEqual({ frames: false });
	await paused.click();
	await expect(paused).toBeChecked();
	await expect
		.poll(async () => shadowWrites(await readProof(page)).at(-1)?.body)
		.toEqual({ paused: true });

	const saved = await readProof(page);
	expect(saved.shadowStore).toEqual({ frames: false, paused: true, saves: 2 });
	expect(saved.shadowControl.frames).toBe(false);
	expect(saved.shadowControl.paused).toBe(true);
	expect(
		saved.tauriCalls
			.filter((call) => call.method === "set")
			.map((call) => ({
				fileName: call.fileName,
				key: call.key,
				value: call.value,
			}))
	).toEqual([
		{
			fileName: "companion.bin",
			key: "companion_frames",
			value: false,
		},
		{
			fileName: "companion.bin",
			key: "companion_paused",
			value: true,
		},
	]);
	expect(
		saved.tauriCalls
			.filter((call) => call.method === "save")
			.map((call) => call.fileName)
	).toEqual(["companion.bin", "companion.bin"]);

	await page.reload();
	await page.getByRole("button", { name: "Island", exact: true }).click();
	await expect(
		page.getByRole("switch", { name: "Screen recording (frames)" })
	).not.toBeChecked();
	await expect(
		page.getByRole("switch", { name: "Pause all capture (incognito)" })
	).toBeChecked();
	await expect
		.poll(async () => shadowWrites(await readProof(page)).at(-1)?.body)
		.toEqual({
			app_allowlist: [],
			frames: false,
			history_retention_days: 30,
			paused: true,
		});
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("island-settings-shadow-capture-persisted"),
	});
});

test("notch mode persists across reload and rolls back a failed save", async ({
	page,
}) => {
	await openIslandSettings(page);
	const toggle = page.getByRole("switch", { name: "Notch mode", exact: true });
	await expect(toggle).not.toBeChecked();
	await expect
		.poll(async () => {
			const requests = (await readProof(page)).requests;
			return requests.filter(
				(request) =>
					request.method === "GET" &&
					request.path === "/api/preferences/island-notch-mode"
			);
		})
		.toEqual([
			{
				body: null,
				headerAuthorization: `Bearer ${NODE_TOKEN}`,
				method: "GET",
				path: "/api/preferences/island-notch-mode",
				status: 404,
			},
		]);
	await toggle.click();
	await expectPreference(page, "island-notch-mode", "true");
	await page.reload();
	await page.getByRole("button", { name: "Island", exact: true }).click();
	await expect(toggle).toBeChecked();
	await expect
		.poll(async () => {
			const requests = (await readProof(page)).requests;
			return requests.filter(
				(request) =>
					request.method === "GET" &&
					request.path === "/api/preferences/island-notch-mode"
			);
		})
		.toEqual([
			{
				body: null,
				headerAuthorization: `Bearer ${NODE_TOKEN}`,
				method: "GET",
				path: "/api/preferences/island-notch-mode",
				status: 404,
			},
			{
				body: null,
				headerAuthorization: `Bearer ${NODE_TOKEN}`,
				method: "GET",
				path: "/api/preferences/island-notch-mode",
				status: 200,
			},
		]);
	await toggle.scrollIntoViewIfNeeded();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("island-settings-notch-mode-persisted"),
	});

	await armFailure(page, "PUT", "/api/preferences/island-notch-mode");
	await toggle.click();
	await expect(toggle).toBeChecked();
	await expect(page.getByRole("alert")).toContainText(
		"Couldn't save Island setting"
	);
	await expectPreference(page, "island-notch-mode", "true");
	await toggle.click();
	await expectPreference(page, "island-notch-mode", "false");
	await expect(toggle).not.toBeChecked();
	expect(preferenceWrites(await readProof(page), "island-notch-mode")).toEqual([
		preferenceWrite("island-notch-mode", "true"),
		preferenceWrite("island-notch-mode", "false", 503),
		preferenceWrite("island-notch-mode", "false"),
	]);
	const notchRequests = (await readProof(page)).requests.filter((request) =>
		request.path.endsWith("/island-notch-mode")
	);
	expectNodeAuthorization(notchRequests);
});
