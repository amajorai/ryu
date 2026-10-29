import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageReactionBadge } from "./message-reaction-badge.tsx";

test("renders nothing for a message without reactions", () => {
	expect(renderToStaticMarkup(<MessageReactionBadge buckets={[]} />)).toBe("");
});

test("pins an agent's acknowledgement to the opposite corner of the bubble", () => {
	const markup = renderToStaticMarkup(
		<MessageReactionBadge
			align="end"
			buckets={[{ count: 1, emoji: "👍", reactedByMe: false }]}
		/>
	);
	expect(markup).toContain('data-slot="message-reaction-badge"');
	expect(markup).toContain('aria-label="Reactions: 👍 1"');
	expect(markup).toContain("-left-2");
	expect(markup).toContain("👍");
	// One reaction reads as just the emoji, the way a messaging app shows it.
	expect(markup).not.toContain("tabular-nums");
});

test("summarises several reactions with a total", () => {
	const markup = renderToStaticMarkup(
		<MessageReactionBadge
			align="start"
			buckets={[
				{ count: 2, emoji: "👍", reactedByMe: true },
				{ count: 1, emoji: "🎉", reactedByMe: false },
				{ count: 1, emoji: "🙏", reactedByMe: false },
				{ count: 1, emoji: "😂", reactedByMe: false },
			]}
		/>
	);
	expect(markup).toContain("-right-2");
	expect(markup).toContain('aria-label="Reactions: 👍 2, 🎉 1, 🙏 1, 😂 1"');
	expect(markup).not.toContain(">😂<");
	expect(markup).toContain(">5</span>");
});
