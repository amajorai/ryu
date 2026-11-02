// Marketplace Store home proof. Speech engine settings and shared speech defaults.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { EVIDENCE_DIR } from "./marketplace-store-home.fixture.ts";
import {
	callsFor,
	openStoreSection,
	prepareEvidenceCapture,
	registerStoreHomeEvidenceHooks,
} from "./marketplace-store-home.helpers.ts";

registerStoreHomeEvidenceHooks();

test("speech engines expose per-engine transcription and runtime settings", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	await page.getByRole("button", { name: "Whisper.cpp Fixture" }).click();
	await expect(
		page.getByRole("heading", {
			name: "Speech recognition settings",
			exact: true,
		})
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Core Parakeet settings" })
	).toBeVisible();
	await expect(
		page.getByRole("heading", {
			name: "Gateway speech recognition settings",
		})
	).toBeVisible();
	await expect(
		page.getByText(
			/current in-process runtime does not consume request options/i
		)
	).toBeVisible();
	await page.getByRole("textbox", { name: "Language" }).nth(1).fill("fr");
	await page
		.getByRole("button", { name: "Save transcription settings" })
		.nth(1)
		.click();
	await expect(page.getByText("Saved for this engine").last()).toBeVisible();
	await page.getByRole("textbox", { name: "Language" }).first().fill("fr");
	await page.getByRole("spinbutton", { name: "Beam size" }).first().fill("5");
	await page
		.getByRole("button", { name: "Save transcription settings" })
		.first()
		.click();
	await expect(page.getByText("Saved for this engine").first()).toBeVisible();
	await page.getByRole("textbox", { name: "Language" }).nth(2).fill("es");
	await page
		.getByRole("button", { name: "Save transcription settings" })
		.nth(2)
		.click();
	await expect(page.getByText("Saved for this engine").last()).toBeVisible();
	await page
		.getByRole("heading", {
			name: "Gateway speech recognition settings",
		})
		.scrollIntoViewIfNeeded();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-gateway-stt-settings.png"),
	});
	await page.getByRole("button", { name: "Engine launch settings" }).click();
	await page.getByRole("spinbutton", { name: "Threads" }).fill("6");
	await page
		.getByRole("button", { name: "Save engine launch settings" })
		.click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "Close", exact: true }).click();
	await page.getByRole("button", { name: "Audio.cpp Fixture" }).click();
	await expect(
		page.getByText(/Other typed Whisper options are saved but skipped/i)
	).toBeVisible();
	await page.getByRole("spinbutton", { name: "Threads" }).fill("8");
	await page.getByRole("button", { name: "Save audio.cpp settings" }).click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();
	await page.getByRole("textbox", { name: "Language" }).fill("de");
	await page
		.getByRole("button", { name: "Save transcription settings" })
		.click();
	await expect(page.getByText("Saved for this engine")).toBeVisible();

	expect(
		callsFor(
			fixture,
			"PUT",
			"/api/preferences/engine.transcription.parakeet"
		).map((call) => call.body)
	).toEqual([{ value: JSON.stringify({ language: "fr" }) }]);
	expect(
		callsFor(
			fixture,
			"PUT",
			"/api/preferences/engine.transcription.whispercpp"
		).map((call) => call.body)
	).toEqual([{ value: JSON.stringify({ language: "fr", beam_size: 5 }) }]);
	expect(
		callsFor(
			fixture,
			"PUT",
			"/api/preferences/engine.transcription.gateway"
		).map((call) => call.body)
	).toEqual([{ value: JSON.stringify({ language: "es" }) }]);
	expect(
		callsFor(
			fixture,
			"PUT",
			"/api/preferences/model.launch.engine.whispercpp"
		).map((call) => call.body)
	).toEqual([{ value: JSON.stringify({ threads: 6 }) }]);
	expect(
		callsFor(fixture, "PUT", "/api/preferences/engine.audiocpp.runtime").map(
			(call) => call.body
		)
	).toEqual([{ value: JSON.stringify({ threads: 8 }) }]);
	expect(
		callsFor(
			fixture,
			"PUT",
			"/api/preferences/engine.transcription.audiocpp"
		).map((call) => call.body)
	).toEqual([{ value: JSON.stringify({ language: "de" }) }]);

	await page
		.getByText(/Other typed Whisper options are saved but skipped/i)
		.scrollIntoViewIfNeeded();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-speech-engine-settings.png"),
	});
});

