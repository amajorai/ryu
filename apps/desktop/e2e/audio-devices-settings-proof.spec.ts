import { expect, test } from "@playwright/test";

const MIC_KEY = "ryu_default_microphone";
const SPEAKER_KEY = "ryu_default_speaker";
const FIXTURE_PERMISSION_KEY = "__audio_devices_proof_mic_granted";
const SESSION_SEED_KEY = "__audio_devices_proof_seeded";
const CALLS_KEY = "__audio_devices_proof_calls";
const STOPS_KEY = "__audio_devices_proof_tracks_stopped";
const ENUM_FAILURES_KEY = "__audio_devices_proof_enumeration_failures";
const STORY_URL = "/audio-devices-settings-proof.html";

interface PrivacySettingsArguments {
	capability: "microphone";
}

type AudioFixtureCall =
	| { kind: "enumerate" }
	| { kind: "getUserMedia"; constraints: MediaStreamConstraints }
	| { kind: "invoke"; command: string; args: PrivacySettingsArguments };

interface AudioFixtureStream {
	getTracks: () => Pick<MediaStreamTrack, "stop">[];
}

interface AudioFixtureSnapshot {
	calls: AudioFixtureCall[];
	tracksStopped: number;
}

declare global {
	interface Window {
		__audioDevicesProof?: {
			failNextEnumeration: () => void;
			grantMicrophone: () => void;
			snapshot: () => AudioFixtureSnapshot;
		};
	}
}

async function readSnapshot(page: import("@playwright/test").Page) {
	return await page.evaluate(() => {
		const fixture = window.__audioDevicesProof;
		if (!fixture) {
			throw new Error("Audio device fixture is missing");
		}
		return fixture.snapshot();
	});
}

async function readDevicePreferences(page: import("@playwright/test").Page) {
	return await page.evaluate(
		({ microphoneKey, speakerKey }) => ({
			microphone: localStorage.getItem(microphoneKey),
			speaker: localStorage.getItem(speakerKey),
		}),
		{ microphoneKey: MIC_KEY, speakerKey: SPEAKER_KEY }
	);
}

