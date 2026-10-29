import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";

const STORY_URL = "/voice-settings-proof.html";

interface VoiceProofCall {
	body: unknown;
	method: string;
	path: string;
}

interface VoiceProofBrowserState {
	calls: VoiceProofCall[];
	completePlayback: () => void;
	microphoneGranted: boolean;
	openExternalUrls: string[];
	permissionRequests: number;
	playbackPending: boolean;
	privacySettingsCalls: {
		args: { capability: "microphone" };
		command: "open_privacy_settings";
	}[];
	setMicrophoneGranted: (granted: boolean) => void;
	sinkIds: string[];
	stoppedTracks: number;
}

declare global {
	interface Window {
		__voiceProof?: VoiceProofBrowserState;
	}
}

async function selectOption(
	page: import("@playwright/test").Page,
	control: import("@playwright/test").Locator,
	label: string
) {
	await control.click();
	const listbox = page.locator('[role="listbox"]:visible').last();
	await expect(listbox).toBeVisible();
	await listbox.getByRole("option", { exact: true, name: label }).click();
	await expect(page.locator('[role="listbox"]:visible')).toHaveCount(0);
}

async function seedTtsPrefs(
	page: import("@playwright/test").Page,
	engine = "gateway",
	voice = "alloy",
	engineOptions?: Record<
		string,
		{
			language?: string;
			referenceAudio?: string;
			speed?: number;
			voice?: string;
		}
	>
) {
	await page.addInitScript(
		({ initialEngine, initialVoice, initialEngineOptions }) => {
			if (localStorage.getItem("ryu.tts.engine") === null) {
				localStorage.setItem("ryu.tts.engine", initialEngine);
			}
			if (localStorage.getItem("ryu.tts.voice") === null) {
				localStorage.setItem("ryu.tts.voice", initialVoice);
			}
			if (
				initialEngineOptions &&
				localStorage.getItem("ryu.tts.engine-options") === null
			) {
				localStorage.setItem(
					"ryu.tts.engine-options",
					JSON.stringify(initialEngineOptions)
				);
			}
		},
		{
			initialEngine: engine,
			initialVoice: voice,
			initialEngineOptions: engineOptions,
		}
	);
}

async function openVoiceSettings(
	page: import("@playwright/test").Page,
	scenario?: string
) {
	page.setDefaultTimeout(8000);
	page.setDefaultNavigationTimeout(30_000);
	await page.setViewportSize({ height: 1100, width: 1440 });
	await page.goto(scenario ? `${STORY_URL}?scenario=${scenario}` : STORY_URL);
	await expect(page.getByTestId("voice-settings-proof")).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Audio devices" })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Voice mode display" })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Voice Recognition" })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Read back responses" })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Audio", exact: true })
	).toBeVisible();
}

test.describe.configure({ timeout: 120_000 });

test("chooses microphone and speaker devices and persists system-default resets", async ({
	page,
}) => {
	await seedTtsPrefs(page);
	await openVoiceSettings(page);

	const microphone = page.getByRole("combobox", { name: "Default microphone" });
	const speaker = page.getByRole("combobox", { name: "Default speaker" });
	await expect(microphone).toContainText("System default");
	await expect(speaker).toContainText("System default");
	await selectOption(page, microphone, "MacBook Pro Microphone");
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu_default_microphone"))
		)
		.toBe("mic-built-in");
	await selectOption(page, microphone, "USB Studio Mic");
	await selectOption(page, speaker, "MacBook Pro Speakers");
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu_default_speaker"))
		)
		.toBe("speaker-built-in");
	await selectOption(page, speaker, "USB Headphones");
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu_default_microphone"))
		)
		.toBe("mic-usb");
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu_default_speaker"))
		)
		.toBe("speaker-usb");

	await selectOption(page, microphone, "System default");
	await selectOption(page, speaker, "System default");
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu_default_microphone"))
		)
		.toBeNull();
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu_default_speaker"))
		)
		.toBeNull();
	await expect
		.poll(() => page.evaluate(() => window.__voiceProof?.stoppedTracks ?? 0))
		.toBeGreaterThan(0);

	const evidencePath = path.resolve(
		process.env.RYU_PROOF_OUTPUT_ROOT ?? process.cwd(),
		process.env.RYU_PROOF_OUTPUT_ROOT
			? "desktop-voice-settings.png"
			: "../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-voice-settings.png"
	);
	await mkdir(path.dirname(evidencePath), { recursive: true });
	await page.screenshot({ fullPage: true, path: evidencePath });
});

