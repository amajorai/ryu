import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	BOT_CHAT_SECTIONS_STORAGE_KEY,
	useBotChatSections,
} from "./useBotChatSections.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

type Sections = ReturnType<typeof useBotChatSections>;

let root = createRoot(document.createElement("div"));
let sections: Sections | null = null;

function Probe() {
	sections = useBotChatSections();
	return null;
}

/** A second instance, like the floating sidebar beside the docked one. */
function OtherProbe({ onRender }: { onRender: (value: Sections) => void }) {
	onRender(useBotChatSections());
	return null;
}

function current(): Sections {
	if (!sections) {
		throw new Error("useBotChatSections has not rendered");
	}
	return sections;
}

function storedAssignments(): Record<string, string> {
	const raw = localStorage.getItem(BOT_CHAT_SECTIONS_STORAGE_KEY);
	return raw ? JSON.parse(raw).assignments : {};
}

beforeEach(async () => {
	localStorage.setItem(
		BOT_CHAT_SECTIONS_STORAGE_KEY,
		JSON.stringify({
			assignments: {},
			sections: [{ id: "launch", name: "Launch" }],
		})
	);
	await act(() => root.render(<Probe />));
});

afterEach(async () => {
	await act(() => root.unmount());
	root = createRoot(document.createElement("div"));
	sections = null;
	localStorage.clear();
});

test("files every chat of a multi-chat drop in one update", async () => {
	await act(() => current().assignConversations(["a", "b", "c"], "launch"));
	expect(current().assignments).toEqual({
		a: "launch",
		b: "launch",
		c: "launch",
	});
	expect(storedAssignments()).toEqual({
		a: "launch",
		b: "launch",
		c: "launch",
	});
});

test("composes single assignments made in the same event", async () => {
	await act(() => {
		const { assignConversation } = current();
		assignConversation("a", "launch");
		assignConversation("b", "launch");
	});
	expect(current().assignments).toEqual({ a: "launch", b: "launch" });
	expect(storedAssignments()).toEqual({ a: "launch", b: "launch" });
});

test("a section created in the same event can receive chats at once", async () => {
	let id: string | null = null;
	await act(() => {
		id = current().createSection("Later");
		if (id) {
			current().assignConversations(["a"], id);
		}
	});
	expect(id).not.toBeNull();
	expect(current().assignments).toEqual({ a: id ?? "" });
	expect(storedAssignments()).toEqual({ a: id ?? "" });
});

test("another instance in the same window keeps up instead of overwriting", async () => {
	let other: Sections | null = null;
	const otherRoot = createRoot(document.createElement("div"));
	await act(() =>
		otherRoot.render(
			<OtherProbe
				onRender={(value) => {
					other = value;
				}}
			/>
		)
	);
	const secondInstance = (): Sections => {
		if (!other) {
			throw new Error("the second instance has not rendered");
		}
		return other;
	};

	await act(() => {
		current().createSection("Later");
	});
	expect(secondInstance().sections.map((section) => section.name)).toEqual([
		"Launch",
		"Later",
	]);

	// A write from the other instance starts from the group the first one made.
	await act(() => secondInstance().assignConversations(["a"], "launch"));
	expect(current().assignments).toEqual({ a: "launch" });
	const stored = JSON.parse(
		localStorage.getItem(BOT_CHAT_SECTIONS_STORAGE_KEY) ?? "{}"
	);
	expect(
		stored.sections.map((section: { name: string }) => section.name)
	).toEqual(["Launch", "Later"]);

	await act(() => otherRoot.unmount());
});
