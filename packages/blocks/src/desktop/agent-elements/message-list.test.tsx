import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

if (typeof document === "undefined") {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);
const { MessageList } = await import("./message-list.tsx");

test("shows streamed assistant text while keeping its live status visible", () => {
	const html = renderToStaticMarkup(
		<MessageList
			messages={[
				{
					id: "user-turn",
					parts: [{ text: "Ask a question", type: "text" }],
					role: "user",
				},
				{
					id: "assistant-turn",
					parts: [
						{
							state: "streaming",
							text: "The answer is arriving now.",
							type: "text",
						},
					],
					role: "assistant",
				},
			]}
			status="streaming"
		/>
	);

	const dom = new Window().document;
	dom.body.innerHTML = html;
	const transcript = dom.querySelector('[role="log"]');
	if (!transcript) {
		throw new Error("Actual conversation log is absent");
	}
	expect(transcript.textContent).toContain("Ask a question");
	expect(transcript.textContent).toContain("The answer is arriving now.");
	expect(transcript.getAttribute("aria-busy")).toBe("true");
	expect(transcript.getAttribute("aria-live")).toBe("polite");
	const typing = transcript.querySelector(
		'[data-slot="chat-typing-indicator"]'
	);
	if (!typing) {
		throw new Error("Actual streamed reply typing status is absent");
	}
	expect(typing.getAttribute("role")).toBe("status");
	expect(typing.getAttribute("aria-label")).toBe("Assistant is typing");
});

const copyTurn = [
	{
		id: "user-copy",
		parts: [{ text: "Please summarise this", type: "text" as const }],
		role: "user" as const,
	},
	{
		id: "assistant-copy",
		parts: [{ text: "Here is the summary.", type: "text" as const }],
		role: "assistant" as const,
	},
];

let mounted: { container: HTMLDivElement; root: Root } | undefined;
afterEach(async () => {
	if (!mounted) {
		return;
	}
	const { container, root } = mounted;
	mounted = undefined;
	await act(async () => root.unmount());
	container.remove();
});

async function mountMessageList(showCopyToolbar?: boolean) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () =>
		root.render(
			<MessageList
				messages={copyTurn}
				onReply={() => undefined}
				showCopyToolbar={showCopyToolbar}
				status="ready"
			/>
		)
	);
	return container;
}

/** Right-clicks the message containing `text` and returns the menu labels. */
async function contextMenuLabels(
	container: HTMLElement,
	text: string
): Promise<string[]> {
	const trigger = Array.from(
		container.querySelectorAll<HTMLElement>(
			'[data-slot="message-context-menu-trigger"]'
		)
	).find((node) => node.textContent?.includes(text));
	if (!trigger) {
		throw new Error(`context menu trigger missing for: ${text}`);
	}
	// Right-click lands on the message body, not the trigger wrapper itself.
	const target =
		Array.from(trigger.querySelectorAll<HTMLElement>("*")).find(
			(node) => node.childElementCount === 0 && node.textContent === text
		) ?? trigger;
	await act(async () => {
		target.dispatchEvent(
			new MouseEvent("contextmenu", {
				bubbles: true,
				button: 2,
				cancelable: true,
				clientX: 10,
				clientY: 10,
			})
		);
	});
	const labels = Array.from(
		document.querySelectorAll<HTMLElement>('[role="menuitem"]')
	).map(
		(node) => node.getAttribute("aria-label") ?? node.textContent?.trim() ?? ""
	);
	await act(async () => {
		document.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
		);
	});
	return labels;
}

test("context menu hides Copy text when the copy toolbar is off", async () => {
	const container = await mountMessageList(false);
	for (const text of ["Please summarise this", "Here is the summary."]) {
		const labels = await contextMenuLabels(container, text);
		expect(labels).toContain("Reply");
		expect(labels).not.toContain("Copy text");
	}
});

test("context menu offers Copy text alongside the default copy toolbar", async () => {
	const container = await mountMessageList();
	for (const text of ["Please summarise this", "Here is the summary."]) {
		const labels = await contextMenuLabels(container, text);
		expect(labels).toContain("Reply");
		expect(labels).toContain("Copy text");
	}
});
