import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { UIMessage } from "ai";
import { act, Profiler, type ProfilerOnRenderCallback } from "react";
import { createRoot } from "react-dom/client";
import type { ToolRendererProps } from "./message-list-types.ts";
import type { MessageActionRuntimeState } from "./types.ts";

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
const { UserMessage } = await import("./user-message.tsx");

const PRIOR_TURNS = 30;
const STREAM_CHUNKS = 200;

// Render counters keyed by message id: the user bubble through the
// `UserMessage` slot, the assistant reply through its tool row (every turn's
// reply carries one), which re-renders whenever the reply's parts rebuild.
const userRenders = new Map<string, number>();
const assistantRenders = new Map<string, number>();
const bump = (counts: Map<string, number>, id: string) =>
	counts.set(id, (counts.get(id) ?? 0) + 1);

function CountingUserMessage(
	props: React.ComponentProps<typeof UserMessage>
): React.ReactElement {
	bump(userRenders, props.message.id);
	return <UserMessage {...props} />;
}

function CountingToolRenderer({ part }: ToolRendererProps): React.ReactElement {
	bump(assistantRenders, String(part.toolCallId));
	return <div data-tool-row={part.toolCallId} />;
}

const SLOTS = {
	ToolRenderer: CountingToolRenderer,
	UserMessage: CountingUserMessage,
};
const noop = () => undefined;

function priorTurn(index: number): UIMessage[] {
	return [
		{
			id: `user-${index}`,
			parts: [{ text: `Question number ${index}?`, type: "text" }],
			role: "user",
		},
		{
			id: `assistant-${index}`,
			parts: [
				{
					input: { path: `file-${index}.ts` },
					output: "ok",
					state: "output-available",
					toolCallId: `assistant-${index}`,
					type: "tool-Read",
				},
				{
					text: `Answer ${index}: **bold**, a [link](https://example.com) and a list.\n\n- one\n- two`,
					type: "text",
				},
			],
			role: "assistant",
		},
	] as UIMessage[];
}

function streamingReply(text: string): UIMessage {
	return {
		id: "assistant-live",
		parts: [
			{
				input: { path: "live.ts" },
				output: "ok",
				state: "output-available",
				toolCallId: "assistant-live",
				type: "tool-Read",
			},
			{ state: "streaming", text, type: "text" },
		],
		role: "assistant",
	} as UIMessage;
}

