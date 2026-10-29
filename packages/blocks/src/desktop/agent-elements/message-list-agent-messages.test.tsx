import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { UIMessage } from "ai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The real MessageList, mounted. Agent-to-agent sends (`agents.send` and
// `agents.ask`) fold into "Messaged N agents" markers while the transcript is
// drawn, so what matters here is how many markers a message produces and what
// each one says, not how one marker renders in isolation (that is
// tools/agent-messages-marker.test.tsx).
if (typeof document === "undefined") {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);
const { MessageList } = await import("./message-list.tsx");
const { ChatDisplayPrefsProvider } = await import("./chat-display-prefs.tsx");
afterAll(async () => {
	await GlobalRegistrator.unregister();
});

const agentMessageContext = {
	current: { id: "builder", name: "Builder" },
	resolve: (id: string) =>
		({
			legal: { id: "legal", name: "Ryu Legal" },
			marketing: { id: "marketing", name: "Ryu Go-to-Market" },
			reviewer: { id: "reviewer", name: "Ryu Engineering" },
		})[id],
};

/** The transcript's `slots.ToolRenderer` contract (its props type is not exported). */
type HostToolRenderer = NonNullable<
	NonNullable<React.ComponentProps<typeof MessageList>["slots"]>["ToolRenderer"]
>;

let mounted: { container: HTMLElement; root: Root } | null = null;
afterEach(() => {
	if (mounted) {
		act(() => mounted?.root.unmount());
		mounted.container.remove();
		mounted = null;
	}
});

function send(to: string, text: string, toolCallId: string) {
	return {
		input: { text, to },
		output: { from: "builder", ok: true, to },
		state: "output-available",
		toolCallId,
		type: "tool-mcp-agent-comms.agents.send",
	};
}

function ask(to: string, question: string, toolCallId: string) {
	return {
		input: { question, to },
		output: { from: "builder", ok: true, reply: "Looks fine", to },
		state: "output-available",
		toolCallId,
		type: "tool-mcp-agent-comms.agents.ask",
	};
}

function turn(parts: unknown[]): UIMessage[] {
	return [
		{
			id: "u1",
			parts: [{ text: "Coordinate the launch", type: "text" }],
			role: "user",
		},
		{ id: "a1", parts, role: "assistant" },
	] as UIMessage[];
}

function mount(
	messages: UIMessage[],
	extra: Partial<React.ComponentProps<typeof MessageList>> = {},
	prefs: { hideToolDetail?: boolean } = {}
): HTMLElement {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	act(() =>
		root.render(
			<ChatDisplayPrefsProvider value={prefs}>
				<MessageList
					agentMessageContext={agentMessageContext}
					messages={messages}
					status="ready"
					{...extra}
				/>
			</ChatDisplayPrefsProvider>
		)
	);
	return container;
}

function markers(container: HTMLElement): HTMLElement[] {
	return [
		...container.querySelectorAll<HTMLElement>(
			'[data-testid="agent-messages-marker"]'
		),
	];
}

/** What the marker says, one spoken chunk per text node ("Messaged", "3 agents"). */
function sentence(marker: HTMLElement): string {
	const words: string[] = [];
	const walker = document.createTreeWalker(marker, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const text = (node.textContent ?? "").trim();
		if (text) {
			words.push(text);
		}
	}
	return words.join(" ");
}

/** Every marker's sentence, in transcript order. Asserting on strings keeps a
 * failure readable instead of printing DOM nodes. */
function sentences(container: HTMLElement): string[] {
	return markers(container).map(sentence);
}

