import { expect, test } from "@playwright/test";
import {
	evidencePath,
	expectNodeAuthorization,
	expectPreference,
	expectPreferenceReadsReady,
	islandPreferenceWrites,
	NODE_TOKEN,
	openIslandSettings,
	preferenceWrite,
	preferenceWrites,
	readProof,
	selectOption,
	WINDOWS_USER_AGENT,
} from "./island-settings-proof.helpers.ts";

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