test("opens OS microphone privacy settings and retries after permission is granted", async ({
	page,
}) => {
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "userAgent", {
			configurable: true,
			get: () => "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
		});
	});
	await seedTtsPrefs(page);
	page.setDefaultTimeout(8000);
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(`${STORY_URL}?mic=denied`);
	await expect(
		page.getByText("Microphone access is blocked", { exact: false })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Open settings", exact: true })
		.click();
	await expect
		.poll(() =>
			page.evaluate(() => window.__voiceProof?.privacySettingsCalls ?? [])
		)
		.toEqual([
			{
				command: "open_privacy_settings",
				args: { capability: "microphone" },
			},
		]);
	expect(
		await page.evaluate(() => window.__voiceProof?.openExternalUrls)
	).toEqual([]);

	await page.evaluate(() => window.__voiceProof?.setMicrophoneGranted(true));
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	const microphone = page.getByRole("combobox", { name: "Default microphone" });
	await selectOption(page, microphone, "USB Studio Mic");
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu_default_microphone"))
		)
		.toBe("mic-usb");
});

test("persists transcript, recognition engine/model, and response read-back settings", async ({
	page,
}) => {
	await seedTtsPrefs(page);
	await openVoiceSettings(page);

	const switches = page.getByRole("switch");
	await expect(switches).toHaveCount(2);
	const transcript = switches.nth(0);
	const readback = switches.nth(1);
	await expect(transcript).toBeChecked();
	await expect(readback).not.toBeChecked();
	await transcript.click();
	await expect(transcript).not.toBeChecked();
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu:voice-show-transcript"))
		)
		.toBe("false");
	await transcript.click();
	await expect(transcript).toBeChecked();
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu:voice-show-transcript"))
		)
		.toBe("true");

	const recognition = page.getByRole("combobox", {
		name: "Voice Recognition engine",
	});
	const model = page.getByRole("combobox", { name: "Voice model" });
	await expect(model).toBeDisabled();
	await expect(model).toContainText("parakeet-tdt-0.6b-v3");
	for (const [engine, bundledModel] of [
		["Whisper", "ggml-base.en"],
		["audio.cpp", "parakeet-tdt-0.6b-v3-q8_0"],
		["Cloud (via gateway)", ""],
		["Parakeet v3", "parakeet-tdt-0.6b-v3"],
	] as const) {
		await selectOption(page, recognition, engine);
		await expect
			.poll(async () => {
				const calls = await page.evaluate(
					() => window.__voiceProof?.calls ?? []
				);
				const write = [...calls]
					.reverse()
					.find(
						(call) =>
							call.path === "/api/preferences/voice-input" &&
							call.method === "PUT"
					);
				const captured = z.object({ value: z.string() }).safeParse(write?.body);
				if (!captured.success) {
					return null;
				}
				return z
					.object({
						engine: z.string().optional(),
						model: z.string().optional(),
					})
					.parse(JSON.parse(captured.data.value));
			})
			.toMatchObject({
				engine:
					engine === "Whisper"
						? "whisper"
						: engine === "audio.cpp"
							? "audiocpp"
							: engine === "Cloud (via gateway)"
								? "gateway"
								: "parakeet",
				model: bundledModel,
			});
		await expect(model).toContainText(bundledModel);
	}

	await readback.click();
	await expect(readback).toBeChecked();
	await expect
		.poll(async () => {
			const calls = await page.evaluate(() => window.__voiceProof?.calls ?? []);
			return calls.some((call) => {
				if (
					call.path !== "/api/preferences/voice-mode-readback" ||
					call.method !== "PUT"
				) {
					return false;
				}
				const value =
					/* SAFETY: The actual private voice-settings harness records bodyRecord results only: a non-null parsed object or {}, with every observed field unknown. This optional-field view does not validate the preference value. */ (
						call.body as { value?: unknown }
					).value;
				return (
					isNativeText(value) &&
					/* SAFETY: The mounted VoiceReadbackSettings checkbox persists its boolean enabled through setVoiceModeReadbackPrefs JSON.stringify and setPreference { value }; this private PUT capture preserves that serialized preference. */ (
						JSON.parse(value) as { enabled?: boolean }
					).enabled === true
				);
			});
		})
		.toBe(true);

	await page.reload();
	await expect(
		page.getByRole("combobox", { name: "Voice Recognition engine" })
	).toContainText("Parakeet v3");
	await expect(
		page.getByRole("combobox", { name: "Voice model" })
	).toContainText("parakeet-tdt-0.6b-v3");
	await expect(page.getByRole("switch").nth(0)).toBeChecked();
	await expect(page.getByRole("switch").nth(1)).toBeChecked();
});

