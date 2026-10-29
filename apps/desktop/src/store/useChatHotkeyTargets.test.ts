import { beforeEach, expect, test } from "bun:test";
import { useChatHotkeyTargets } from "./useChatHotkeyTargets.ts";

function handlers(label: string, calls: string[]) {
	return {
		isStreaming: true,
		stop: () => calls.push(`${label}:stop`),
		startVoiceMode: () => calls.push(`${label}:voice`),
		toggleBottomPanel: () => calls.push(`${label}:bottom`),
		toggleRightPanel: () => calls.push(`${label}:right`),
		toggleSearch: () => calls.push(`${label}:search`),
	};
}

function invokeAll() {
	const slot = useChatHotkeyTargets.getState();
	slot.stop?.();
	slot.startVoiceMode?.();
	slot.toggleBottomPanel?.();
	slot.toggleRightPanel?.();
	slot.toggleSearch?.();
}

beforeEach(() => {
	const { owner, clearIfOwner } = useChatHotkeyTargets.getState();
	if (owner) {
		clearIfOwner(owner);
	}
});

test("publish installs the focused tab's handlers under its owner token", () => {
	const calls: string[] = [];
	useChatHotkeyTargets.getState().publish("tab-a", handlers("a", calls));
	expect(useChatHotkeyTargets.getState().owner).toBe("tab-a");
	expect(useChatHotkeyTargets.getState().isStreaming).toBe(true);
	invokeAll();
	expect(calls).toEqual([
		"a:stop",
		"a:voice",
		"a:bottom",
		"a:right",
		"a:search",
	]);
});

test("a background tab's late cleanup cannot wipe the newly focused tab's Stop", () => {
	const calls: string[] = [];
	const slot = useChatHotkeyTargets.getState();
	slot.publish("tab-a", handlers("a", calls));
	slot.publish("tab-b", handlers("b", calls));
	// tab-a's deactivation effect runs after tab-b already took the slot.
	slot.clearIfOwner("tab-a");
	const state = useChatHotkeyTargets.getState();
	expect(state.owner).toBe("tab-b");
	expect(state.isStreaming).toBe(true);
	invokeAll();
	expect(calls).toEqual([
		"b:stop",
		"b:voice",
		"b:bottom",
		"b:right",
		"b:search",
	]);
});

test("the current owner's cleanup resets every handler and the streaming flag", () => {
	const slot = useChatHotkeyTargets.getState();
	slot.publish("tab-a", handlers("a", []));
	slot.clearIfOwner("tab-a");
	expect(useChatHotkeyTargets.getState()).toMatchObject({
		owner: null,
		isStreaming: false,
		stop: null,
		startVoiceMode: null,
		toggleBottomPanel: null,
		toggleRightPanel: null,
		toggleSearch: null,
	});
	// The actions survive the reset, so the next tab can publish again.
	const calls: string[] = [];
	useChatHotkeyTargets.getState().publish("tab-c", handlers("c", calls));
	useChatHotkeyTargets.getState().stop?.();
	expect(calls).toEqual(["c:stop"]);
});