async function openSettings(
	page: import("@playwright/test").Page,
	{
		initiallyGranted = false,
		failInitialEnumeration = false,
	}: { initiallyGranted?: boolean; failInitialEnumeration?: boolean } = {}
) {
	const browserErrors: string[] = [];
	const externalRequests: string[] = [];
	const externalNavigations: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => browserErrors.push(error.message));
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (
			(url.protocol === "http:" || url.protocol === "https:") &&
			url.origin !== "http://127.0.0.1:5261"
		) {
			externalRequests.push(request.url());
		}
	});
	page.on("framenavigated", (frame) => {
		if (frame === page.mainFrame()) {
			const url = new URL(frame.url());
			if (
				(url.protocol === "http:" || url.protocol === "https:") &&
				url.origin !== "http://127.0.0.1:5261"
			) {
				externalNavigations.push(frame.url());
			}
		}
	});
	await page.addInitScript(
		({
			callsKey,
			enumFailuresKey,
			failInitialEnumeration,
			initiallyGranted,
			permissionKey,
			seedKey,
			stopsKey,
		}) => {
			if (sessionStorage.getItem(seedKey) !== "1") {
				localStorage.setItem(permissionKey, String(initiallyGranted));
				sessionStorage.setItem(callsKey, JSON.stringify([]));
				sessionStorage.setItem(stopsKey, "0");
				sessionStorage.setItem(
					enumFailuresKey,
					String(failInitialEnumeration ? 1 : 0)
				);
				sessionStorage.setItem(seedKey, "1");
			}

			Object.defineProperty(navigator, "userAgent", {
				configurable: true,
				value:
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
			});

			const readCalls = (): AudioFixtureCall[] => {
				const stored = sessionStorage.getItem(callsKey);
				// This private fixture key is written only by record() with typed calls.
				const calls: AudioFixtureCall[] = stored ? JSON.parse(stored) : [];
				return calls;
			};
			const record = (call: AudioFixtureCall) => {
				const calls = readCalls();
				calls.push(call);
				sessionStorage.setItem(callsKey, JSON.stringify(calls));
			};
			const fixture = {
				failNextEnumeration: () => {
					sessionStorage.setItem(enumFailuresKey, "1");
				},
				grantMicrophone: () => {
					localStorage.setItem(permissionKey, "true");
				},
				snapshot: (): AudioFixtureSnapshot => ({
					calls: readCalls(),
					tracksStopped: Number(sessionStorage.getItem(stopsKey) ?? "0"),
				}),
			};
			window.__audioDevicesProof = fixture;

			Object.defineProperty(navigator, "mediaDevices", {
				configurable: true,
				value: {
					getUserMedia: async (
						constraints: MediaStreamConstraints
					): Promise<AudioFixtureStream> => {
						record({ kind: "getUserMedia", constraints });
						if (localStorage.getItem(permissionKey) !== "true") {
							throw new DOMException("Permission denied", "NotAllowedError");
						}
						return {
							getTracks: () => [
								{
									stop: () => {
										const stopped = Number(
											sessionStorage.getItem(stopsKey) ?? "0"
										);
										sessionStorage.setItem(stopsKey, String(stopped + 1));
									},
								},
							],
						};
					},
					enumerateDevices: async (): Promise<MediaDeviceInfo[]> => {
						record({ kind: "enumerate" });
						const failures = Number(
							sessionStorage.getItem(enumFailuresKey) ?? "0"
						);
						if (failures > 0) {
							sessionStorage.setItem(enumFailuresKey, String(failures - 1));
							throw new DOMException("Fixture device enumeration failed");
						}
						if (localStorage.getItem(permissionKey) !== "true") {
							return [];
						}
						return [
							{
								deviceId: "mic-usb-proof",
								groupId: "audio-proof",
								kind: "audioinput",
								label: "Desk microphone",
								toJSON: () => ({}),
							},
							{
								deviceId: "speaker-usb-proof",
								groupId: "audio-proof",
								kind: "audiooutput",
								label: "Studio speakers",
								toJSON: () => ({}),
							},
							{
								deviceId: "camera-proof",
								groupId: "video-proof",
								kind: "videoinput",
								label: "Ignored camera",
								toJSON: () => ({}),
							},
						];
					},
				},
			});

			Object.defineProperty(window, "__TAURI_INTERNALS__", {
				configurable: true,
				value: {
					invoke: async (command: string, args: PrivacySettingsArguments) => {
						record({ kind: "invoke", command, args });
						if (
							command !== "open_privacy_settings" ||
							JSON.stringify(args) !==
								JSON.stringify({ capability: "microphone" })
						) {
							throw new Error("Unexpected audio privacy-settings command");
						}
						return null;
					},
					transformCallback: () => 1,
				},
			});
		},
		{
			callsKey: CALLS_KEY,
			enumFailuresKey: ENUM_FAILURES_KEY,
			failInitialEnumeration,
			initiallyGranted,
			permissionKey: FIXTURE_PERMISSION_KEY,
			seedKey: SESSION_SEED_KEY,
			stopsKey: STOPS_KEY,
		}
	);
	await page.goto(STORY_URL, { waitUntil: "domcontentloaded" });
	await expect(
		page.getByRole("heading", { name: "Audio devices" })
	).toBeVisible();
	return { browserErrors, externalNavigations, externalRequests };
}