test("changes speech engine and voice, tests spoken output, and retries failed loading", async ({
	page,
}) => {
	await seedTtsPrefs(page, "gateway", "alloy");
	await page.addInitScript(() => {
		localStorage.setItem("ryu_default_speaker", "speaker-usb");
	});
	await openVoiceSettings(page);

	const engine = page.getByRole("combobox", { name: "Audio engine" });
	const voice = page.getByRole("combobox", { name: "Voice", exact: true });
	await expect(engine).toContainText("Cloud (via gateway)");
	await expect(voice).toContainText("alloy");
	for (const gatewayVoice of [
		"alloy",
		"echo",
		"fable",
		"onyx",
		"nova",
		"shimmer",
	]) {
		await selectOption(page, voice, gatewayVoice);
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem("ryu.tts.voice")))
			.toBe(gatewayVoice);
		await expect
			.poll(() =>
				page.evaluate(() =>
					JSON.parse(localStorage.getItem("ryu.tts.engine-options") ?? "{}")
				)
			)
			.toEqual({ gateway: { voice: gatewayVoice } });
	}
	await selectOption(page, engine, "audio.cpp (not installed)");
	await expect(voice).toContainText("alba");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu.tts.engine")))
		.toBe("audiocpp");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu.tts.voice")))
		.toBe("alba");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu.tts.engine")))
		.toBe("audiocpp");
	for (const audioCppVoice of ["alba"]) {
		await selectOption(page, voice, audioCppVoice);
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem("ryu.tts.voice")))
			.toBe(audioCppVoice);
	}
	await selectOption(page, engine, "OuteTTS (built-in)");
	await expect(
		page.getByRole("combobox", { name: "Voice", exact: true })
	).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu.tts.engine")))
		.toBe("outetts");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu.tts.voice")))
		.toBe("");
	await expect(
		page.getByText(
			"OuteTTS uses its bundled model voice and does not accept speech-rate, language, or cloning overrides.",
			{ exact: true }
		)
	).toBeVisible();
	await selectOption(page, engine, "Cloud (via gateway)");
	await selectOption(page, voice, "nova");
	await page.getByRole("button", { name: "Test voice", exact: true }).click();
	await expect
		.poll(async () => {
			const calls = await page.evaluate(() => window.__voiceProof?.calls ?? []);
			return calls.some((call) => {
				if (call.path !== "/api/voice/speak" || call.method !== "POST") {
					return false;
				}
				return (
					/* SAFETY: The mounted native TtsEngineSettings Test voice callback supplies its authored string engine and selected string voice to actual speakText, whose JSON serializer constructs these fields; this private capture excludes foreign requests. */ (
						call.body as { engine?: string; voice?: string }
					).engine === "gateway" &&
					/* SAFETY: The same mounted TtsEngineSettings Test voice request is captured from actual speakText string voice serialization; this optional view is scoped to the private POST speak producer. */ (
						call.body as { voice?: string }
					).voice === "nova"
				);
			});
		})
		.toBe(true);
	await expect
		.poll(() => page.evaluate(() => window.__voiceProof?.sinkIds ?? []))
		.toContain("speaker-usb");
	await expect
		.poll(async () => {
			const calls = await page.evaluate(() => window.__voiceProof?.calls ?? []);
			return [...calls]
				.reverse()
				.find((call) => call.path === "/api/voice/speak")?.body;
		})
		.toEqual({
			engine: "gateway",
			text: "Hi, this is Ryu speaking with the selected voice engine.",
			voice: "nova",
		});
	await expect(
		page.getByText("Couldn’t play the test audio", { exact: false })
	).toHaveCount(0);
	const evidencePath = path.resolve(
		process.env.RYU_PROOF_OUTPUT_ROOT ?? process.cwd(),
		process.env.RYU_PROOF_OUTPUT_ROOT
			? "desktop-voice-settings-readback.png"
			: "../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-voice-settings.png"
	);
	await mkdir(path.dirname(evidencePath), { recursive: true });
	await page.screenshot({
		fullPage: true,
		path: evidencePath,
	});
});

