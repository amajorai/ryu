import { expect, test } from "bun:test";
import {
	countNewSinceAway,
	isAwayFromBottom,
	jumpToLatestLabel,
	transcriptHalfStep,
	transcriptPageStep,
} from "../core/transcriptScroll.ts";
import { transcriptScrollForKey } from "../surfaces/chat/transcriptScroll.tsx";

const key = (name: string, ctrl = false, meta = false) => ({
	ctrl,
	meta,
	name,
});

test("maps page and ctrl+home/end keys but leaves plain home/end to the input", () => {
	expect(transcriptScrollForKey(key("pageup"))).toBe("pageUp");
	expect(transcriptScrollForKey(key("pagedown"))).toBe("pageDown");
	expect(transcriptScrollForKey(key("home", true))).toBe("top");
	expect(transcriptScrollForKey(key("end", true))).toBe("bottom");
	expect(transcriptScrollForKey(key("u", true, true))).toBe("halfUp");
	expect(transcriptScrollForKey(key("d", true, true))).toBe("halfDown");
	expect(transcriptScrollForKey(key("home"))).toBeNull();
	expect(transcriptScrollForKey(key("end"))).toBeNull();
	expect(transcriptScrollForKey(key("u", true))).toBeNull();
});

test("half-page scroll accepts Alt reported as option (kitty protocol)", () => {
	const optionKey = (name: string) => ({
		ctrl: true,
		meta: false,
		name,
		option: true,
	});
	expect(transcriptScrollForKey(optionKey("u"))).toBe("halfUp");
	expect(transcriptScrollForKey(optionKey("d"))).toBe("halfDown");
});

test("page steps keep context and never stall at zero", () => {
	expect(transcriptPageStep(20)).toBe(18);
	expect(transcriptPageStep(1)).toBe(1);
	expect(transcriptHalfStep(21)).toBe(10);
	expect(transcriptHalfStep(1)).toBe(1);
});

test("away from bottom allows one row of slack", () => {
	const at = (scrollTop: number) =>
		isAwayFromBottom({ scrollHeight: 100, scrollTop, viewportHeight: 20 });
	expect(at(80)).toBe(false);
	expect(at(79)).toBe(false);
	expect(at(78)).toBe(true);
	expect(
		isAwayFromBottom({ scrollHeight: 10, scrollTop: 0, viewportHeight: 20 })
	).toBe(false);
});

test("counts appended messages and a replaced trailing message", () => {
	const first = { id: 1 };
	const last = { id: 2 };
	const snapshot = { last, length: 2 };
	expect(countNewSinceAway([first, last], snapshot)).toBe(0);
	expect(countNewSinceAway([first, { id: 2 }], snapshot)).toBe(1);
	expect(countNewSinceAway([first, last, { id: 3 }], snapshot)).toBe(1);
	expect(countNewSinceAway([first, { id: 2 }, { id: 3 }], snapshot)).toBe(2);
	expect(countNewSinceAway([], snapshot)).toBe(0);
});

test("strip label shows the new count only when there is one", () => {
	expect(jumpToLatestLabel(0, "↓")).toBe("Jump to latest ↓ · Ctrl+End");
	expect(jumpToLatestLabel(3, "v")).toBe("Jump to latest v (3 new) · Ctrl+End");
});
