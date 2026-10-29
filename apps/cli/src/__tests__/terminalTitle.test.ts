import { expect, test } from "bun:test";
import { ChatActivityStore } from "../core/chatActivity.ts";
import { TITLE_SPINNER_FRAMES, terminalTitle } from "../core/terminalTitle.ts";

test("idle and streaming titles name the conversation", () => {
	expect(terminalTitle("Plan the launch", null)).toBe("ryu: Plan the launch");
	expect(terminalTitle("Plan the launch", 0)).toBe("⠋ ryu: Plan the launch");
	expect(terminalTitle("Plan", TITLE_SPINNER_FRAMES.length + 1)).toBe(
		`${TITLE_SPINNER_FRAMES[1]} ryu: Plan`
	);
	expect(terminalTitle("", null)).toBe("ryu");
});

test("a conversation title can never inject a terminal escape sequence", () => {
	const title = terminalTitle("evil\u001b]2;owned\u0007\nsecond line", null);
	expect(title).toBe("ryu: evil]2;owned");
	expect([...title].every((character) => character.charCodeAt(0) >= 32)).toBe(
		true
	);
});

test("the focused chat snapshot changes only when its activity does", () => {
	const store = new ChatActivityStore();
	let notified = 0;
	const unsubscribe = store.subscribe(() => {
		notified += 1;
	});
	const chat = Symbol("chat");
	const idle = { focused: true, streaming: false, title: null, model: null };
	store.update(chat, idle);
	const snapshot = store.focused();
	store.update(chat, { ...idle });
	expect(store.focused()).toBe(snapshot);
	store.update(chat, { ...idle, streaming: true });
	expect(store.focused()?.streaming).toBe(true);
	store.update(chat, { ...idle, focused: false });
	expect(store.focused()).toBeNull();
	store.remove(chat);
	expect(notified).toBe(3);
	unsubscribe();
});
