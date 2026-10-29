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

// Control-level coverage for the shipping VoiceModeDisplaySettings switch. Its
// consumer is the real `useVoiceLiveCall` that ChatPage, the empty-tabs state
// and the composer slot hand to the chat while a voice call is live: the call's
// turns (streamed into the chat transcript) and the assistant's UI cards must
// follow the setting in the same window, in another window (storage event), and
// after a remount. The call's own controls offer no second transcript switch.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
setDefaultTimeout(20_000);

const KEY = "ryu:voice-show-transcript";
const { createRoot } = await import("react-dom/client");
const { VoiceModeDisplaySettings } = await import(
	"./VoiceModeDisplaySettings.tsx"
);
const { useVoiceLiveCall } = await import(
	"@/src/components/voice/VoiceCallComposer.tsx"
);

type VoiceMode = Parameters<typeof useVoiceLiveCall>[0];
const noop = () => undefined;
const liveCall: VoiceMode = {
	active: true,
	agentName: "Ryu",
	caption: "",
	elapsedSeconds: 42,
	error: null,
	interrupt: noop,
	levels: [],
	muted: false,
	phase: "listening",
	start: noop,
	stop: noop,
	toggleMute: noop,
	transcript: "",
	turns: [
		{ id: "turn-user", role: "user", text: "What is on my calendar today?" },
		{
			id: "turn-assistant",
			role: "assistant",
			text: `Two meetings this afternoon.\n\`\`\`ryu-widget\n${JSON.stringify({
				kind: "stat",
				title: "Meetings today",
				config: { label: "Today" },
				data: { value: 2 },
			})}\n\`\`\``,
		},
	],
} as VoiceMode;

/**
 * Renders what a chat host receives from `useVoiceLiveCall`: the call's cards
 * header, its turns as chat messages, and the call row with its controls.
 */
function LiveCall({ voice }: { voice: VoiceMode }) {
	const call = useVoiceLiveCall(voice);
	if (!call.active) {
		return null;
	}
	return (
		<div>
			{call.liveCall.header}
			{call.messages ? (
				<ol data-testid="voice-call-transcript">
					{call.messages.map((message) => (
						<li key={message.id}>
							{message.parts
								.map((part) => (part.type === "text" ? part.text : ""))
								.join("")}
						</li>
					))}
				</ol>
			) : null}
			{call.liveCall.content}
			<div data-testid="voice-call-actions">{call.liveCall.actions}</div>
		</div>
	);
}

let settingsRoot: Root | null = null;
let callRoot: Root | null = null;
let settingsHost: HTMLDivElement;
let callHost: HTMLDivElement;

const storageListeners = new Set<EventListenerOrEventListenerObject>();
const addListener = window.addEventListener.bind(window);
const removeListener = window.removeEventListener.bind(window);
window.addEventListener = ((
	type: string,
	listener: EventListenerOrEventListenerObject,
	options?: boolean | AddEventListenerOptions
) => {
	if (type === "storage") {
		storageListeners.add(listener);
	}
	addListener(type, listener, options);
}) as typeof window.addEventListener;
window.removeEventListener = ((
	type: string,
	listener: EventListenerOrEventListenerObject,
	options?: boolean | EventListenerOptions
) => {
	if (type === "storage") {
		storageListeners.delete(listener);
	}
	removeListener(type, listener, options);
}) as typeof window.removeEventListener;

beforeEach(() => {
	localStorage.clear();
	localStorage.setItem("voice-display-unrelated", "kept");
	settingsHost = document.createElement("div");
	callHost = document.createElement("div");
	document.body.append(settingsHost, callHost);
});

afterEach(async () => {
	await unmountSettings();
	await unmountCall();
	settingsHost.remove();
	callHost.remove();
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must leave unrelated browser storage untouched.
	expect(localStorage.getItem("voice-display-unrelated")).toBe("kept");
	// Every mounted reader removed its cross-window listener.
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must release each cross-window storage listener it added.
	expect(storageListeners.size).toBe(0);
});

async function mountSettings() {
	settingsRoot = createRoot(settingsHost);
	await act(async () => settingsRoot!.render(<VoiceModeDisplaySettings />));
}

async function mountCall(voice: VoiceMode = liveCall) {
	callRoot = createRoot(callHost);
	await act(async () => callRoot!.render(<LiveCall voice={voice} />));
}

async function unmountSettings() {
	if (settingsRoot) {
		const mounted = settingsRoot;
		await act(async () => mounted.unmount());
	}
	settingsRoot = null;
}

