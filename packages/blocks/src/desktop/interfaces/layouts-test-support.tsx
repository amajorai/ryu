// Shared fixture and DOM helpers for the layout interface tests
// (layouts-*.test.tsx). The fixture covers each thread status, a team, a
// project and an unassigned thread; the helpers mount with createRoot under
// happy-dom so clicks and keys run real React state and handlers.

import { afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	INTERFACE_PROTOCOL_VERSION,
	type InterfacePort,
	type InterfaceSnapshot,
	type InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

export const MINUTE = 60_000;
export const NOW = Date.now();
export const START_OF_TODAY = new Date(NOW).setHours(0, 0, 0, 0);

/**
 * A time `minutes` ago that never crosses midnight, so "today" threads stay
 * on today's timeline whenever the suite runs. Ordering is preserved: fewer
 * minutes is always newer.
 */
export function todayAgo(minutes: number): string {
	return new Date(
		Math.max(NOW - minutes * MINUTE, START_OF_TODAY + (1000 - minutes) * 1000)
	).toISOString();
}

/** Noon, `days` calendar days ago, in local time. */
export function daysAgoAtNoon(days: number): string {
	const date = new Date(NOW);
	date.setDate(date.getDate() - days);
	date.setHours(12, 0, 0, 0);
	return date.toISOString();
}

export function thread(
	input: Partial<InterfaceThread> & Pick<InterfaceThread, "id" | "title">
): InterfaceThread {
	return {
		agentIds: [],
		lastMessage: null,
		lastMessageRole: "assistant",
		messageCount: 2,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		updatedAt: todayAgo(60),
		...input,
	};
}

export const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "Writes the release notes",
			id: "agent-ada",
			name: "Ada",
			status: "idle",
		},
		{
			avatarUrl: null,
			description: "Triages bugs",
			id: "agent-grace",
			name: "Grace",
			status: "working",
		},
		{
			avatarUrl: null,
			description: "Audits dependencies",
			id: "agent-linus",
			name: "Linus",
			status: "idle",
		},
	],
	groups: [
		{
			id: "team-design",
			kind: "team",
			memberAgentIds: ["agent-ada", "agent-grace"],
			name: "Design Review",
		},
		{
			id: "project-docs",
			kind: "project",
			memberAgentIds: ["agent-ada", "agent-linus"],
			name: "Docs Site",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			lastMessage: "Looking at the crash reports now.",
			running: true,
			title: "Crash triage",
			updatedAt: todayAgo(5),
		}),
		thread({
			agentIds: ["agent-linus"],
			id: "thread-audit",
			lastMessage: "Two advisories need a patch release.",
			runState: "failed",
			title: "Audit dependencies",
			updatedAt: todayAgo(30),
		}),
		thread({
			agentIds: ["agent-ada", "agent-grace"],
			id: "thread-sync",
			lastMessage: "Agenda is posted for the design sync.",
			messageCount: 12,
			pinned: true,
			teamId: "team-design",
			title: "Weekly design sync",
			updatedAt: todayAgo(60),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			projectId: "project-docs",
			title: "Release notes",
			updatedAt: todayAgo(120),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-intro",
			lastMessage: "Can you shorten the intro?",
			lastMessageRole: "user",
			title: "Intro edits",
			updatedAt: daysAgoAtNoon(1),
		}),
		thread({
			id: "thread-office",
			lastMessageRole: null,
			messageCount: 0,
			title: "Office closed Friday",
			updatedAt: daysAgoAtNoon(3),
		}),
	],
	version: INTERFACE_PROTOCOL_VERSION,
};

export const EMPTY: InterfaceSnapshot = {
	agents: [],
	groups: [],
	threads: [],
	version: INTERFACE_PROTOCOL_VERSION,
};

export const THREAD_TITLES = SNAPSHOT.threads.map((item) => item.title);

export const HOST_VIEW = (
	<div data-testid="host-thread-view">
		Host chat surface for the open thread
	</div>
);

// ---------------------------------------------------------------------------
// DOM + helpers
// ---------------------------------------------------------------------------

/**
 * Register happy-dom for one test file and remove it after that file. Bun can
 * run several test files in one process, so each file registers its own DOM.
 */
export function useLayoutDom(): void {
	const registeredDom = globalThis.document === undefined;
	if (registeredDom) {
		GlobalRegistrator.register();
	}
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	// Base UI's ScrollArea waits on animations, which happy-dom does not model.
	if (typeof Element.prototype.getAnimations !== "function") {
		Element.prototype.getAnimations = () => [];
	}
	afterAll(async () => {
		if (registeredDom) {
			await GlobalRegistrator.unregister();
		}
	});
}

export interface PortCalls {
	calls: string[];
	port: InterfacePort;
}

/** A port that records every call as `open:<id>`, `start:<json>`, `close`. */
export function recordingPort(): PortCalls {
	const calls: string[] = [];
	return {
		calls,
		port: {
			closeThread: () => calls.push("close"),
			openThread: (id) => calls.push(`open:${id}`),
			startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
		},
	};
}

export interface CommonProps {
	activeThreadId: string | null;
	loading: boolean;
	port: InterfacePort;
	snapshot: InterfaceSnapshot;
	threadView: ReactNode | null;
}

export function props(overrides: Partial<CommonProps> = {}): CommonProps {
	return {
		activeThreadId: null,
		loading: false,
		port: recordingPort().port,
		snapshot: SNAPSHOT,
		threadView: null,
		...overrides,
	};
}

/** Props with `threadId` open and the host's view passed in. */
export function openProps(threadId: string, port?: InterfacePort): CommonProps {
	return props({
		activeThreadId: threadId,
		port: port ?? recordingPort().port,
		threadView: HOST_VIEW,
	});
}

export async function mount(element: ReactElement) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(element));
	return {
		container,
		async dispose() {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

export async function click(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a clickable element");
	}
	await act(async () => element.click());
}

export async function press(element: Element | null | undefined, key: string) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected an element to send keys to");
	}
	await act(async () => {
		element.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
}

/**
 * Type into a controlled input the way React's onChange observes it. React
 * may have been evaluated before the DOM was registered, in which case it
 * watches the focused field's keyup instead of `input`, so send both.
 */
export async function typeInto(
	input: Element | null | undefined,
	value: string
) {
	if (!(input instanceof HTMLInputElement)) {
		throw new Error("Expected a text input");
	}
	const setValue = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		input.focus();
		setValue?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
}

export async function submit(form: Element | null | undefined) {
	if (!(form instanceof HTMLFormElement)) {
		throw new Error("Expected a form");
	}
	await act(async () => {
		form.dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true })
		);
	});
}

/** The first button whose accessible name or text matches `name`. */
export function button(
	scope: ParentNode | null | undefined,
	name: string | RegExp
): HTMLButtonElement | undefined {
	const matches = (value: string | null | undefined) =>
		typeof name === "string" ? value?.trim() === name : name.test(value ?? "");
	return [...(scope?.querySelectorAll("button") ?? [])].find(
		(candidate) =>
			matches(candidate.getAttribute("aria-label")) ||
			matches(candidate.textContent)
	);
}

export function headings(container: ParentNode, selector = "h2"): string[] {
	return [...container.querySelectorAll(selector)].map(
		(heading) => heading.textContent?.trim() ?? ""
	);
}

/** Fixture thread titles that `html` does not mention. */
export function missingTitles(html: string): string[] {
	return THREAD_TITLES.filter((title) => !html.includes(title));
}
