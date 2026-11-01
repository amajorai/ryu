import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SETTINGS_REMOTE_APPLIED_EVENT } = await import(
	"../settings-sync/local-store.ts"
);
const prefsModule = await import("./sound-preferences.ts");
const {
	clampSoundVolume,
	DEFAULT_SOUND_PREFS,
	isSoundEventEnabled,
	isSoundRowEnabled,
	migrateSoundPrefs,
	parseSoundPrefs,
	readSoundPrefs,
	readSoundVolume,
	SOUND_PREFS_KEY,
	SOUND_VOLUME_KEY,
	setSoundPrefs,
	setSoundRowEnabled,
	setSoundVolume,
	subscribeSoundPrefs,
	useSoundPrefs,
	useSoundVolume,
} = prefsModule;

const roots: Array<{ unmount: () => void }> = [];

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	act(() => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
});

describe("parsing", () => {
	it("uses the defaults on empty storage", () => {
		expect(readSoundPrefs()).toEqual(DEFAULT_SOUND_PREFS);
		expect(DEFAULT_SOUND_PREFS).toEqual({
			v: 1,
			enabled: true,
			pack: "ryu",
			events: {},
			quietInDnd: true,
		});
		expect(readSoundVolume()).toBe(0.6);
	});

	it("falls back to defaults on malformed JSON, a wrong version or oversize values", () => {
		expect(parseSoundPrefs("{nope")).toBe(DEFAULT_SOUND_PREFS);
		expect(parseSoundPrefs(JSON.stringify({ v: 2, enabled: false }))).toBe(
			DEFAULT_SOUND_PREFS
		);
		expect(parseSoundPrefs("[]")).toBe(DEFAULT_SOUND_PREFS);
		const huge = JSON.stringify({
			v: 1,
			enabled: false,
			pad: "x".repeat(5000),
		});
		expect(parseSoundPrefs(huge)).toBe(DEFAULT_SOUND_PREFS);
	});

	it("repairs individual fields: unknown pack, wrong types, unknown event keys", () => {
		const prefs = parseSoundPrefs(
			JSON.stringify({
				v: 1,
				enabled: "yes",
				pack: "classic",
				quietInDnd: false,
				events: { "run-complete": false, bogus: true, message: "off" },
			})
		);
		expect(prefs).toEqual({
			v: 1,
			enabled: true,
			pack: "ryu",
			quietInDnd: false,
			events: { "run-complete": false },
		});
	});

	it("round-trips v1 through the migration seam", () => {
		const stored = {
			v: 1 as const,
			enabled: false,
			pack: "retro" as const,
			events: { calling: false },
			quietInDnd: true,
		};
		expect(migrateSoundPrefs(JSON.parse(JSON.stringify(stored)))).toEqual(
			stored
		);
		expect(migrateSoundPrefs(null)).toBe(DEFAULT_SOUND_PREFS);
	});

	it("clamps the volume", () => {
		expect(clampSoundVolume(Number.NaN)).toBe(0.6);
		expect(clampSoundVolume(-1)).toBe(0);
		expect(clampSoundVolume(2)).toBe(1);
		localStorage.setItem(SOUND_VOLUME_KEY, "abc");
		expect(readSoundVolume()).toBe(0.6);
		localStorage.setItem(SOUND_VOLUME_KEY, "0.25");
		expect(readSoundVolume()).toBe(0.25);
	});

	it("caches by the raw value so useSyncExternalStore sees a stable object", () => {
		const first = readSoundPrefs();
		expect(readSoundPrefs()).toBe(first);
		setSoundPrefs({ pack: "soft" });
		expect(readSoundPrefs()).not.toBe(first);
		expect(readSoundPrefs()).toBe(readSoundPrefs());
	});
});

describe("writing", () => {
	it("persists merged prefs and notifies subscribers", () => {
		let calls = 0;
		const unsubscribe = subscribeSoundPrefs(() => {
			calls += 1;
		});
		setSoundPrefs({ enabled: false });
		setSoundPrefs({ events: { message: false } });
		setSoundPrefs({ events: { calling: false } });
		unsubscribe();
		setSoundPrefs({ pack: "retro" });
		expect(calls).toBe(3);
		expect(JSON.parse(localStorage.getItem(SOUND_PREFS_KEY) ?? "{}")).toEqual({
			v: 1,
			enabled: false,
			pack: "retro",
			events: { message: false, calling: false },
			quietInDnd: true,
		});
	});

	it("stores only real row overrides and resolves them per event", () => {
		setSoundRowEnabled("run-complete", false);
		setSoundRowEnabled("message-sent", true);
		let prefs = readSoundPrefs();
		expect(prefs.events).toEqual({
			"run-complete": false,
			"message-sent": true,
		});
		expect(isSoundEventEnabled(prefs, "run-complete")).toBe(false);
		expect(isSoundEventEnabled(prefs, "message-sent")).toBe(true);
		setSoundRowEnabled("run-complete", true);
		prefs = readSoundPrefs();
		expect(prefs.events).toEqual({ "message-sent": true });
		expect(isSoundRowEnabled(prefs, "run-complete")).toBe(true);
		setSoundRowEnabled("join-leave", false);
		prefs = readSoundPrefs();
		expect(isSoundEventEnabled(prefs, "call-error")).toBe(false);
		expect(isSoundEventEnabled(prefs, "mute")).toBe(true);
	});

	it("persists a clamped volume", () => {
		setSoundVolume(1.7);
		expect(localStorage.getItem(SOUND_VOLUME_KEY)).toBe("1");
		setSoundVolume(0.3);
		expect(readSoundVolume()).toBe(0.3);
	});
});

describe("hooks", () => {
	function Probe() {
		const prefs = useSoundPrefs();
		const volume = useSoundVolume();
		return createElement(
			"output",
			null,
			`${prefs.enabled}|${prefs.pack}|${volume}`
		);
	}

	function mount() {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		roots.push(root);
		act(() => root.render(createElement(Probe)));
		return host;
	}

	it("re-renders on local writes", () => {
		const host = mount();
		expect(host.textContent).toBe("true|ryu|0.6");
		act(() => setSoundPrefs({ enabled: false }));
		act(() => setSoundVolume(0.2));
		expect(host.textContent).toBe("false|ryu|0.2");
	});

	it("re-renders on a storage event from another window", () => {
		const host = mount();
		localStorage.setItem(
			SOUND_PREFS_KEY,
			JSON.stringify({ ...DEFAULT_SOUND_PREFS, pack: "soft" })
		);
		act(() => {
			window.dispatchEvent(
				new StorageEvent("storage", { key: SOUND_PREFS_KEY })
			);
		});
		expect(host.textContent).toBe("true|soft|0.6");
	});

	it("re-renders when settings sync applies a remote value", () => {
		const host = mount();
		localStorage.setItem(
			SOUND_PREFS_KEY,
			JSON.stringify({ ...DEFAULT_SOUND_PREFS, pack: "retro" })
		);
		act(() => {
			window.dispatchEvent(
				new CustomEvent(SETTINGS_REMOTE_APPLIED_EVENT, {
					detail: { key: "ryu:other" },
				})
			);
		});
		expect(host.textContent).toBe("true|ryu|0.6");
		act(() => {
			window.dispatchEvent(
				new CustomEvent(SETTINGS_REMOTE_APPLIED_EVENT, {
					detail: { key: SOUND_PREFS_KEY },
				})
			);
		});
		expect(host.textContent).toBe("true|retro|0.6");
	});
});