async function unmountCall() {
	if (callRoot) {
		const mounted = callRoot;
		await act(async () => mounted.unmount());
	}
	callRoot = null;
}

function settingSwitch() {
	const found =
		settingsHost.querySelector<HTMLButtonElement>('[role="switch"]');
	if (!found) {
		throw new Error(`Missing switch: ${settingsHost.textContent}`);
	}
	return found;
}

function checked() {
	return settingSwitch().getAttribute("aria-checked") === "true";
}

function transcriptPanel() {
	return callHost.querySelector('[data-testid="voice-call-transcript"]');
}

function callCards() {
	return callHost.querySelector('[data-testid="voice-call-widgets"]');
}

function callControls() {
	return [
		...callHost.querySelectorAll<HTMLButtonElement>(
			'[data-testid="voice-call-actions"] button'
		),
	].map((button) => button.getAttribute("aria-label"));
}

function text(element: Element | null | undefined) {
	return element?.textContent?.replace(/\s+/g, " ").trim();
}

test("Show transcript in voice mode defaults on and drives the live call's chat transcript and cards in this window, from another window, and after a remount", async () => {
	await mountSettings();
	await mountCall();
	expect(text(settingsHost.querySelector('[data-slot="item-title"]'))).toBe(
		"Show transcript in voice mode"
	);
	expect(
		text(
			settingsHost.querySelector('[data-slot="item-group"]')?.nextElementSibling
		)
	).toBe("Show call turns in the chat while the call is live.");
	// No stored choice: the setting and the call both default to the transcript.
	expect(localStorage.getItem(KEY)).toBeNull();
	expect(checked()).toBe(true);
	// Turns arrive as chat messages, with the raw card block left out of the text.
	expect(text(transcriptPanel())).toBe(
		"What is on my calendar today?Two meetings this afternoon."
	);
	expect(text(callCards())).toContain("Meetings today");

	await act(async () => settingSwitch().click());
	expect(checked()).toBe(false);
	expect(localStorage.getItem(KEY)).toBe("false");
	// The running call drops the transcript and its cards without being
	// remounted, and stays a single call row.
	expect(transcriptPanel()).toBeNull();
	expect(callCards()).toBeNull();
	expect(
		callHost.querySelector('[data-testid="voice-call-screen"]')
	).not.toBeNull();

	// Another window turns it back on: both readers follow the storage event.
	localStorage.setItem(KEY, "true");
	await act(async () => {
		window.dispatchEvent(
			new StorageEvent("storage", { key: KEY, newValue: "true" })
		);
	});
	expect(checked()).toBe(true);
	expect(transcriptPanel()).not.toBeNull();
	expect(callCards()).not.toBeNull();

	// An unrelated key's storage event changes nothing.
	localStorage.setItem(KEY, "false");
	await act(async () => {
		window.dispatchEvent(
			new StorageEvent("storage", { key: "ryu:something-else", newValue: "x" })
		);
	});
	expect(checked()).toBe(true);
	expect(transcriptPanel()).not.toBeNull();
	localStorage.setItem(KEY, "true");

	await act(async () => settingSwitch().click());
	await unmountSettings();
	await unmountCall();
	await mountSettings();
	await mountCall();
	expect(checked()).toBe(false);
	expect(transcriptPanel()).toBeNull();
	expect(callCards()).toBeNull();
});

test("the call offers no second transcript switch, only the setting changes it, and an ended call publishes nothing", async () => {
	localStorage.setItem(KEY, "false");
	await mountSettings();
	await mountCall();
	expect(checked()).toBe(false);
	expect(transcriptPanel()).toBeNull();
	// The call row's own controls are the call's, never a transcript toggle.
	expect(callControls()).toEqual(["Mute microphone", "End call"]);

	await act(async () => settingSwitch().click());
	expect(localStorage.getItem(KEY)).toBe("true");
	expect(transcriptPanel()).not.toBeNull();
	expect(callControls()).toEqual(["Mute microphone", "End call"]);

	await act(async () => settingSwitch().click());
	expect(localStorage.getItem(KEY)).toBe("false");
	expect(transcriptPanel()).toBeNull();

	// An ended call hands the chat nothing, and the setting stays where the
	// user left it.
	await act(async () =>
		callRoot!.render(
			<LiveCall voice={{ ...liveCall, active: false } as VoiceMode} />
		)
	);
	expect(callHost.childElementCount).toBe(0);
	await act(async () => settingSwitch().click());
	expect(localStorage.getItem(KEY)).toBe("true");
	expect(callHost.childElementCount).toBe(0);
});
