import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { FakeAudioContext } = await import(
	"@/src/lib/sounds/sound-audio-context.fixture.ts"
);
const { __resetSoundEngineForTests, __setSoundSinkForTests } = await import(
	"@/src/lib/sounds/play-sound.ts"
);
const { SOUND_SETTING_ROWS } = await import(
	"@/src/lib/sounds/sound-catalog.ts"
);
const { SOUND_PREFS_KEY, SOUND_VOLUME_KEY, readSoundPrefs } = await import(
	"@/src/lib/sounds/sound-preferences.ts"
);
const { SoundSettings, VOLUME_PREVIEW_DELAY_MS } = await import(
	"./SoundSettings.tsx"
);
const { SOUND_ROW_TITLES } = await import("./SoundSettings-events.tsx");

type FakeContext = InstanceType<typeof FakeAudioContext>;
const contexts: FakeContext[] = [];
class GlobalFakeAudioContext extends FakeAudioContext {
	constructor() {
		super("running");
		contexts.push(this);
	}
}
const originalAudioContext = Object.getOwnPropertyDescriptor(
	globalThis,
	"AudioContext"
);
const oscillatorCount = () =>
	contexts.reduce((total, ctx) => total + ctx.oscillators.length, 0);

interface RecordedCue {
	id: string;
	kind: string;
}
let recorded: RecordedCue[] = [];
const recordCues = () => {
	__setSoundSinkForTests((id, options) => {
		recorded.push({ id, kind: options.kind });
	});
};

const roots: Root[] = [];

beforeEach(() => {
	localStorage.clear();
	recorded = [];
	contexts.length = 0;
	__setSoundSinkForTests(null);
	__resetSoundEngineForTests();
	Object.defineProperty(globalThis, "AudioContext", {
		configurable: true,
		value: GlobalFakeAudioContext,
	});
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	__setSoundSinkForTests(null);
	__resetSoundEngineForTests();
	if (originalAudioContext) {
		Object.defineProperty(globalThis, "AudioContext", originalAudioContext);
	} else {
		Reflect.deleteProperty(globalThis, "AudioContext");
	}
});

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await Promise.resolve();
		}
	});
}

async function until(predicate: () => boolean, label: string) {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (predicate()) {
			return;
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
	throw new Error(`${label} did not settle`);
}

async function mount() {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => root.render(<SoundSettings />));
	await flush();
}

function byLabel(role: string, label: string): HTMLElement {
	const element = document.querySelector<HTMLElement>(
		`[role="${role}"][aria-label="${label}"], ${role}[aria-label="${label}"]`
	);
	if (!element) {
		throw new Error(`Missing ${role} "${label}"`);
	}
	return element;
}

const switchFor = (label: string) => byLabel("switch", label);
const previewFor = (title: string) => byLabel("button", `Preview ${title}`);

function isChecked(element: HTMLElement): boolean {
	return element.getAttribute("aria-checked") === "true";
}

function isDisabled(element: HTMLElement): boolean {
	return (
		element.hasAttribute("disabled") ||
		element.getAttribute("aria-disabled") === "true" ||
		element.hasAttribute("data-disabled")
	);
}

async function click(element: HTMLElement) {
	await act(async () => {
		element.click();
	});
	await flush();
}

function storedPrefs(): unknown {
	return JSON.parse(localStorage.getItem(SOUND_PREFS_KEY) ?? "null");
}

test("the master switch turns sounds off, persists, and locks every event control", async () => {
	await mount();
	const master = switchFor("Play sounds");
	expect(isChecked(master)).toBe(true);
	expect(isDisabled(switchFor("Run complete"))).toBe(false);

	await click(master);

	expect(isChecked(switchFor("Play sounds"))).toBe(false);
	expect(storedPrefs()).toMatchObject({ v: 1, enabled: false });
	for (const title of Object.values(SOUND_ROW_TITLES)) {
		expect(isDisabled(switchFor(title))).toBe(true);
		expect(isDisabled(previewFor(title))).toBe(true);
	}
	expect(isDisabled(byLabel("slider", "Volume"))).toBe(true);
	expect(isDisabled(switchFor("Quiet while Do Not Disturb"))).toBe(true);

	await click(switchFor("Play sounds"));
	expect(readSoundPrefs().enabled).toBe(true);
	expect(isDisabled(switchFor("Run complete"))).toBe(false);
});

