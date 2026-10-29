import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { UIMessage } from "ai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SuggestedTask } from "./tools/suggested-task.ts";
import type { SuggestedTaskStartMode } from "./tools/suggested-task-card.tsx";

// The real AgentChat, mounted. The host supplies `taskSuggestions`; the
// transcript supplies a finished `tasks.suggest` call. These cases pin when the
// card is on screen and what each of its buttons hands the host.
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

const { AgentChat } = await import("./agent-chat.tsx");

type TaskSuggestions = NonNullable<
	React.ComponentProps<typeof AgentChat>["taskSuggestions"]
>;
type ChatStatus = React.ComponentProps<typeof AgentChat>["status"];

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
});

// Dismissals live in module state for the whole session, so every case uses
// its own tool-call id and never sees another case's dismissal.
let callCounter = 0;
function nextCallId(): string {
	callCounter += 1;
	return `suggest-call-${callCounter}`;
}

const TASK_FIELDS = {
	description: "The cooldown error escapes as a 500.",
	prompt: "Map the cooldown error to a 429 and add a router test.",
	title: "Answer step-up email cooldown with 429",
};

function suggestionTurn(callId: string, state = "output-available") {
	return [
		{
			id: "u1",
			parts: [{ text: "Fix the login bug", type: "text" }],
			role: "user",
		},
		{
			id: "a1",
			parts: [
				{ text: "Fixed. One more thing I noticed.", type: "text" },
				{
					input: TASK_FIELDS,
					output: { ok: true },
					state,
					toolCallId: callId,
					type: "tool-tasks.suggest",
				},
			],
			role: "assistant",
		},
	] as unknown as UIMessage[];
}

function mount(props: {
	error?: Error;
	messages: UIMessage[];
	status?: ChatStatus;
	taskSuggestions?: TaskSuggestions;
}): HTMLElement {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	renderInto(props);
	return host;
}

function renderInto(props: {
	error?: Error;
	messages: UIMessage[];
	status?: ChatStatus;
	taskSuggestions?: TaskSuggestions;
}) {
	act(() =>
		root?.render(
			<AgentChat
				error={props.error}
				messages={props.messages}
				onSend={() => undefined}
				onStop={() => undefined}
				status={props.status ?? "ready"}
				taskSuggestions={props.taskSuggestions}
			/>
		)
	);
}

function card(container: HTMLElement): HTMLElement | null {
	return container.querySelector<HTMLElement>("[data-suggested-task]");
}

function has(container: ParentNode, selector: string): boolean {
	return container.querySelector(selector) !== null;
}

/** The shown card's tool-call id, or null. Asserting on this (not on the
 * element) keeps a failure message readable instead of dumping the DOM. */
function cardId(container: HTMLElement): string | null {
	return card(container)?.getAttribute("data-suggested-task") ?? null;
}

function button(label: string, scope: ParentNode = document): HTMLElement {
	const match = [...scope.querySelectorAll<HTMLElement>("button")].find(
		(element) =>
			element.textContent?.trim() === label ||
			element.getAttribute("aria-label") === label
	);
	if (!match) {
		throw new Error(`no button "${label}"`);
	}
	return match;
}

function recorder() {
	const started: Array<{ id: string; mode: SuggestedTaskStartMode }> = [];
	const saved: SuggestedTask[] = [];
	return { saved, started };
}

