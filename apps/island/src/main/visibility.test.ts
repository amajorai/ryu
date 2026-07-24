import { afterEach, describe, expect, it } from "bun:test";
import type { BrowserWindow } from "electron";
import { IPC } from "../shared/ipc.ts";
import {
	focusForCommand,
	hideWindow,
	isVisible,
	onVisibilityChanged,
	setVisibilityTarget,
	showWindow,
	toggleWindow,
} from "./visibility.ts";

// A minimal in-memory stand-in for the island BrowserWindow. Records the calls
// the visibility controller makes so we can assert the show/hide/focus paths
// without a real Electron window.
interface SentMessage {
	arg: unknown;
	channel: string;
}

function makeFakeWindow(initialVisible = false) {
	const sent: SentMessage[] = [];
	const state = {
		visible: initialVisible,
		destroyed: false,
		ignoreMouse: true,
		movedTop: 0,
		focused: 0,
	};
	const win = {
		isDestroyed: () => state.destroyed,
		isVisible: () => state.visible,
		show: () => {
			state.visible = true;
		},
		hide: () => {
			state.visible = false;
		},
		setIgnoreMouseEvents: (ignore: boolean) => {
			state.ignoreMouse = ignore;
		},
		moveTop: () => {
			state.movedTop += 1;
		},
		focus: () => {
			state.focused += 1;
		},
		webContents: {
			send: (channel: string, arg: unknown) => {
				sent.push({ channel, arg });
			},
		},
	};
	return {
		win: win as unknown as BrowserWindow,
		state,
		sent,
	};
}

afterEach(() => {
	// Detach so no test leaks its window into the next one.
	setVisibilityTarget(null);
});

describe("isVisible", () => {
	it("is false with no target", () => {
		setVisibilityTarget(null);
		expect(isVisible()).toBe(false);
	});

	it("is false when the target is destroyed", () => {
		const { win, state } = makeFakeWindow(true);
		setVisibilityTarget(win);
		state.destroyed = true;
		expect(isVisible()).toBe(false);
	});

	it("reflects the window's own visibility", () => {
		const { win, state } = makeFakeWindow(false);
		setVisibilityTarget(win);
		expect(isVisible()).toBe(false);
		state.visible = true;
		expect(isVisible()).toBe(true);
	});
});

describe("showWindow / hideWindow", () => {
	it("shows the window and notifies the renderer + listeners", () => {
		const { win, state, sent } = makeFakeWindow(false);
		setVisibilityTarget(win);
		const seen: boolean[] = [];
		const off = onVisibilityChanged((v) => seen.push(v));

		showWindow();

		expect(state.visible).toBe(true);
		expect(seen).toEqual([true]);
		expect(sent).toEqual([
			{ channel: IPC.window.visibilityChanged, arg: true },
		]);
		off();
	});

	it("hides the window and notifies with false", () => {
		const { win, state, sent } = makeFakeWindow(true);
		setVisibilityTarget(win);
		const seen: boolean[] = [];
		const off = onVisibilityChanged((v) => seen.push(v));

		hideWindow();

		expect(state.visible).toBe(false);
		expect(seen).toEqual([false]);
		expect(sent.at(-1)).toEqual({
			channel: IPC.window.visibilityChanged,
			arg: false,
		});
		off();
	});

	it("is a no-op (no notify) when there is no target", () => {
		setVisibilityTarget(null);
		const seen: boolean[] = [];
		const off = onVisibilityChanged((v) => seen.push(v));
		showWindow();
		hideWindow();
		expect(seen).toEqual([]);
		off();
	});

	it("is a no-op when the target is destroyed", () => {
		const { win, state, sent } = makeFakeWindow(false);
		setVisibilityTarget(win);
		state.destroyed = true;
		showWindow();
		expect(sent).toEqual([]);
	});
});

describe("toggleWindow", () => {
	it("shows when hidden and hides when shown", () => {
		const { win, state } = makeFakeWindow(false);
		setVisibilityTarget(win);

		toggleWindow();
		expect(state.visible).toBe(true);

		toggleWindow();
		expect(state.visible).toBe(false);
	});
});

describe("focusForCommand", () => {
	it("shows, disables click-through, and grabs keyboard focus", () => {
		const { win, state } = makeFakeWindow(false);
		setVisibilityTarget(win);

		focusForCommand();

		expect(state.visible).toBe(true);
		// Click-through OFF so the command palette accepts typing.
		expect(state.ignoreMouse).toBe(false);
		expect(state.movedTop).toBe(1);
		expect(state.focused).toBe(1);
	});

	it("is a no-op when the target is destroyed", () => {
		const { win, state } = makeFakeWindow(false);
		setVisibilityTarget(win);
		state.destroyed = true;

		focusForCommand();

		expect(state.visible).toBe(false);
		expect(state.focused).toBe(0);
	});
});

describe("onVisibilityChanged", () => {
	it("stops delivering after unsubscribe", () => {
		const { win } = makeFakeWindow(false);
		setVisibilityTarget(win);
		const seen: boolean[] = [];
		const off = onVisibilityChanged((v) => seen.push(v));

		showWindow();
		off();
		hideWindow();

		// Only the pre-unsubscribe show was delivered.
		expect(seen).toEqual([true]);
	});

	it("does not notify when the target is already torn down", () => {
		const { win, state } = makeFakeWindow(false);
		setVisibilityTarget(win);
		state.destroyed = true;
		const seen: boolean[] = [];
		const off = onVisibilityChanged((v) => seen.push(v));

		// showWindow bails on a destroyed target, so no notify fires; assert the
		// listener is wired but silent (guards the destroyed-target branch).
		showWindow();
		expect(seen).toEqual([]);
		off();
	});
});
