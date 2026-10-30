import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { reuseEqualMentionItems } from "./ChatPage.mention-items.ts";

function Icon(_props: { className?: string }) {
	return null;
}
function OtherIcon(_props: { className?: string }) {
	return null;
}

const build = (label = "Notes", icon = Icon, conversationId = "c-1") => [
	{
		icon: createElement(icon, { className: "size-3.5" }),
		id: "app:notes",
		kind: "app",
		label,
		target: { options: { conversationId }, path: "/apps/notes" },
		visualIcon: createElement(icon, { className: "size-3.5 shrink-0" }),
	},
	{ id: "agent:ada", kind: "agent", label: "Ada" },
];

describe("reuseEqualMentionItems", () => {
	test("keeps the previous list when a rebuild draws the same candidates", () => {
		const previous = build();
		expect(reuseEqualMentionItems(previous, build())).toBe(previous);
	});

	test("takes the new list when a candidate's label, icon or target changes", () => {
		const previous = build();
		for (const next of [
			build("Notebook"),
			build("Notes", OtherIcon),
			build("Notes", Icon, "c-2"),
			build().slice(0, 1),
		]) {
			expect(reuseEqualMentionItems(previous, next)).toBe(next);
		}
	});
});
