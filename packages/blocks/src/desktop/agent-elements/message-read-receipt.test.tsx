import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageReadReceipt } from "./message-read-receipt.tsx";
import { UserMessage } from "./user-message.tsx";

test("renders one tick for a sent message", () => {
	const markup = renderToStaticMarkup(
		<MessageReadReceipt delivered readers={[]} showSent />
	);
	expect(markup).toContain('data-read-state="sent"');
	expect(markup).toContain("Sent");
	expect(markup).not.toContain("AvatarGroup");
});

test("passes durable delivery through the user-message footer", () => {
	const markup = renderToStaticMarkup(
		<UserMessage
			currentUser={{ id: "me", name: "You" }}
			message={
				{
					id: "sent-message",
					parts: [{ text: "Persisted message", type: "text" }],
					role: "user",
				} satisfies UIMessage
			}
			readReceipt={{ delivered: true, readers: [] }}
		/>
	);
	expect(markup).toContain('data-read-state="sent"');
});

test("renders double ticks, avatars, and an accessible seen-by roster", () => {
	const markup = renderToStaticMarkup(
		<MessageReadReceipt
			messageAuthorId="me"
			readers={[
				{
					avatar: "https://cdn.example.test/ada.webp",
					id: "ada",
					name: "Ada Lovelace",
				},
				{ id: "me", name: "You" },
				{ id: "bea", name: "Bea" },
			]}
		/>
	);
	expect(markup).toContain('data-read-state="read"');
	expect(markup).toContain("Seen by Ada Lovelace, Bea");
	expect(markup).toContain("Ada Lovelace");
	expect(markup).toContain("Bea");
	expect(markup).toContain("AL");
});