test("streaming a reply re-renders only the live turn", async () => {
	const history = Array.from({ length: PRIOR_TURNS }, (_, index) =>
		priorTurn(index)
	).flat();
	const liveUser: UIMessage = {
		id: "user-live",
		parts: [{ text: "Stream me an answer", type: "text" }],
		role: "user",
	};
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	let commitMs = 0;
	let commits = 0;
	const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
		commitMs += actualDuration;
		commits += 1;
	};
	let actionStates: ReadonlyMap<string, MessageActionRuntimeState> = new Map();
	const renderWith = async (messages: UIMessage[]) => {
		await act(async () => {
			root.render(
				<Profiler id="transcript" onRender={onRender}>
					<MessageList
						messageActionStates={actionStates}
						messages={messages}
						onBranch={noop}
						onEditMessage={noop}
						onQuote={noop}
						onRegenerateMessage={noop}
						onReply={noop}
						slots={SLOTS}
						status="streaming"
					/>
				</Profiler>
			);
		});
	};

	let reply = "Here";
	await renderWith([...history, liveUser, streamingReply(reply)]);
	userRenders.clear();
	assistantRenders.clear();
	commitMs = 0;
	commits = 0;

	const started = performance.now();
	for (let chunk = 0; chunk < STREAM_CHUNKS; chunk++) {
		reply += ` token${chunk}`;
		await renderWith([...history, liveUser, streamingReply(reply)]);
	}
	const wallMs = performance.now() - started;

	const settledUserRenders = Array.from({ length: PRIOR_TURNS }, (_, index) =>
		userRenders.get(`user-${index}`)
	).reduce<number>((sum, count) => sum + (count ?? 0), 0);
	const settledAssistantRenders = Array.from(
		{ length: PRIOR_TURNS },
		(_, index) => assistantRenders.get(`assistant-${index}`)
	).reduce<number>((sum, count) => sum + (count ?? 0), 0);
	if (process.env.RYU_STREAM_RENDER_REPORT) {
		process.stderr.write(
			`${JSON.stringify({
				chunks: STREAM_CHUNKS,
				commitMs: Math.round(commitMs),
				commits,
				liveAssistantRenders: assistantRenders.get("assistant-live") ?? 0,
				liveUserRenders: userRenders.get("user-live") ?? 0,
				priorTurns: PRIOR_TURNS,
				settledAssistantRenders,
				settledUserRenders,
				wallMs: Math.round(wallMs),
			})}\n`
		);
	}

	expect(container.textContent).toContain(`token${STREAM_CHUNKS - 1}`);
	// The live reply keeps up with the stream...
	expect(assistantRenders.get("assistant-live") ?? 0).toBeGreaterThanOrEqual(
		STREAM_CHUNKS
	);
	// ...while every settled turn stays put: at most one render each.
	expect(settledUserRenders).toBeLessThanOrEqual(PRIOR_TURNS);
	expect(settledAssistantRenders).toBeLessThanOrEqual(PRIOR_TURNS);
	// In the live turn itself, the user's message does not follow the reply.
	expect(userRenders.get("user-live") ?? 0).toBe(0);

	// A settled message still renders when something it shows changes: a
	// reaction landing on one user message re-renders that message alone.
	userRenders.clear();
	assistantRenders.clear();
	const userReaction = { toggleValues: { "test-toggle": "on" } };
	actionStates = new Map([["user-7", userReaction]]);
	await renderWith([...history, liveUser, streamingReply(reply)]);
	expect(userRenders.get("user-7")).toBe(1);
	expect(userRenders.get("user-8")).toBeUndefined();
	expect(assistantRenders.get("assistant-7")).toBeUndefined();

	// A reaction on a reply re-renders that turn's row, but neither the user's
	// message above it nor the reply's parts, which show no reactions.
	userRenders.clear();
	assistantRenders.clear();
	actionStates = new Map([
		["user-7", userReaction],
		["assistant-7", { toggleValues: { "test-toggle": "on" } }],
	]);
	await renderWith([...history, liveUser, streamingReply(reply)]);
	expect(userRenders.get("user-7")).toBeUndefined();
	expect(assistantRenders.get("assistant-7")).toBeUndefined();
	await act(async () => root.unmount());
	container.remove();
}, 60_000);

test("in a live turn with several replies, only the streaming one re-renders", async () => {
	const liveUser: UIMessage = {
		id: "user-council",
		parts: [{ text: "Ask the council", type: "text" }],
		role: "user",
	};
	// The first agent's reply is complete; the second is still streaming.
	const firstReply: UIMessage = {
		id: "assistant-first",
		parts: [
			{
				input: { path: "first.ts" },
				output: "ok",
				state: "output-available",
				toolCallId: "assistant-first",
				type: "tool-Read",
			},
			{ text: "First agent's answer.", type: "text" },
		],
		role: "assistant",
	} as UIMessage;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const renderWith = async (text: string) => {
		await act(async () => {
			root.render(
				<MessageList
					messages={[liveUser, firstReply, streamingReply(text)]}
					onBranch={noop}
					onEditMessage={noop}
					onQuote={noop}
					onRegenerateMessage={noop}
					onReply={noop}
					slots={SLOTS}
					status="streaming"
				/>
			);
		});
	};
	let reply = "Second";
	await renderWith(reply);
	assistantRenders.clear();
	const chunks = 50;
	for (let chunk = 0; chunk < chunks; chunk++) {
		reply += ` token${chunk}`;
		await renderWith(reply);
	}
	expect(container.textContent).toContain(`token${chunks - 1}`);
	expect(assistantRenders.get("assistant-live") ?? 0).toBeGreaterThanOrEqual(
		chunks
	);
	expect(assistantRenders.get("assistant-first") ?? 0).toBe(0);
	await act(async () => root.unmount());
	container.remove();
}, 60_000);