describe("agent messages in the transcript", () => {
	test("three consecutive sends fold into one 'Messaged 3 agents' marker", () => {
		const container = mount(
			turn([
				send("reviewer", "Ship it?", "c1"),
				send("marketing", "Draft the post", "c2"),
				send("legal", "Check the terms", "c3"),
			])
		);
		expect(sentences(container)).toEqual(["Messaged 3 agents"]);
		// The trigger's accessible name lists every recipient.
		expect(
			markers(container)[0]?.querySelector("button")?.getAttribute("aria-label")
		).toBe("Messaged Ryu Engineering, Ryu Go-to-Market, Ryu Legal");
		// Three calls, one line: no message text leaks into the transcript.
		expect(container.textContent).not.toContain("Ship it?");
		expect(container.textContent).not.toContain("Check the terms");
	});

	test("the marker counts recipients, not calls, and names a lone one", () => {
		const container = mount(
			turn([
				send("reviewer", "Ship it?", "c1"),
				send("reviewer", "Any blockers?", "c2"),
				send("marketing", "Draft the post", "c3"),
				send("reviewer", "Thanks", "c4"),
			])
		);
		expect(sentences(container)).toEqual(["Messaged 2 agents"]);

		act(() => mounted?.root.unmount());
		mounted?.container.remove();
		const single = mount(
			turn([
				send("reviewer", "Ship it?", "d1"),
				send("reviewer", "Any blockers?", "d2"),
			])
		);
		expect(sentences(single)).toEqual(["Messaged Ryu Engineering"]);
	});

	test("asks and sends in one run share one marker", () => {
		const container = mount(
			turn([
				ask("reviewer", "Is the build green?", "c1"),
				send("marketing", "Draft the post", "c2"),
			])
		);
		expect(sentences(container)).toEqual(["Messaged 2 agents"]);
	});

	test("prose between two runs splits them into two markers", () => {
		const container = mount(
			turn([
				send("reviewer", "Ship it?", "c1"),
				send("marketing", "Draft the post", "c2"),
				{
					text: "Both are looking at it. Next I will loop in legal.",
					type: "text",
				},
				send("legal", "Check the terms", "c3"),
			])
		);
		expect(sentences(container)).toEqual([
			"Messaged 2 agents",
			"Messaged Ryu Legal",
		]);
		const found = markers(container);
		// The prose sits between the two markers, in order.
		const prose = [...container.querySelectorAll<HTMLElement>("p")].find(
			(node) => node.textContent?.includes("Next I will loop in legal.")
		);
		expect(prose).toBeDefined();
		const after = Node.DOCUMENT_POSITION_FOLLOWING;
		expect(
			(found[0] as HTMLElement).compareDocumentPosition(prose as Node) & after
		).toBeTruthy();
		expect(
			(prose as HTMLElement).compareDocumentPosition(found[1] as Node) & after
		).toBeTruthy();
	});

	test("a refused send is counted on the folded marker", () => {
		const container = mount(
			turn([
				send("reviewer", "Ship it?", "c1"),
				{
					input: { text: "Loop", to: "marketing" },
					output: { ok: false, refused: "hop_limit" },
					state: "output-available",
					toolCallId: "c2",
					type: "tool-mcp-agent-comms.agents.send",
				},
			])
		);
		expect(sentences(container)).toEqual([
			"Messaged 2 agents · 1 not delivered",
		]);
	});

	test("the roster lists each recipient with how many messages it got", async () => {
		const container = mount(
			turn([
				send("reviewer", "Ship it?", "c1"),
				send("reviewer", "Any blockers?", "c2"),
				send("marketing", "Draft the post", "c3"),
			])
		);
		const trigger = markers(container)[0]?.querySelector("button");
		expect(trigger?.getAttribute("aria-label")).toBe(
			"Messaged Ryu Engineering, Ryu Go-to-Market"
		);
		await act(async () => trigger?.click());
		const rows = [
			...document.querySelectorAll<HTMLElement>(
				'[data-testid="agent-messages-roster"] li'
			),
		].map((row) => (row.textContent ?? "").replace(/\s+/g, " ").trim());
		expect(rows).toEqual([
			"Ryu EngineeringAny blockers?2",
			"Ryu Go-to-MarketDraft the post",
		]);
	});

	test("a host-supplied tool renderer still sees every call on its own", () => {
		const seen: string[] = [];
		const HostRenderer: HostToolRenderer = ({ part }) => {
			seen.push(String(part.toolCallId));
			return <div data-testid="host-tool-row">{String(part.toolCallId)}</div>;
		};
		const container = mount(
			turn([
				send("reviewer", "Ship it?", "c1"),
				send("marketing", "Draft the post", "c2"),
			]),
			{ slots: { ToolRenderer: HostRenderer } }
		);
		expect(sentences(container)).toEqual([]);
		expect(
			[...container.querySelectorAll('[data-testid="host-tool-row"]')].map(
				(row) => row.textContent
			)
		).toEqual(["c1", "c2"]);
		expect([...new Set(seen)]).toEqual(["c1", "c2"]);
	});

	test("at Detail level None a delivered send is hidden and a failed one is not", () => {
		const container = mount(
			turn([
				send("reviewer", "Ship it?", "c1"),
				{ text: "Asked engineering.", type: "text" },
				{
					input: { text: "Draft the post", to: "marketing" },
					state: "output-error",
					toolCallId: "c2",
					type: "tool-mcp-agent-comms.agents.send",
				},
				// Adjacent to the failed call, but hidden, so it must not join it.
				send("legal", "Check the terms", "c3"),
			]),
			{},
			{ hideToolDetail: true }
		);
		expect(sentences(container)).toEqual([
			"Messaged Ryu Go-to-Market · 1 not delivered",
		]);
		expect(container.textContent).toContain("Asked engineering.");
	});

	test("a send still in flight reads 'Messaging', and 'not delivered' once the turn ends without it", () => {
		const parts = [
			{ text: "Pinging both of them now.", type: "text" },
			send("reviewer", "Ship it?", "c1"),
			{
				input: { text: "Draft the post", to: "marketing" },
				state: "input-available",
				toolCallId: "c2",
				type: "tool-mcp-agent-comms.agents.send",
			},
		];
		const live = mount(turn(parts), { status: "streaming" });
		expect(sentences(live)).toEqual(["Messaging 2 agents"]);
		act(() => mounted?.root.unmount());
		mounted?.container.remove();
		// The turn stopped before the second call finished: it was interrupted.
		const settled = mount(turn(parts), { status: "ready" });
		expect(sentences(settled)).toEqual(["Messaged 2 agents · 1 not delivered"]);
	});
});