describe("the suggested-task card in AgentChat", () => {
	test("sits above the composer for the newest finished turn", () => {
		const callId = nextCallId();
		const container = mount({
			messages: suggestionTurn(callId),
			taskSuggestions: { onStart: () => undefined },
		});
		const shown = card(container);
		expect(shown?.getAttribute("data-suggested-task")).toBe(callId);
		expect(shown?.textContent).toContain(TASK_FIELDS.title);
		expect(shown?.textContent).toContain(TASK_FIELDS.prompt);
		const composer = container.querySelector("textarea");
		expect(composer === null).toBe(false);
		// DOCUMENT_POSITION_FOLLOWING: the composer comes after the card.
		expect(
			(shown?.compareDocumentPosition(composer as Node) ?? 0) &
				Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});

	test("is absent when the host supplies no task actions", () => {
		const container = mount({ messages: suggestionTurn(nextCallId()) });
		expect(cardId(container)).toBeNull();
		expect(has(container, '[aria-label="Suggested task"]')).toBe(false);
		// The transcript still keeps its compact record of the call.
		expect(container.textContent).toContain(TASK_FIELDS.title);
	});

	test("waits for the turn to finish", () => {
		const container = mount({
			messages: suggestionTurn(nextCallId()),
			status: "streaming",
			taskSuggestions: { onStart: () => undefined },
		});
		expect(cardId(container)).toBeNull();
		renderInto({
			messages: suggestionTurn(nextCallId()),
			status: "submitted",
			taskSuggestions: { onStart: () => undefined },
		});
		expect(cardId(container)).toBeNull();
	});

	test("appears once a streaming turn settles", () => {
		const callId = nextCallId();
		const taskSuggestions = { onStart: () => undefined };
		const container = mount({
			messages: suggestionTurn(callId),
			status: "streaming",
			taskSuggestions,
		});
		expect(cardId(container)).toBeNull();
		renderInto({
			messages: suggestionTurn(callId),
			status: "ready",
			taskSuggestions,
		});
		expect(cardId(container)).toBe(callId);
	});

	test("is hidden behind a failed request", () => {
		const container = mount({
			error: new Error("Provider unavailable"),
			messages: suggestionTurn(nextCallId()),
			status: "error",
			taskSuggestions: { onStart: () => undefined },
		});
		expect(cardId(container)).toBeNull();
		expect(container.textContent).toContain("Provider unavailable");
	});

	test("goes away once the conversation moves on", () => {
		const callId = nextCallId();
		const taskSuggestions = { onStart: () => undefined };
		const container = mount({
			messages: suggestionTurn(callId),
			taskSuggestions,
		});
		expect(cardId(container)).not.toBeNull();
		renderInto({
			messages: [
				...suggestionTurn(callId),
				{
					id: "u2",
					parts: [{ text: "Not now, thanks", type: "text" }],
					role: "user",
				} as UIMessage,
			],
			taskSuggestions,
		});
		expect(cardId(container)).toBeNull();
	});

	test("Dismiss closes the card and keeps it closed after a remount", () => {
		const callId = nextCallId();
		const messages = suggestionTurn(callId);
		const taskSuggestions = { onStart: () => undefined };
		const container = mount({ messages, taskSuggestions });
		act(() => button("Dismiss suggested task", container).click());
		expect(cardId(container)).toBeNull();
		// Only the actionable card closes; the transcript keeps its record.
		expect(container.textContent).toContain(TASK_FIELDS.title);
		// Switching tabs unmounts the chat; coming back must not resurrect it.
		act(() => root?.unmount());
		host?.remove();
		const again = mount({ messages, taskSuggestions });
		expect(cardId(again)).toBeNull();
		// A later suggestion is a different call and is not suppressed.
		const nextId = nextCallId();
		renderInto({ messages: suggestionTurn(nextId), taskSuggestions });
		expect(cardId(again)).toBe(nextId);
	});

	test("Start hands the host the task and closes the card", () => {
		const { started } = recorder();
		const callId = nextCallId();
		const container = mount({
			messages: suggestionTurn(callId),
			taskSuggestions: {
				onStart: (task, mode) => started.push({ id: task.id, mode }),
			},
		});
		act(() => button("Start", container).click());
		expect(started).toEqual([{ id: callId, mode: "chat" }]);
		expect(cardId(container)).toBeNull();
	});

	test("reports the full task the card showed", () => {
		const reported: SuggestedTask[] = [];
		const callId = nextCallId();
		const container = mount({
			messages: suggestionTurn(callId),
			taskSuggestions: { onStart: (task) => reported.push(task) },
		});
		act(() => button("Start", container).click());
		expect(reported).toEqual([{ id: callId, ...TASK_FIELDS }]);
	});

	test("offers a worktree start only when the host allows it", () => {
		const without = mount({
			messages: suggestionTurn(nextCallId()),
			taskSuggestions: { onStart: () => undefined },
		});
		expect(has(without, '[aria-label="More ways to start"]')).toBe(false);
		act(() => root?.unmount());
		host?.remove();
		const withWorktree = mount({
			messages: suggestionTurn(nextCallId()),
			taskSuggestions: { canStartInWorktree: true, onStart: () => undefined },
		});
		expect(has(withWorktree, '[aria-label="More ways to start"]')).toBe(true);
	});

	test("Start in a worktree and Start in a new chat report their own mode", async () => {
		const { started } = recorder();
		const callId = nextCallId();
		const container = mount({
			messages: suggestionTurn(callId),
			taskSuggestions: {
				canStartInWorktree: true,
				onStart: (task, mode) => started.push({ id: task.id, mode }),
			},
		});
		await act(async () => button("More ways to start", container).click());
		const items = [
			...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
		];
		expect(items.map((item) => item.textContent?.trim())).toEqual([
			"Start in a new chat",
			"Start in a worktree",
		]);
		await act(async () => items[1]?.click());
		expect(started).toEqual([{ id: callId, mode: "worktree" }]);
		expect(cardId(container)).toBeNull();
	});

	test("Save to Drafts is offered only when the host can save", () => {
		const without = mount({
			messages: suggestionTurn(nextCallId()),
			taskSuggestions: { onStart: () => undefined },
		});
		expect(without.textContent).not.toContain("Save to Drafts");
		act(() => root?.unmount());
		host?.remove();
		const withSave = mount({
			messages: suggestionTurn(nextCallId()),
			taskSuggestions: {
				onSaveDraft: () => Promise.resolve(),
				onStart: () => undefined,
			},
		});
		expect(withSave.textContent).toContain("Save to Drafts");
	});

	test("Save to Drafts saves the task once, then closes the card", async () => {
		const { saved } = recorder();
		let finishSave: () => void = () => undefined;
		const callId = nextCallId();
		const container = mount({
			messages: suggestionTurn(callId),
			taskSuggestions: {
				onSaveDraft: (task) => {
					saved.push(task);
					return new Promise<void>((resolve) => {
						finishSave = resolve;
					});
				},
				onStart: () => undefined,
			},
		});
		await act(async () => button("Save to Drafts", container).click());
		// While the save is in flight the card stays, says so, and cannot save twice.
		const saving = button("Saving…", container) as HTMLButtonElement;
		expect(saving.disabled).toBe(true);
		await act(async () => saving.click());
		expect(cardId(container)).not.toBeNull();
		expect(saved).toEqual([{ id: callId, ...TASK_FIELDS }]);
		await act(async () => finishSave());
		expect(cardId(container)).toBeNull();
		expect(saved).toHaveLength(1);
	});

	test("a failed save keeps the card, says so, and can be retried", async () => {
		let attempts = 0;
		const container = mount({
			messages: suggestionTurn(nextCallId()),
			taskSuggestions: {
				onSaveDraft: () => {
					attempts += 1;
					return attempts === 1
						? Promise.reject(new Error("Drafts unavailable"))
						: Promise.resolve();
				},
				onStart: () => undefined,
			},
		});
		await act(async () => button("Save to Drafts", container).click());
		expect(cardId(container)).not.toBeNull();
		expect(container.querySelector('[role="alert"]')?.textContent).toBe(
			"Could not save draft"
		);
		const retry = button("Save to Drafts", container) as HTMLButtonElement;
		expect(retry.disabled).toBe(false);
		await act(async () => retry.click());
		expect(attempts).toBe(2);
		expect(cardId(container)).toBeNull();
	});
});
