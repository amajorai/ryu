import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { UIMessage } from "ai";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";

// Suites share one process: release the DOM so later files see their own globals.
const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);

const { MessageList } = await import("./message-list.tsx");

// The memoised turn rows must never show stale content: every case below
// changes something a SETTLED turn shows and checks the DOM caught up.

const noop = () => undefined;

function turn(index: number, answer = `Answer ${index}`): UIMessage[] {
	return [
		{
			id: `user-${index}`,
			parts: [{ text: `Question ${index}?`, type: "text" }],
			role: "user",
		},
		{
			id: `assistant-${index}`,
			parts: [{ text: answer, type: "text" }],
			role: "assistant",
		},
	] as UIMessage[];
}

const history = [0, 1, 2].flatMap((index) => turn(index));

type ListProps = Partial<ComponentProps<typeof MessageList>>;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

async function renderList(props: ListProps & { messages: UIMessage[] }) {
	await act(async () => {
		root.render(
			<MessageList
				onBranch={noop}
				onEditMessage={noop}
				onQuote={noop}
				onRegenerateMessage={noop}
				onReply={noop}
				status="ready"
				{...props}
			/>
		);
	});
}

function turnElement(userId: string): HTMLElement {
	const element = container.querySelector<HTMLElement>(
		`[data-slot="message-scroller-item"][data-message-id="${userId}"]`
	);
	if (!element) {
		throw new Error(`turn ${userId} is not rendered`);
	}
	return element;
}

// The reply's hover action row, which a streaming turn does not show.
function hasReplyActions(userId: string): boolean {
	return Boolean(
		turnElement(userId).querySelector(
			'.group\\/assistant-message [aria-label="Reply to message"]'
		)
	);
}

test("a settled message replaced by a new object shows its new content", async () => {
	await renderList({ messages: history });
	expect(turnElement("user-1").textContent).toContain("Answer 1");
	const edited = [...turn(0), ...turn(1, "Rewritten answer"), ...turn(2)];
	await renderList({ messages: edited });
	expect(turnElement("user-1").textContent).toContain("Rewritten answer");
});

test("the streamed turn gains its action row when the stream ends", async () => {
	const messages = [...history, ...turn(3, "Live answer")];
	await renderList({ messages, status: "streaming" });
	expect(hasReplyActions("user-3")).toBe(false);
	expect(hasReplyActions("user-2")).toBe(true);
	await renderList({ messages, status: "ready" });
	expect(hasReplyActions("user-3")).toBe(true);
});

test("the previous live turn settles when a new turn starts streaming", async () => {
	await renderList({
		messages: [...history, ...turn(3, "Live answer")],
		status: "streaming",
	});
	expect(hasReplyActions("user-3")).toBe(false);
	await renderList({
		messages: [...history, ...turn(3, "Live answer"), ...turn(4, "Next")],
		status: "streaming",
	});
	expect(hasReplyActions("user-3")).toBe(true);
	expect(hasReplyActions("user-4")).toBe(false);
});

test("find in chat moves its highlight between settled turns", async () => {
	await renderList({ messages: history, searchActiveMessageId: "assistant-0" });
	expect(turnElement("user-0").dataset.chatSearchActive).toBe("true");
	await renderList({ messages: history, searchActiveMessageId: "user-2" });
	expect(turnElement("user-0").dataset.chatSearchActive).toBeUndefined();
	expect(turnElement("user-2").dataset.chatSearchActive).toBe("true");
});

test("a version list arriving for a settled turn shows its pager", async () => {
	await renderList({ messages: history, onSelectVersion: noop });
	expect(
		turnElement("user-1").querySelector('[aria-label="Previous version"]')
	).toBeNull();
	await renderList({
		messages: history,
		onSelectVersion: noop,
		versions: { "user-1": { count: 2, ids: ["user-1", "user-1b"], index: 1 } },
	});
	expect(
		turnElement("user-1").querySelector('[aria-label="Previous version"]')
	).not.toBeNull();
});

test("naming the assistant labels every settled reply", async () => {
	await renderList({ messages: history });
	expect(turnElement("user-0").textContent).not.toContain("Helper bot");
	await renderList({ assistantName: "Helper bot", messages: history });
	expect(turnElement("user-0").textContent).toContain("Helper bot");
});

test("prepending older history keeps every turn's content", async () => {
	await renderList({ messages: turn(5) });
	await renderList({ messages: [...history, ...turn(5)] });
	for (const index of [0, 1, 2, 5]) {
		expect(turnElement(`user-${index}`).textContent).toContain(
			`Answer ${index}`
		);
	}
});
