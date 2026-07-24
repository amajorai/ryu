import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	spyOn,
} from "bun:test";
import { UiohookKey, uIOhook } from "uiohook-napi";
import {
	acceleratorPrimaryKeycode,
	configureHold,
	isHoldArmed,
	noteHoldPressed,
	setRecording,
	setTabCycle,
	stopHooks,
} from "./voice-control.ts";

describe("acceleratorPrimaryKeycode", () => {
	it("maps the default push-to-talk chord to its letter key", () => {
		expect(acceleratorPrimaryKeycode("CommandOrControl+Shift+A")).toBe(
			UiohookKey.A
		);
	});

	it("takes the last (non-modifier) token as the primary key", () => {
		expect(acceleratorPrimaryKeycode("Alt+Shift+5")).toBe(UiohookKey["5"]);
		expect(acceleratorPrimaryKeycode("Control+F5")).toBe(UiohookKey.F5);
	});

	it("is case-insensitive on the primary letter", () => {
		expect(acceleratorPrimaryKeycode("Ctrl+b")).toBe(UiohookKey.B);
	});

	it("maps named keys through the alias table", () => {
		expect(acceleratorPrimaryKeycode("CommandOrControl+Space")).toBe(
			UiohookKey.Space
		);
		expect(acceleratorPrimaryKeycode("Alt+Enter")).toBe(UiohookKey.Enter);
		expect(acceleratorPrimaryKeycode("Ctrl+Up")).toBe(UiohookKey.ArrowUp);
	});

	it("maps punctuation primary keys", () => {
		expect(acceleratorPrimaryKeycode("Control+/")).toBe(UiohookKey.Slash);
	});

	it("returns null for an unmappable key (caller falls back to toggle)", () => {
		expect(acceleratorPrimaryKeycode("CommandOrControl+VolumeUp")).toBeNull();
		expect(acceleratorPrimaryKeycode("")).toBeNull();
	});
});

// ── Hold-to-talk key-hook state machine ──────────────────────────────────────
//
// The module owns a process-wide singleton uIOhook. We neutralize the native OS
// hook by spying start/stop (so no CGEventTap/SetWindowsHookEx is installed) but
// leave `on` real, then drive the hook by emitting synthetic key events. State
// persists in the module across tests, so afterEach(stopHooks) clears channels.

let startSpy: Mock<() => typeof uIOhook>;
let stopSpy: Mock<() => typeof uIOhook>;

beforeAll(() => {
	startSpy = spyOn(uIOhook, "start").mockImplementation(() => uIOhook);
	stopSpy = spyOn(uIOhook, "stop").mockImplementation(() => uIOhook);
});

beforeEach(() => {
	startSpy.mockClear();
	stopSpy.mockClear();
	startSpy.mockImplementation(() => uIOhook);
});

afterEach(() => {
	stopHooks();
});

describe("configureHold + isHoldArmed", () => {
	it("arms the hook when a channel enters push-to-talk with a mappable key", () => {
		configureHold("voice", {
			keycode: UiohookKey.A,
			onRelease: () => {
				// no-op
			},
			pttMode: true,
		});
		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(isHoldArmed("voice")).toBe(true);
	});

	it("does NOT arm for a toggle-mode channel (pttMode false)", () => {
		configureHold("voice", {
			keycode: UiohookKey.A,
			onRelease: () => {
				// no-op
			},
			pttMode: false,
		});
		expect(startSpy).not.toHaveBeenCalled();
		expect(isHoldArmed("voice")).toBe(false);
	});

	it("does NOT arm when the key is unmappable even in ptt mode", () => {
		// keycode null => the caller degraded to toggle; the hook must stay down.
		configureHold("voice", {
			keycode: null,
			onRelease: () => {
				// no-op
			},
			pttMode: true,
		});
		expect(startSpy).not.toHaveBeenCalled();
		expect(isHoldArmed("voice")).toBe(false);
	});

	it("falls back to toggle (not armed) when the OS denies the hook", () => {
		// Simulate macOS Input Monitoring not granted: start() throws.
		startSpy.mockImplementation(() => {
			throw new Error("permission denied");
		});
		configureHold("voice", {
			keycode: UiohookKey.A,
			onRelease: () => {
				// no-op
			},
			pttMode: true,
		});
		expect(startSpy).toHaveBeenCalled();
		// hookStarted stayed false, so hold is not armed and the caller can fall
		// back to toggle rather than getting stuck with no way to stop capture.
		expect(isHoldArmed("voice")).toBe(false);
	});

	it("stops the hook when the last ptt channel leaves ptt mode", () => {
		configureHold("voice", {
			keycode: UiohookKey.A,
			onRelease: () => {
				// no-op
			},
			pttMode: true,
		});
		expect(isHoldArmed("voice")).toBe(true);

		// Reconfigure the same channel to toggle mode: nothing else needs the hook.
		configureHold("voice", {
			keycode: UiohookKey.A,
			onRelease: () => {
				// no-op
			},
			pttMode: false,
		});
		expect(stopSpy).toHaveBeenCalled();
		expect(isHoldArmed("voice")).toBe(false);
	});
});