test("text-to-speech defaults are reachable from the Ryu Audio engine", async ({
	page,
}) => {
	await page.addInitScript(() => {
		HTMLMediaElement.prototype.play = function () {
			this.dispatchEvent(new Event("ended"));
			return Promise.resolve();
		};
	});
	const fixture = await openStoreSection(page, "engines");
	await page.getByRole("button", { name: "Ryu Audio Fixture" }).click();
	await expect(
		page.getByRole("heading", { name: "Text-to-speech defaults" })
	).toBeVisible();
	const engineSelect = page.getByRole("combobox", { name: "Audio engine" });
	await engineSelect.click();
	await page.getByRole("option", { name: "Pocket Fixture" }).click();
	await expect(page.getByRole("combobox", { name: "Voice" })).toBeVisible();
	await page.getByRole("spinbutton", { name: "Speaking speed" }).fill("1.25");
	await page.getByRole("combobox", { name: "Language" }).click();
	await page.getByRole("option", { name: "en" }).click();
	await page
		.getByRole("textbox", { name: "Reference audio path" })
		.fill("/voice/references/pocket-sample.wav");
	await page.getByRole("button", { name: "Test voice" }).click();
	await expect
		.poll(() => callsFor(fixture, "POST", "/api/voice/speak").length)
		.toBe(1);
	expect(
		callsFor(fixture, "POST", "/api/voice/speak").map((call) => call.body)
	).toEqual([
		{
			engine: "pocket",
			language: "en",
			reference_audio: "/voice/references/pocket-sample.wav",
			speed: 1.25,
			text: "Hi, this is Ryu speaking with the selected voice engine.",
			voice: "alba",
		},
	]);

	await page
		.getByRole("heading", { name: "Text-to-speech defaults" })
		.scrollIntoViewIfNeeded();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(EVIDENCE_DIR, "marketplace-store-tts-engine-settings.png"),
	});
	const ttsEngineListRequests = callsFor(
		fixture,
		"GET",
		"/api/voice/tts-engines"
	).length;
	expect(ttsEngineListRequests).toBeGreaterThan(0);
	expect(ttsEngineListRequests).toBeLessThanOrEqual(2);
	const speechEngineOptions = await page.evaluate(() =>
		localStorage.getItem("ryu.tts.engine-options")
	);
	expect(JSON.parse(speechEngineOptions ?? "{}")).toEqual({
		pocket: {
			language: "en",
			referenceAudio: "/voice/references/pocket-sample.wav",
			speed: 1.25,
			voice: "alba",
		},
	});
});

test("Speech Processing defaults are shared from the llama.cpp engine detail", async ({
	page,
}) => {
	const fixture = await openStoreSection(page, "engines");
	await page.getByRole("button", { name: "llama.cpp" }).click();
	await expect(
		page.getByRole("heading", { name: "Speech Processing defaults" })
	).toBeVisible();
	await page.getByRole("combobox", { name: "Style" }).click();
	await page.getByRole("option", { name: "Formal", exact: true }).click();
	await page
		.getByRole("button", { name: "Save Speech Processing settings" })
		.click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();
	expect(
		callsFor(fixture, "PUT", "/api/preferences/speech-processing").map(
			(call) => call.body
		)
	).toEqual([
		{
			value: JSON.stringify({
				context: "general",
				engine: "s1-mini",
				structure: "prose",
				styling: "formal",
			}),
		},
	]);

	await page
		.getByRole("heading", { name: "Speech Processing defaults" })
		.scrollIntoViewIfNeeded();
	await prepareEvidenceCapture(page);
	mkdirSync(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		path: resolve(
			EVIDENCE_DIR,
			"marketplace-store-speech-processing-settings.png"
		),
	});
});