test("an event switch stores a sparse override and shows the catalog default otherwise", async () => {
	await mount();
	expect(isChecked(switchFor("Run complete"))).toBe(true);
	// Message sent is off until the user opts in.
	expect(isChecked(switchFor("Message sent"))).toBe(false);

	await click(switchFor("Run complete"));
	expect(storedPrefs()).toMatchObject({ events: { "run-complete": false } });
	expect(isChecked(switchFor("Run complete"))).toBe(false);

	await click(switchFor("Run complete"));
	expect(readSoundPrefs().events).toEqual({});
});

test("Preview plays a row's sound even while that row is switched off", async () => {
	await mount();
	await click(switchFor("Run complete"));
	expect(readSoundPrefs().events["run-complete"]).toBe(false);
	expect(oscillatorCount()).toBe(0);

	await click(previewFor("Run complete"));

	expect(contexts).toHaveLength(1);
	expect(oscillatorCount()).toBeGreaterThan(0);
});

test("Preview plays the first sound a multi-sound row controls", async () => {
	recordCues();
	await mount();
	await click(previewFor("Join and leave"));
	await click(previewFor("Mute and unmute"));
	await click(previewFor("Alerts"));
	expect(recorded).toEqual([
		{ id: "call-join", kind: "preview" },
		{ id: "mute", kind: "preview" },
		{ id: "alert", kind: "preview" },
	]);
});

test("choosing a sound pack persists it and plays a Run complete sample", async () => {
	recordCues();
	await mount();
	await click(byLabel("combobox", "Sound pack"));
	const openOptions = () =>
		[...document.querySelectorAll<HTMLElement>('[role="option"]')].filter(
			(option) => !option.closest("[data-closed]")
		);
	await until(() => openOptions().length === 3, "pack options");
	const retro = openOptions().find(
		(option) => option.textContent?.trim() === "Retro"
	);
	if (!retro) {
		throw new Error("Missing Retro option");
	}
	await click(retro);
	await until(() => readSoundPrefs().pack === "retro", "pack write");

	expect(storedPrefs()).toMatchObject({ pack: "retro" });
	expect(recorded).toEqual([{ id: "run-complete", kind: "preview" }]);
	expect(document.body.textContent).toContain("8-bit square waves");
});

test("the volume slider writes this device's volume and previews once it settles", async () => {
	recordCues();
	await mount();
	const slider = byLabel("slider", "Volume");
	expect(slider.getAttribute("aria-valuenow")).toBe("60");

	for (let step = 0; step < 3; step += 1) {
		await act(async () => {
			byLabel("slider", "Volume").dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
			);
		});
	}
	await flush();

	expect(localStorage.getItem(SOUND_VOLUME_KEY)).toBe("0.63");
	expect(byLabel("slider", "Volume").getAttribute("aria-valuenow")).toBe("63");
	// Synced prefs stay untouched: volume is device-local.
	expect(localStorage.getItem(SOUND_PREFS_KEY)).toBeNull();
	expect(recorded).toEqual([]);

	await act(async () => {
		await Bun.sleep(VOLUME_PREVIEW_DELAY_MS + 50);
	});
	expect(recorded).toEqual([{ id: "message", kind: "preview" }]);
});

test("without Web Audio it says so and disables every control", async () => {
	Reflect.deleteProperty(globalThis, "AudioContext");
	await mount();
	expect(document.body.textContent).toContain(
		"Sounds aren't available in this browser."
	);
	expect(isDisabled(switchFor("Play sounds"))).toBe(true);
	expect(isDisabled(byLabel("slider", "Volume"))).toBe(true);
	expect(isDisabled(switchFor("Achievement unlocked"))).toBe(true);
	expect(isDisabled(previewFor("Achievement unlocked"))).toBe(true);
});

test("row titles match the sound catalog labels and cover every row", () => {
	for (const row of SOUND_SETTING_ROWS) {
		expect<string>(SOUND_ROW_TITLES[row.id]).toBe(row.label);
	}
	expect(Object.keys(SOUND_ROW_TITLES).sort()).toEqual(
		SOUND_SETTING_ROWS.map((row) => row.id).sort()
	);
});
