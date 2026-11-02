// Continues voice-settings-proof.spec.ts (split under the file token limit); helpers live in voice-settings-proof.helpers.ts.

import { expect, test } from "@playwright/test";
import {
	openVoiceSettings,
	STORY_URL,
	seedTtsPrefs,
	selectOption,
} from "./voice-settings-proof.helpers.ts";

test.describe.configure({ timeout: 120_000 });

test("surfaces engine loading and speech synthesis errors with a working retry", async ({
	page,
}) => {
	await seedTtsPrefs(page);
	page.setDefaultTimeout(8000);
	await page.setViewportSize({ height: 1050, width: 1440 });
	await page.goto(`${STORY_URL}?scenario=tts-load-error`);
	await expect(page.getByTestId("voice-settings-proof")).toBeVisible();
	await expect(
		page.getByText("Couldn’t load the voice engines", { exact: false })
	).toBeVisible();
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(
		page.getByText("Couldn’t load the voice engines", { exact: false })
	).toHaveCount(0);
	await expect(
		page.getByRole("combobox", { name: "Audio engine" })
	).toContainText("Cloud (via gateway)");

	await page.goto(`${STORY_URL}?scenario=tts-speak-error`);
	await expect(
		page.getByRole("combobox", { name: "Audio engine" })
	).toContainText("Cloud (via gateway)");
	await page.getByRole("button", { name: "Test voice", exact: true }).click();
	await expect(
		page.getByText("Couldn’t play the test audio", { exact: false })
	).toBeVisible();
});

test("installs and starts both optional voice runtimes and installs every curated model", async ({
	page,
}) => {
	await seedTtsPrefs(page, "kokoro", "");
	await openVoiceSettings(page);

	await page
		.getByRole("button", { name: "Install Ryu Audio engine", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Start Ryu Audio engine", exact: true })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Start Ryu Audio engine", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Start Ryu Audio engine", exact: true })
	).toHaveCount(0);
	await expect
		.poll(async () => {
			const calls = await page.evaluate(() => window.__voiceProof?.calls ?? []);
			return (
				calls.some((call) => call.path === "/api/setup/ryutts/install") &&
				calls.some((call) => call.path === "/api/sidecar/ryutts/start")
			);
		})
		.toBe(true);

	const engine = page.getByRole("combobox", { name: "Audio engine" });
	await expect(engine).toContainText("Kokoro 82M");
	const voice = page.getByRole("combobox", { name: "Voice", exact: true });
	await expect(voice).toBeVisible();
	await expect(voice).toContainText("af_heart");
	const installButtons = page.getByRole("button", {
		name: "Install",
		exact: true,
	});
	await expect(installButtons).toHaveCount(5);

	await page
		.getByRole("button", { name: "Install", exact: true })
		.first()
		.click();
	await expect(page.getByText("Installed", { exact: true })).toHaveCount(1);
	await expect(installButtons).toHaveCount(4);
	await expect
		.poll(async () => {
			const calls = await page.evaluate(() => window.__voiceProof?.calls ?? []);
			return calls.some(
				(call) =>
					call.path === "/api/voice/tts-models/install" &&
					call.method === "POST"
			);
		})
		.toBe(true);

	for (const installedModelCount of [2, 3, 4, 5]) {
		await page
			.getByRole("button", { name: "Install", exact: true })
			.first()
			.click();
		await expect(page.getByText("Installed", { exact: true })).toHaveCount(
			installedModelCount
		);
	}
	await expect
		.poll(async () => {
			const calls = await page.evaluate(() => window.__voiceProof?.calls ?? []);
			return calls
				.filter(
					(call) =>
						call.path === "/api/voice/tts-models/install" &&
						call.method === "POST"
				)
				.map(
					(call) =>
						/* SAFETY: The mounted TtsEngineSettings install callback passes the model_name from this private harness curated model rows to actual installTtsModel, whose JSON serializer constructs that string field. */ (
							call.body as { model_name?: string }
						).model_name
				)
				.sort();
		})
		.toEqual([
			"kitten-tts-mini-0.8",
			"kitten-tts-nano-0.1",
			"kokoro-82m-v1.0",
			"pocket-tts",
			"pocket_tts_english_q8_0",
		]);
	await expect(voice).toContainText("af_heart");
	for (const kokoroVoice of [
		"af_heart",
		"af_alloy",
		"af_aoede",
		"af_bella",
		"af_jessica",
		"af_kore",
		"af_nicole",
		"af_nova",
		"af_river",
		"af_sarah",
		"af_sky",
		"am_adam",
		"am_echo",
		"am_eric",
		"am_fenrir",
		"am_liam",
		"am_michael",
		"am_onyx",
		"am_puck",
		"am_santa",
		"bf_alice",
		"bf_emma",
		"bf_isabella",
		"bf_lily",
		"bm_daniel",
		"bm_fable",
		"bm_george",
		"bm_lewis",
	]) {
		await selectOption(page, voice, kokoroVoice);
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem("ryu.tts.voice")))
			.toBe(kokoroVoice);
	}
	await selectOption(page, engine, "KittenTTS");
	await expect(voice).toContainText("Jasper");
	for (const kittenVoice of [
		"Bella",
		"Jasper",
		"Luna",
		"Bruno",
		"Rosie",
		"Hugo",
		"Kiki",
		"Leo",
	]) {
		await selectOption(page, voice, kittenVoice);
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem("ryu.tts.voice")))
			.toBe(kittenVoice);
	}
	await selectOption(page, engine, "Pocket TTS (Kyutai)");
	await expect(voice).toContainText("alba");
	for (const pocketVoice of [
		"alba",
		"giovanni",
		"lola",
		"juergen",
		"rafael",
		"estelle",
		"anna",
		"azelma",
		"charles",
		"cosette",
		"eve",
		"fantine",
		"george",
		"jane",
		"jean",
		"javert",
		"marius",
		"mary",
		"michael",
		"paul",
		"vera",
	]) {
		await selectOption(page, voice, pocketVoice);
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem("ryu.tts.voice")))
			.toBe(pocketVoice);
	}
	await selectOption(page, engine, "Kokoro 82M");
	await expect(voice).toContainText("bm_lewis");

	await selectOption(page, engine, "audio.cpp (not installed)");
	await expect(
		page.getByRole("button", {
			name: "Install audio.cpp runtime",
			exact: true,
		})
	).toBeVisible();
	await page
		.getByRole("button", { name: "Install audio.cpp runtime", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Start audio.cpp runtime", exact: true })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Start audio.cpp runtime", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Start audio.cpp runtime", exact: true })
	).toHaveCount(0);
	await expect
		.poll(async () => {
			const calls = await page.evaluate(() => window.__voiceProof?.calls ?? []);
			return (
				calls.some((call) => call.path === "/api/setup/audiocpp/install") &&
				calls.some((call) => call.path === "/api/sidecar/audiocpp/start")
			);
		})
		.toBe(true);
	await expect(engine).toContainText("audio.cpp");
	await expect(
		page.getByRole("combobox", { name: "Audio engine" })
	).not.toContainText("not installed");
	await expect(
		page.getByRole("button", {
			name: "Install audio.cpp runtime",
			exact: true,
		})
	).toHaveCount(0);
});
