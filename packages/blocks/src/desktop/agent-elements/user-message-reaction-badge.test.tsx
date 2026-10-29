import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { UIMessage } from "ai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MessageReactionBucket } from "./message-reactions.tsx";

// The real UserMessage, mounted. message-reaction-badge.test.tsx proves the
// badge in isolation; these cases prove that UserMessage renders it: where it
// sits, which corner it takes for an own or a remote message, what it says, and
// that it only appears when the message carries reactions.
const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

const { UserMessage } = await import("./user-message.tsx");

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
});

const OWN = { id: "me", name: "Jia Wei" };

function textMessage(metadata?: unknown): UIMessage {
	return {
		id: "m1",
		metadata,
		parts: [{ text: "Please run the migration tonight", type: "text" }],
		role: "user",
	} as UIMessage;
}

function mount(
	message: UIMessage,
	reactionBuckets?: readonly MessageReactionBucket[]
): HTMLElement {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	act(() =>
		root?.render(
			<UserMessage
				currentUser={OWN}
				message={message}
				messageActionState={reactionBuckets ? { reactionBuckets } : undefined}
			/>
		)
	);
	return host;
}

function badges(container: HTMLElement): HTMLElement[] {
	return [
		...container.querySelectorAll<HTMLElement>(
			'[data-slot="message-reaction-badge"]'
		),
	];
}

/** The badge's accessible name (it is a `role="img"` with an aria-label). */
function badgeNames(container: HTMLElement): string[] {
	return badges(container).map(
		(badge) =>
			`${badge.getAttribute("role")}:${badge.getAttribute("aria-label")}`
	);
}

describe("the reaction badge inside UserMessage", () => {
	test("a single agent reaction shows as one emoji named for assistive tech", () => {
		const container = mount(textMessage(), [
			{ count: 1, emoji: "👍", reactedByMe: false },
		]);
		expect(badgeNames(container)).toEqual(["img:Reactions: 👍 1"]);
		const badge = badges(container)[0] as HTMLElement;
		// The emoji are decorative; the label carries the content.
		expect(badge.textContent).toBe("👍");
		expect(badge.querySelector("[aria-hidden='true']")?.textContent).toBe("👍");
	});

	test("the badge sits inside the bubble, which makes room for it", () => {
		const container = mount(textMessage(), [
			{ count: 1, emoji: "👍", reactedByMe: false },
		]);
		const bubble = container.querySelector<HTMLElement>('[data-slot="bubble"]');
		expect(bubble === null).toBe(false);
		expect(
			bubble?.querySelector('[data-slot="message-reaction-badge"]') === null
		).toBe(false);
		expect(bubble?.classList.contains("mt-3")).toBe(true);
		expect(bubble?.textContent).toContain("Please run the migration tonight");
	});

	test("several reactions show three emoji and the total, and name every bucket", () => {
		const container = mount(textMessage(), [
			{ count: 2, emoji: "👍", reactedByMe: true },
			{ count: 1, emoji: "🎉", reactedByMe: false },
			{ count: 1, emoji: "🙏", reactedByMe: false },
			{ count: 3, emoji: "😂", reactedByMe: false },
		]);
		const badge = badges(container)[0] as HTMLElement;
		// Three emoji, then the total over all four buckets (2 + 1 + 1 + 3).
		expect(badge.textContent).toBe("👍🎉🙏7");
		expect(badgeNames(container)).toEqual([
			"img:Reactions: 👍 2, 🎉 1, 🙏 1, 😂 3",
		]);
	});

	test("an own message carries the badge on the left corner", () => {
		const container = mount(textMessage({ author: OWN }), [
			{ count: 1, emoji: "👍", reactedByMe: false },
		]);
		const badge = badges(container)[0] as HTMLElement;
		expect(badge.getAttribute("data-align")).toBe("end");
		expect(badge.classList.contains("-left-2")).toBe(true);
		expect(badge.classList.contains("-right-2")).toBe(false);
	});

	test("a teammate's message carries the badge on the right corner", () => {
		const container = mount(
			textMessage({ author: { id: "teammate", name: "Mia Tan" } }),
			[{ count: 1, emoji: "🎉", reactedByMe: false }]
		);
		const badge = badges(container)[0] as HTMLElement;
		expect(badge.getAttribute("data-align")).toBe("start");
		expect(badge.classList.contains("-right-2")).toBe(true);
		expect(badge.classList.contains("-left-2")).toBe(false);
	});

	test("no reactions means no badge and no extra room above the bubble", () => {
		for (const buckets of [undefined, []] as const) {
			const container = mount(textMessage(), buckets);
			expect(badgeNames(container)).toEqual([]);
			const bubble = container.querySelector<HTMLElement>(
				'[data-slot="bubble"]'
			);
			expect(bubble === null).toBe(false);
			expect(bubble?.classList.contains("mt-3")).toBe(false);
			act(() => root?.unmount());
			host?.remove();
		}
	});

	test("the badge follows the reactions when they change", () => {
		const container = mount(textMessage(), [
			{ count: 1, emoji: "👍", reactedByMe: false },
		]);
		expect(badgeNames(container)).toEqual(["img:Reactions: 👍 1"]);
		act(() =>
			root?.render(
				<UserMessage
					currentUser={OWN}
					message={textMessage()}
					messageActionState={{
						reactionBuckets: [
							{ count: 1, emoji: "👍", reactedByMe: false },
							{ count: 1, emoji: "🎉", reactedByMe: false },
						],
					}}
				/>
			)
		);
		expect(badgeNames(container)).toEqual(["img:Reactions: 👍 1, 🎉 1"]);
		act(() =>
			root?.render(
				<UserMessage
					currentUser={OWN}
					message={textMessage()}
					messageActionState={{ reactionBuckets: [] }}
				/>
			)
		);
		expect(badgeNames(container)).toEqual([]);
	});
});