describe("hold-to-talk release detection", () => {
	it("fires onRelease only after the key is noted pressed, then key-up", () => {
		let released = 0;
		configureHold("voice", {
			keycode: UiohookKey.A,
			onRelease: () => {
				released += 1;
			},
			pttMode: true,
		});

		// A key-up with no prior press must NOT fire (not holding yet).
		uIOhook.emit("keyup", { keycode: UiohookKey.A, shiftKey: false });
		expect(released).toBe(0);

		// Note the shortcut press (the only key-down source), then release.
		noteHoldPressed("voice");
		uIOhook.emit("keyup", { keycode: UiohookKey.A, shiftKey: false });
		expect(released).toBe(1);

		// A second stray key-up does not double-fire (holding cleared on release).
		uIOhook.emit("keyup", { keycode: UiohookKey.A, shiftKey: false });
		expect(released).toBe(1);
	});

	it("ignores a key-up for a different keycode", () => {
		let released = 0;
		configureHold("voice", {
			keycode: UiohookKey.A,
			onRelease: () => {
				released += 1;
			},
			pttMode: true,
		});
		noteHoldPressed("voice");
		uIOhook.emit("keyup", { keycode: UiohookKey.B, shiftKey: false });
		expect(released).toBe(0);
	});

	it("routes each channel's release to its own callback", () => {
		let voiceReleased = 0;
		let dictationReleased = 0;
		configureHold("voice", {
			keycode: UiohookKey.A,
			onRelease: () => {
				voiceReleased += 1;
			},
			pttMode: true,
		});
		configureHold("dictation", {
			keycode: UiohookKey.D,
			onRelease: () => {
				dictationReleased += 1;
			},
			pttMode: true,
		});
		noteHoldPressed("voice");
		noteHoldPressed("dictation");

		uIOhook.emit("keyup", { keycode: UiohookKey.D, shiftKey: false });
		expect(dictationReleased).toBe(1);
		expect(voiceReleased).toBe(0);

		uIOhook.emit("keyup", { keycode: UiohookKey.A, shiftKey: false });
		expect(voiceReleased).toBe(1);
	});

	it("noteHoldPressed is a no-op for a toggle-mode channel", () => {
		let released = 0;
		configureHold("voice", {
			keycode: UiohookKey.A,
			onRelease: () => {
				released += 1;
			},
			pttMode: false,
		});
		noteHoldPressed("voice");
		uIOhook.emit("keyup", { keycode: UiohookKey.A, shiftKey: false });
		expect(released).toBe(0);
	});
});

describe("setRecording keeps the hook up while capturing", () => {
	it("arms the hook on record and tears it down on stop", () => {
		// No ptt channel: recording alone keeps the hook up (for Tab-cycling).
		setRecording("voice", true);
		expect(startSpy).toHaveBeenCalledTimes(1);

		setRecording("voice", false);
		expect(stopSpy).toHaveBeenCalledTimes(1);
	});
});

describe("Tab agent-cycling", () => {
	it("cycles forward on Tab and backward on Shift+Tab while recording", () => {
		const directions: number[] = [];
		setTabCycle("voice", (dir) => directions.push(dir));
		setRecording("voice", true);

		uIOhook.emit("keydown", { keycode: UiohookKey.Tab, shiftKey: false });
		uIOhook.emit("keydown", { keycode: UiohookKey.Tab, shiftKey: true });
		expect(directions).toEqual([1, -1]);

		setRecording("voice", false);
	});

	it("does not cycle when the owning channel is not recording", () => {
		const directions: number[] = [];
		setTabCycle("voice", (dir) => directions.push(dir));
		// Not recording: keep the hook up via a ptt arm so the handler still runs,
		// but the recording gate must suppress the cycle.
		configureHold("voice", {
			keycode: UiohookKey.A,
			onRelease: () => {
				// no-op
			},
			pttMode: true,
		});

		uIOhook.emit("keydown", { keycode: UiohookKey.Tab, shiftKey: false });
		expect(directions).toEqual([]);
	});

	it("ignores non-Tab key-downs", () => {
		const directions: number[] = [];
		setTabCycle("voice", (dir) => directions.push(dir));
		setRecording("voice", true);

		uIOhook.emit("keydown", { keycode: UiohookKey.A, shiftKey: false });
		expect(directions).toEqual([]);

		setRecording("voice", false);
	});
});

describe("stopHooks", () => {
	it("clears channels + recordings and tears the hook down", () => {
		configureHold("voice", {
			keycode: UiohookKey.A,
			onRelease: () => {
				// no-op
			},
			pttMode: true,
		});
		setRecording("voice", true);
		expect(isHoldArmed("voice")).toBe(true);

		stopHooks();

		expect(isHoldArmed("voice")).toBe(false);
		expect(stopSpy).toHaveBeenCalled();
	});
});
