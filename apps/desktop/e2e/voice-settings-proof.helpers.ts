import { expect } from "@playwright/test";

// Fixtures and helpers for voice-settings-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export const STORY_URL = "/voice-settings-proof.html";

export interface VoiceProofCall {
	body: unknown;
	method: string;
	path: string;
}

export interface VoiceProofBrowserState {
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

export async function selectOption(
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

export async function seedTtsPrefs(
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

export async function openVoiceSettings(
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