test("opens the local OS-settings command, retries microphone permission, and persists exact devices", async ({
	page,
}, testInfo) => {
	const { browserErrors, externalNavigations, externalRequests } =
		await openSettings(page);
	const deniedMessage = page.getByText(
		"Microphone access is blocked, so device names are hidden. Turn it on in your system settings, then retry.",
		{ exact: true }
	);
	await expect(deniedMessage).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("desktop-audio-devices-permission-retry.png"),
		fullPage: true,
	});
	const snapshotBeforeRetry = await readSnapshot(page);
	expect(snapshotBeforeRetry.calls).toEqual([
		{ kind: "getUserMedia", constraints: { audio: true } },
		{ kind: "enumerate" },
	]);

	await page.getByRole("button", { name: "Open settings" }).click();
	await expect
		.poll(async () => (await readSnapshot(page)).calls.at(-1))
		.toEqual({
			kind: "invoke",
			command: "open_privacy_settings",
			args: {
				capability: "microphone",
			},
		});
	await expect(page).toHaveURL(/audio-devices-settings-proof\.html$/);

	await page.evaluate(() => {
		const fixture = window.__audioDevicesProof;
		if (!fixture) {
			throw new Error("Audio device fixture is missing");
		}
		fixture.grantMicrophone();
	});
	await page.getByRole("button", { name: "Retry" }).click();
	const microphone = page.getByRole("combobox", { name: "Default microphone" });
	const speaker = page.getByRole("combobox", { name: "Default speaker" });
	await microphone.click();
	await expect(
		page.getByRole("option", { name: "Desk microphone" })
	).toBeVisible();
	await expect(
		page.getByRole("option", { name: "Studio speakers" })
	).toHaveCount(0);
	await expect(
		page.getByRole("option", { name: "Ignored camera" })
	).toHaveCount(0);
	await expect(deniedMessage).toHaveCount(0);

	const retrySnapshot = await readSnapshot(page);
	expect(
		retrySnapshot.calls.filter((call) => call.kind === "getUserMedia")
	).toEqual([
		{ kind: "getUserMedia", constraints: { audio: true } },
		{ kind: "getUserMedia", constraints: { audio: true } },
	]);
	expect(retrySnapshot.tracksStopped).toBe(1);
	await page.getByRole("option", { name: "Desk microphone" }).click();
	await expect(microphone).toContainText("Desk microphone");
	await speaker.click();
	await page.getByRole("option", { name: "Studio speakers" }).click();
	await expect(speaker).toContainText("Studio speakers");
	await expect(await readDevicePreferences(page)).toEqual({
		microphone: "mic-usb-proof",
		speaker: "speaker-usb-proof",
	});

	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(
		page.getByRole("combobox", { name: "Default microphone" })
	).toContainText("Desk microphone");
	await expect(
		page.getByRole("combobox", { name: "Default speaker" })
	).toContainText("Studio speakers");
	await page.screenshot({
		path: testInfo.outputPath("desktop-audio-devices-selected-persisted.png"),
		fullPage: true,
	});

	const reloadedMicrophone = page.getByRole("combobox", {
		name: "Default microphone",
	});
	await reloadedMicrophone.click();
	const microphoneSystemDefault = page.getByRole("option", {
		name: "System default",
		exact: true,
	});
	await microphoneSystemDefault.click();
	await expect(microphoneSystemDefault).toHaveCount(0);
	const reloadedSpeaker = page.getByRole("combobox", {
		name: "Default speaker",
	});
	await reloadedSpeaker.click();
	const speakerSystemDefault = page.getByRole("option", {
		name: "System default",
		exact: true,
	});
	await expect(speakerSystemDefault).toBeVisible();
	await speakerSystemDefault.click();
	await expect(speakerSystemDefault).toHaveCount(0);
	await expect(await readDevicePreferences(page)).toEqual({
		microphone: null,
		speaker: null,
	});
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(
		page.getByRole("combobox", { name: "Default microphone" })
	).toContainText("System default");
	await expect(
		page.getByRole("combobox", { name: "Default speaker" })
	).toContainText("System default");
	expect(externalRequests).toEqual([]);
	expect(externalNavigations).toEqual([]);
	expect(browserErrors).toEqual([]);
});

test("shows a retry after local device enumeration fails despite granted permission", async ({
	page,
}, testInfo) => {
	const { browserErrors, externalNavigations, externalRequests } =
		await openSettings(page, {
			initiallyGranted: true,
			failInitialEnumeration: true,
		});
	await expect(
		page
			.getByRole("alert")
			.getByText("Couldn't list audio devices. Retry to check again.")
	).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("desktop-audio-devices-enumeration-retry.png"),
		fullPage: true,
	});

	await page.getByRole("button", { name: "Retry" }).click();
	const microphone = page.getByRole("combobox", { name: "Default microphone" });
	await microphone.click();
	await expect(
		page.getByRole("option", { name: "Desk microphone" })
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("option", { name: "Desk microphone" })
	).toHaveCount(0);
	await expect(page.getByRole("alert")).toHaveCount(0);
	const snapshot = await readSnapshot(page);
	expect(snapshot.calls).toEqual([
		{ kind: "getUserMedia", constraints: { audio: true } },
		{ kind: "enumerate" },
		{ kind: "getUserMedia", constraints: { audio: true } },
		{ kind: "enumerate" },
	]);
	expect(snapshot.tracksStopped).toBe(2);
	await page.screenshot({
		path: testInfo.outputPath(
			"desktop-audio-devices-enumeration-retry-recovered.png"
		),
		fullPage: true,
	});
	expect(externalRequests).toEqual([]);
	expect(externalNavigations).toEqual([]);
	expect(browserErrors).toEqual([]);
});
