import {
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

// Control-level coverage for the shipping AudioDevicesSettings section and the
// two places its choices take effect: the real voice-input recorder hook
// (`useVoiceRecorder`), which opens the chosen microphone, and the real
// playback helper (`applyDefaultSpeaker`), which routes audio to the chosen
// speaker. Only the operating-system boundary is a fixture here: the
// MediaDevices permission/enumeration API and the webview's setSinkId.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
setDefaultTimeout(20_000);

const MIC_KEY = "ryu_default_microphone";
const SPEAKER_KEY = "ryu_default_speaker";
const DEVICES = [
	{
		deviceId: "mic-built-in",
		kind: "audioinput",
		label: "MacBook Pro Microphone",
	},
	{ deviceId: "mic-usb", kind: "audioinput", label: "USB Studio Mic" },
	{
		deviceId: "speaker-built-in",
		kind: "audiooutput",
		label: "MacBook Pro Speakers",
	},
	{ deviceId: "speaker-usb", kind: "audiooutput", label: "USB Headphones" },
	{ deviceId: "camera", kind: "videoinput", label: "FaceTime Camera" },
];

const os = {
	constraints: [] as MediaStreamConstraints[],
	enumerations: 0,
	failEnumeration: 0,
	granted: true,
	sinkIds: [] as string[],
	tracksStopped: 0,
};
Object.defineProperty(navigator, "mediaDevices", {
	configurable: true,
	value: {
		enumerateDevices: () => {
			os.enumerations += 1;
			if (os.failEnumeration > 0) {
				os.failEnumeration -= 1;
				return Promise.reject(new Error("device enumeration failed"));
			}
			// Labels are hidden from the page until the microphone is granted.
			return Promise.resolve(
				DEVICES.map((device) => ({
					...device,
					label: os.granted ? device.label : "",
				}))
			);
		},
		getUserMedia: (constraints: MediaStreamConstraints) => {
			os.constraints.push(constraints);
			if (!os.granted) {
				return Promise.reject(new Error("NotAllowedError"));
			}
			return Promise.resolve({
				getTracks: () => [
					{
						stop: () => {
							os.tracksStopped += 1;
						},
					},
				],
			});
		},
	},
});
const sinkIdDescriptor = {
	configurable: true,
	value: (deviceId: string) => {
		os.sinkIds.push(deviceId);
		return Promise.resolve();
	},
	writable: true,
};
Object.defineProperty(
	HTMLMediaElement.prototype,
	"setSinkId",
	sinkIdDescriptor
);

const { createRoot } = await import("react-dom/client");
const { AudioDevicesSettings } = await import("./AudioDevicesSettings.tsx");
const { useVoiceRecorder } = await import("@/src/hooks/useVoiceRecorder.ts");
const { applyDefaultSpeaker } = await import("@/src/lib/audio/devices.ts");

let root: Root | null = null;
let container: HTMLDivElement;
let startRecording: (() => Promise<void>) | null = null;

function RecorderProbe() {
	const recorder = useVoiceRecorder({
		onTranscript: () => undefined,
		transcribe: () => Promise.resolve(""),
	});
	startRecording = recorder.start;
	return null;
}

beforeEach(() => {
	localStorage.clear();
	localStorage.setItem("audio-devices-unrelated", "kept");
	os.constraints = [];
	os.enumerations = 0;
	os.failEnumeration = 0;
	os.granted = true;
	os.sinkIds = [];
	os.tracksStopped = 0;
	Object.defineProperty(
		HTMLMediaElement.prototype,
		"setSinkId",
		sinkIdDescriptor
	);
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	await unmount();
	container.remove();
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must leave unrelated browser storage untouched.
	expect(localStorage.getItem("audio-devices-unrelated")).toBe("kept");
});

async function until(predicate: () => boolean, label: string) {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (predicate()) {
			return;
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
	throw new Error(`${label} did not settle: ${container.textContent}`);
}

async function mount() {
	root = createRoot(container);
	await act(async () =>
		root!.render(
			<>
				<AudioDevicesSettings />
				<RecorderProbe />
			</>
		)
	);
}

async function unmount() {
	if (root) {
		const mounted = root;
		await act(async () => mounted.unmount());
	}
	root = null;
	startRecording = null;
}

function text(element: Element | null | undefined) {
	return element?.textContent?.replace("▼", "").replace(/\s+/g, " ").trim();
}

function combo(label: string) {
	const found = container.querySelector<HTMLButtonElement>(
		`[aria-label="${label}"]`
	);
	if (!found) {
		throw new Error(`Missing ${label}: ${container.textContent}`);
	}
	return found;
}

function captionFor(title: string) {
	const heading = [
		...container.querySelectorAll('[data-slot="item-title"]'),
	].find((candidate) => text(candidate) === title);
	return text(heading?.closest('[data-slot="item-group"]')?.nextElementSibling);
}

function openOptions() {
	const listbox = [
		...document.querySelectorAll<HTMLElement>('[role="listbox"]'),
	]
		.filter(
			(box) =>
				!(box.hasAttribute("data-closed") || box.closest("[data-closed]"))
		)
		.at(-1);
	return [...(listbox?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
}

async function optionsOf(label: string) {
	await act(async () => combo(label).click());
	await until(() => openOptions().length > 0, `${label} options`);
	const labels = openOptions().map((option) => text(option));
	await act(async () => {
		document.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
		);
	});
	return labels;
}

async function choose(label: string, option: string) {
	await act(async () => combo(label).click());
	await until(() => openOptions().length > 0, `${label} options`);
	const match = openOptions().find((candidate) => text(candidate) === option);
	if (!match) {
		throw new Error(`Missing ${option} in ${label}`);
	}
	await act(async () => match.click());
	await until(
		() => combo(label).getAttribute("aria-expanded") === "false",
		`${label} close`
	);
}

function button(name: string) {
	return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => text(candidate) === name
	);
}

async function recorderConstraint() {
	const before = os.constraints.length;
	await act(async () => {
		await startRecording!();
	});
	// biome-ignore lint/suspicious/noMisplacedAssertion: each recorder start must make exactly one OS microphone request.
	expect(os.constraints).toHaveLength(before + 1);
	return os.constraints.at(-1);
}

test("the chosen microphone and speaker persist, reach the voice recorder and audio playback, and System default hands both back to the OS", async () => {
	await mount();
	await until(() => os.enumerations === 1, "device listing");
	expect(text(combo("Default microphone"))).toBe("System default");
	expect(text(combo("Default speaker"))).toBe("System default");
	expect(captionFor("Microphone")).toBe("Used for voice input in chat.");
	expect(captionFor("Speaker")).toBe("Output device for audio playback.");
	// Listing asked for the permission once and released the probe stream.
	expect(os.constraints).toEqual([{ audio: true }]);
	expect(os.tracksStopped).toBe(1);
	// Each picker lists only its own device kind.
	expect(await optionsOf("Default microphone")).toEqual([
		"System default",
		"MacBook Pro Microphone",
		"USB Studio Mic",
	]);
	expect(await optionsOf("Default speaker")).toEqual([
		"System default",
		"MacBook Pro Speakers",
		"USB Headphones",
	]);

	await choose("Default microphone", "USB Studio Mic");
	await choose("Default speaker", "USB Headphones");
	expect(localStorage.getItem(MIC_KEY)).toBe("mic-usb");
	expect(localStorage.getItem(SPEAKER_KEY)).toBe("speaker-usb");
	// Voice input opens exactly that microphone.
	expect(await recorderConstraint()).toEqual({
		audio: { deviceId: { exact: "mic-usb" } },
	});
	// Spoken replies are routed to exactly that speaker.
	expect(await applyDefaultSpeaker(document.createElement("audio"))).toBe(true);
	expect(os.sinkIds).toEqual(["speaker-usb"]);

	await unmount();
	await mount();
	await until(() => os.enumerations === 2, "device listing after remount");
	expect(text(combo("Default microphone"))).toBe("USB Studio Mic");
	expect(text(combo("Default speaker"))).toBe("USB Headphones");

	await choose("Default microphone", "System default");
	await choose("Default speaker", "System default");
	expect(localStorage.getItem(MIC_KEY)).toBeNull();
	expect(localStorage.getItem(SPEAKER_KEY)).toBeNull();
	expect(await recorderConstraint()).toEqual({ audio: true });
	expect(await applyDefaultSpeaker(document.createElement("audio"))).toBe(
		false
	);
	expect(os.sinkIds).toEqual(["speaker-usb"]);
});

test("a webview without speaker routing says so but still saves the choice; a blocked microphone and a failed listing each recover through Retry", async () => {
	Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
	os.granted = false;
	await mount();
	await until(() => os.enumerations === 1, "denied listing");
	expect(captionFor("Speaker")).toBe(
		"Saved, but this app may not be able to route audio to it."
	);
	expect(
		container.textContent?.includes(
			"Microphone access is blocked, so device names are hidden. Turn it on in your system settings, then retry."
		)
	).toBe(true);
	// Without the grant the OS hides labels, so the pickers fall back to kind
	// names rather than inventing device names.
	expect(await optionsOf("Default microphone")).toEqual([
		"System default",
		"Microphone",
		"Microphone",
	]);

	os.granted = true;
	await act(async () => button("Retry")!.click());
	await until(
		() =>
			!container.textContent?.includes("Microphone access is blocked") &&
			os.enumerations === 2,
		"permission retry"
	);
	expect(os.tracksStopped).toBe(1);
	await choose("Default speaker", "MacBook Pro Speakers");
	expect(localStorage.getItem(SPEAKER_KEY)).toBe("speaker-built-in");
	expect(await applyDefaultSpeaker(document.createElement("audio"))).toBe(
		false
	);
	expect(os.sinkIds).toEqual([]);

	await unmount();
	os.failEnumeration = 1;
	await mount();
	await until(
		() =>
			text(container.querySelector('[role="alert"]')) ===
			"Couldn't list audio devices. Retry to check again.",
		"listing failure"
	);
	expect(await optionsOf("Default microphone")).toEqual(["System default"]);
	// The saved speaker is still shown as the selection, not reset.
	expect(localStorage.getItem(SPEAKER_KEY)).toBe("speaker-built-in");
	await act(async () => button("Retry")!.click());
	await until(
		() => container.querySelector('[role="alert"]') === null,
		"listing retry"
	);
	expect(text(combo("Default speaker"))).toBe("MacBook Pro Speakers");
	expect(await optionsOf("Default microphone")).toEqual([
		"System default",
		"MacBook Pro Microphone",
		"USB Studio Mic",
	]);
});