test("saves per-engine generation defaults, validates speed, and previews the exact config", async ({
	page,
}) => {
	await seedTtsPrefs(page, "gateway", "alloy", {
		gateway: { speed: 0.85, voice: "alloy" },
	});
	await openVoiceSettings(page, "tts-play-pending");

	const engine = page.getByRole("combobox", { name: "Audio engine" });
	await expect(engine).toContainText("Cloud (via gateway)");
	await selectOption(page, engine, "audio.cpp (not installed)");
	await expect(engine).toContainText("audio.cpp (not installed)");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu.tts.engine")))
		.toBe("audiocpp");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu.tts.voice")))
		.toBe("alba");

	const voice = page.getByRole("combobox", { name: "Voice", exact: true });
	const speed = page.getByLabel("Speaking speed");
	const language = page.getByLabel("Language");
	const referenceAudio = page.getByLabel("Reference audio path");
	await expect(voice).toContainText("alba");
	await expect(speed).toHaveAttribute("type", "number");
	await expect(speed).toHaveAttribute("min", "0.25");
	await expect(speed).toHaveAttribute("max", "4");
	await expect(language).toContainText("Default");
	await expect(referenceAudio).toBeVisible();

	await selectOption(page, language, "de");
	await referenceAudio.fill("/voices/approved/reference.wav");
	await speed.fill("0.25");
	await expect(speed).toHaveValue("0.25");
	await expect
		.poll(() =>
			page.evaluate(() =>
				JSON.parse(localStorage.getItem("ryu.tts.engine-options") ?? "{}")
			)
		)
		.toEqual({
			audiocpp: {
				language: "de",
				referenceAudio: "/voices/approved/reference.wav",
				speed: 0.25,
				voice: "alba",
			},
			gateway: { speed: 0.85, voice: "alloy" },
		});

	await speed.fill("0.24");
	await expect(
		page.getByText("Speaking speed must be between 0.25 and 4.", {
			exact: true,
		})
	).toBeVisible();
	await expect(speed).toHaveValue("0.25");
	await expect
		.poll(() =>
			page.evaluate(() =>
				JSON.parse(localStorage.getItem("ryu.tts.engine-options") ?? "{}")
			)
		)
		.toEqual({
			audiocpp: {
				language: "de",
				referenceAudio: "/voices/approved/reference.wav",
				speed: 0.25,
				voice: "alba",
			},
			gateway: { speed: 0.85, voice: "alloy" },
		});
	const validationEvidence = path.resolve(
		process.env.RYU_PROOF_OUTPUT_ROOT ?? process.cwd(),
		process.env.RYU_PROOF_OUTPUT_ROOT
			? "desktop-tts-engine-settings-validation.png"
			: "../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-tts-engine-settings-validation.png"
	);
	await mkdir(path.dirname(validationEvidence), { recursive: true });
	await page.screenshot({ fullPage: true, path: validationEvidence });

	await speed.fill("4");
	await expect(speed).toHaveValue("4");
	await speed.fill("4.05");
	await expect(
		page.getByText("Speaking speed must be between 0.25 and 4.", {
			exact: true,
		})
	).toBeVisible();
	await expect(speed).toHaveValue("4");
	await speed.fill("1.25");
	await expect(
		page.getByText("Speaking speed must be between 0.25 and 4.")
	).toHaveCount(0);
	await expect(speed).toHaveValue("1.25");

	await selectOption(page, engine, "Cloud (via gateway)");
	await expect(engine).toContainText("Cloud (via gateway)");
	await expect(page.getByLabel("Speaking speed")).toHaveValue("0.85");
	await expect(page.getByLabel("Language")).toHaveCount(0);
	await expect(page.getByLabel("Reference audio path")).toHaveCount(0);
	await selectOption(page, engine, "audio.cpp (not installed)");
	await expect(page.getByLabel("Speaking speed")).toHaveValue("1.25");
	await expect(page.getByLabel("Language")).toContainText("de");
	await expect(page.getByLabel("Reference audio path")).toHaveValue(
		"/voices/approved/reference.wav"
	);

	await page.reload();
	await expect(
		page.getByRole("combobox", { name: "Audio engine" })
	).toContainText("audio.cpp (not installed)");
	await expect(page.getByLabel("Speaking speed")).toHaveValue("1.25");
	await expect(page.getByLabel("Language")).toContainText("de");
	await expect(page.getByLabel("Reference audio path")).toHaveValue(
		"/voices/approved/reference.wav"
	);
	await expect(
		page.getByRole("combobox", { name: "Voice", exact: true })
	).toContainText("alba");
	await expect
		.poll(() =>
			page.evaluate(() =>
				JSON.parse(localStorage.getItem("ryu.tts.engine-options") ?? "{}")
			)
		)
		.toEqual({
			audiocpp: {
				language: "de",
				referenceAudio: "/voices/approved/reference.wav",
				speed: 1.25,
				voice: "alba",
			},
			gateway: { speed: 0.85, voice: "alloy" },
		});

	await page.getByRole("button", { name: "Test voice", exact: true }).click();
	const testVoice = page.getByRole("button", {
		name: "Speaking…",
		exact: true,
	});
	await expect(testVoice).toBeVisible();
	await expect(testVoice).toBeDisabled();
	await expect
		.poll(() =>
			page.evaluate(() => window.__voiceProof?.playbackPending ?? false)
		)
		.toBe(true);
	await expect
		.poll(async () => {
			const calls = await page.evaluate(() => window.__voiceProof?.calls ?? []);
			return [...calls]
				.reverse()
				.find((call) => call.path === "/api/voice/speak")?.body;
		})
		.toEqual({
			engine: "audiocpp",
			language: "de",
			reference_audio: "/voices/approved/reference.wav",
			speed: 1.25,
			text: "Hi, this is Ryu speaking with the selected voice engine.",
			voice: "alba",
		});
	await page.evaluate(() => window.__voiceProof?.completePlayback());
	await expect(
		page.getByRole("button", { name: "Test voice", exact: true })
	).toBeEnabled();
	await expect(
		page.getByText("Couldn’t play the test audio", { exact: false })
	).toHaveCount(0);

	const evidencePath = path.resolve(
		process.env.RYU_PROOF_OUTPUT_ROOT ?? process.cwd(),
		process.env.RYU_PROOF_OUTPUT_ROOT
			? "desktop-tts-engine-settings-config.png"
			: "../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-tts-engine-settings-config.png"
	);
	await mkdir(path.dirname(evidencePath), { recursive: true });
	await page.screenshot({ fullPage: true, path: evidencePath });
});

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
