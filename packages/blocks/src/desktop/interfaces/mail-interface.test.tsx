import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MailInterface } from "./mail-interface.tsx";
import {
	mailComposePrompt,
	mailFolderCounts,
	mailLabelUnread,
	mailListDate,
	mailLongDate,
	mailMatchesQuery,
	mailPageRange,
	mailSenders,
	mailStartInput,
	mailStatusChip,
	mailSubject,
	mailViewThreads,
} from "./mail-model.ts";

const MINUTE = 60_000;
const BASE = Date.parse("2026-10-12T15:00:00Z");
const ago = (minutes: number) =>
	new Date(BASE - minutes * MINUTE).toISOString();

function thread(
	input: Partial<InterfaceThread> & Pick<InterfaceThread, "id">
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
		title: input.id,
		updatedAt: ago(60),
		...input,
	};
}

const SNAPSHOT: InterfaceSnapshot = {
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
	],
	groups: [
		{
			id: "team-design",
			kind: "team",
			memberAgentIds: ["agent-ada", "agent-grace"],
			name: "Design Review",
		},
		{
			id: "project-site",
			kind: "project",
			memberAgentIds: ["agent-ada"],
			name: "Website",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			messageCount: 6,
			pinned: true,
			projectId: "project-site",
			title: "Release notes",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-question",
			lastMessage: "Can you shorten the intro?",
			lastMessageRole: "user",
			title: "Intro edits",
			updatedAt: ago(90),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			lastMessage: "Looking at the crash reports now.",
			running: true,
			title: "Crash triage",
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-ada", "agent-grace"],
			id: "thread-review",
			lastMessage: "Review done.",
			runState: "failed",
			teamId: "team-design",
			title: "Design review",
			updatedAt: ago(10),
		}),
	],
	version: 1,
};

const EMPTY: InterfaceSnapshot = { ...SNAPSHOT, threads: [] };

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
if (typeof Element.prototype.getAnimations !== "function") {
	Element.prototype.getAnimations = () => [];
}
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

async function mount(element: ReactElement) {
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
		async rerender(next: ReactElement) {
			await act(async () => root.render(next));
		},
	};
}

async function click(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a clickable element");
	}
	await act(async () => element.click());
}

/** A key pressed with nothing focused, the way Gmail's shortcuts arrive. */
async function pressOnPage(key: string, target: Element = document.body) {
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
}

/**
 * Sets a field's value through its native setter and fires `input` (and a
 * `keyup`, which React's polyfilled change tracking may watch instead).
 */
async function type(element: Element | null | undefined, value: string) {
	if (
		!(
			element instanceof HTMLInputElement ||
			element instanceof HTMLTextAreaElement
		)
	) {
		throw new Error("Expected a text field");
	}
	let proto: object | null = Object.getPrototypeOf(element);
	let setValue: ((this: Element, next: string) => void) | undefined;
	while (proto && !setValue) {
		setValue = Object.getOwnPropertyDescriptor(proto, "value")?.set;
		proto = Object.getPrototypeOf(proto);
	}
	await act(async () => {
		element.focus();
		setValue?.call(element, value);
		element.dispatchEvent(new Event("input", { bubbles: true }));
		element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
}

function rowIds(container: HTMLElement): string[] {
	return [...container.querySelectorAll("[data-testid^='mail-row-']")].map(
		(row) => row.getAttribute("data-testid")?.replace("mail-row-", "") ?? ""
	);
}

function navButton(container: HTMLElement, label: string) {
	return container.querySelector(`[data-nav-item='${label}']`);
}

function recordingPort() {
	const calls: string[] = [];
	const port: InterfacePort = {
		closeThread: () => calls.push("close"),
		openThread: (id) => calls.push(`open:${id}`),
		// Sorted keys, so assertions do not depend on property order.
		startThread: (input) =>
			calls.push(`start:${JSON.stringify(input, Object.keys(input).sort())}`),
	};
	return { calls, port };
}

function mail(
	props: Partial<Parameters<typeof MailInterface>[0]> & { port: InterfacePort }
) {
	return (
		<MailInterface
			activeThreadId={null}
			loading={false}
			params={{}}
			snapshot={SNAPSHOT}
			threadView={null}
			{...props}
		/>
	);
}

describe("mail model", () => {
	test("files threads into Gmail's folders by where they stand", () => {
		const ids = (id: "all" | "inbox" | "sent" | "starred" | "working") =>
			mailViewThreads(SNAPSHOT, { id, kind: "folder" }).map((item) => item.id);
		expect(ids("inbox")).toEqual(["thread-review", "thread-notes"]);
		expect(ids("starred")).toEqual(["thread-notes"]);
		expect(ids("working")).toEqual(["thread-triage"]);
		expect(ids("sent")).toEqual(["thread-question"]);
		expect(ids("all")).toEqual([
			"thread-triage",
			"thread-review",
			"thread-notes",
			"thread-question",
		]);
		expect(mailFolderCounts(SNAPSHOT)).toEqual({
			all: 4,
			inbox: 2,
			sent: 1,
			starred: 1,
			working: 1,
		});
	});

	test("labels are teams and projects, with unread counts", () => {
		expect(
			mailViewThreads(SNAPSHOT, { id: "team-design", kind: "label" }).map(
				(item) => item.id
			)
		).toEqual(["thread-review"]);
		expect([...mailLabelUnread(SNAPSHOT)]).toEqual([
			["project-site", 1],
			["team-design", 1],
		]);
	});

	test("search runs across all mail and matches every word", () => {
		const inbox = { id: "inbox", kind: "folder" } as const;
		expect(
			mailViewThreads(SNAPSHOT, inbox, "crash").map((item) => item.id)
		).toEqual(["thread-triage"]);
		const review = SNAPSHOT.threads[3] as InterfaceThread;
		expect(mailMatchesQuery(SNAPSHOT, review, "grace design")).toBe(true);
		expect(mailMatchesQuery(SNAPSHOT, review, "grace website")).toBe(false);
	});

	test("names senders the way Gmail does", () => {
		const [notes, question, , review] = SNAPSHOT.threads as InterfaceThread[];
		expect(mailSenders(SNAPSHOT, notes as InterfaceThread, "inbox")).toBe(
			"Ada"
		);
		expect(mailSenders(SNAPSHOT, question as InterfaceThread, "all")).toBe(
			"Ada, me"
		);
		expect(mailSenders(SNAPSHOT, question as InterfaceThread, "sent")).toBe(
			"To: Ada"
		);
		expect(mailSenders(SNAPSHOT, review as InterfaceThread, null)).toBe(
			"Ada, Grace"
		);
		expect(mailSenders(SNAPSHOT, thread({ id: "solo" }), "all")).toBe("me");
		expect(mailSubject(thread({ id: "blank", title: "  " }))).toBe(
			"(no subject)"
		);
	});

	test("only live and failed runs carry a status chip", () => {
		const [notes, , triage, review] = SNAPSHOT.threads as InterfaceThread[];
		expect(mailStatusChip(notes as InterfaceThread)).toBeNull();
		expect(mailStatusChip(triage as InterfaceThread)?.label).toBe("Working");
		expect(mailStatusChip(review as InterfaceThread)).toEqual({
			label: "Run failed",
			tone: "destructive",
		});
		expect(
			mailStatusChip(thread({ id: "stop", runState: "interrupted" }))?.label
		).toBe("Interrupted");
	});

	test("formats list and header dates like Gmail", () => {
		const now = BASE;
		expect(mailListDate(ago(30), now, "en-US")).toMatch(/\d:\d\d\s?[AP]M/);
		expect(mailListDate(ago(60 * 24 * 3), now, "en-US")).toBe("Oct 9");
		expect(
			mailListDate("2025-03-02T12:00:00Z", now, "en-US").endsWith("/25")
		).toBe(true);
		expect(mailLongDate(ago(18), now, "en-US")).toMatch(
			/^Oct 12, 2026, .+ \(18 minutes ago\)$/
		);
		expect(mailPageRange(10, 0)).toBe("1–10 of 10");
		expect(mailPageRange(120, 1)).toBe("51–100 of 120");
		expect(mailPageRange(0, 0)).toBe("0 of 0");
	});

	test("compose turns subject and body into one prompt, filed by label", () => {
		expect(mailComposePrompt(" Hello ", "")).toBe("Hello");
		expect(mailComposePrompt("Plan", "Draft it")).toBe("Plan\n\nDraft it");
		expect(
			mailStartInput(SNAPSHOT, {
				agentId: null,
				body: " ",
				labelId: null,
				subject: "",
			})
		).toBeNull();
		expect(
			mailStartInput(SNAPSHOT, {
				agentId: "agent-ada",
				body: "Draft it",
				labelId: "team-design",
				subject: "Plan",
			})
		).toEqual({
			agentId: "agent-ada",
			prompt: "Plan\n\nDraft it",
			teamId: "team-design",
		});
		expect(
			mailStartInput(SNAPSHOT, {
				agentId: "agent-ada",
				body: "",
				labelId: "project-site",
				subject: "Copy",
			})
		).toEqual({
			agentId: "agent-ada",
			projectId: "project-site",
			prompt: "Copy",
		});
	});
});

describe("mail interface", () => {
	test("renders Gmail's chrome and the inbox without a thread open", () => {
		const { port } = recordingPort();
		const html = renderToStaticMarkup(mail({ port }));
		expect(html).toContain('data-testid="interface-mail"');
		for (const label of ["Inbox", "Starred", "Working", "Sent", "All mail"]) {
			expect(html).toContain(`data-nav-item="${label}"`);
		}
		expect(html).toContain("Design Review");
		expect(html).toContain('data-testid="mail-row-thread-review"');
		expect(html).toContain('data-testid="mail-row-thread-notes"');
		expect(html).not.toContain('data-testid="mail-row-thread-triage"');
		expect(html).toContain("1–2 of 2");
		expect(html).not.toContain('data-testid="mail-reader"');
	});

	test("shows a skeleton while loading and plain empty states after", () => {
		const { port } = recordingPort();
		const loadingHtml = renderToStaticMarkup(
			mail({ loading: true, port, snapshot: EMPTY })
		);
		expect(loadingHtml).toContain('data-testid="mail-skeleton"');
		expect(loadingHtml).toContain('aria-busy="true"');
		const emptyHtml = renderToStaticMarkup(mail({ port, snapshot: EMPTY }));
		expect(emptyHtml).toContain("No conversations yet.");
		expect(emptyHtml).toContain("0 of 0");
	});

	test("previews the cursor row at rest on a wide window", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(mail({ port }));
		const preview = view.container.querySelector(
			"[data-testid='mail-preview']"
		);
		expect(preview?.getAttribute("aria-label")).toBe("Preview: Design review");
		expect(view.container.querySelector("[data-testid='mail-reader']")).toBe(
			null
		);
		const open = [...(preview?.querySelectorAll("button") ?? [])].find(
			(button) => button.textContent?.includes("Open conversation")
		);
		await click(open ?? null);
		expect(calls).toEqual(["open:thread-review"]);
		await view.dispose();
	});

	test("opens a row through the port and shows the host's view", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(mail({ port }));
		await click(view.container.querySelector("[data-mail-row='thread-notes']"));
		expect(calls).toEqual(["open:thread-notes"]);
		await view.rerender(
			mail({
				activeThreadId: "thread-notes",
				port,
				threadView: <p data-testid="host-chat">host chat</p>,
			})
		);
		const reader = view.container.querySelector("[data-testid='mail-reader']");
		expect(reader?.textContent).toContain("Release notes");
		expect(reader?.textContent).toContain("to me");
		expect(
			reader?.querySelector(
				"[data-testid='mail-thread-view'] [data-testid='host-chat']"
			)
		).not.toBeNull();
		expect(
			view.container.querySelector("[data-testid='mail-reader-position']")
				?.textContent
		).toBe("2 of 2");
		// Exactly one copy of the host's chat: Mail never builds its own.
		expect(
			view.container.querySelectorAll("[data-testid='host-chat']")
		).toHaveLength(1);
		await pressOnPage("k");
		expect(calls.at(-1)).toBe("open:thread-review");
		await pressOnPage("u");
		expect(calls.at(-1)).toBe("close");
		await view.dispose();
	});

	test("j/k move the cursor, o opens it, x selects it", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(mail({ port }));
		await pressOnPage("j");
		await pressOnPage("j");
		const second = view.container.querySelector(
			"[data-mail-row='thread-notes']"
		);
		expect(document.activeElement).toBe(second);
		await pressOnPage("k");
		await pressOnPage("x");
		expect(
			view.container.querySelector("[data-testid='mail-selected-count']")
				?.textContent
		).toBe("1 selected");
		await pressOnPage("o");
		expect(calls).toEqual(["open:thread-review"]);
		await view.dispose();
	});

	test("folders and labels switch the list", async () => {
		const { port } = recordingPort();
		const view = await mount(mail({ port }));
		await click(navButton(view.container, "All mail"));
		expect(rowIds(view.container)).toEqual([
			"thread-triage",
			"thread-review",
			"thread-notes",
			"thread-question",
		]);
		expect(
			view.container.querySelector("[data-mail-row='thread-question']")
				?.textContent
		).toContain("Ada, me");
		await click(navButton(view.container, "Website"));
		expect(rowIds(view.container)).toEqual(["thread-notes"]);
		await click(navButton(view.container, "Working"));
		expect(rowIds(view.container)).toEqual(["thread-triage"]);
		await click(navButton(view.container, "Starred"));
		expect(rowIds(view.container)).toEqual(["thread-notes"]);
		await view.dispose();
	});

	test("search narrows all mail and keeps keys inside the field", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(mail({ port }));
		await pressOnPage("/");
		const search = view.container.querySelector("[data-testid='mail-search']");
		expect(document.activeElement).toBe(search);
		await type(search, "crash");
		expect(rowIds(view.container)).toEqual(["thread-triage"]);
		// Typing "c" in the search box must not open Compose.
		await pressOnPage("c", search as Element);
		expect(view.container.querySelector("[data-testid='mail-compose']")).toBe(
			null
		);
		await type(search, "nothing like this");
		expect(
			view.container.querySelector("[data-testid='mail-empty']")?.textContent
		).toContain("No conversations matched your search.");
		expect(calls).toEqual([]);
		await view.dispose();
	});

	test("compose sends subject and body to the chosen agent", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(mail({ port }));
		await pressOnPage("c");
		const compose = view.container.querySelector(
			"[data-testid='mail-compose']"
		);
		expect(compose).not.toBeNull();
		const send = () =>
			[...(compose?.querySelectorAll("button") ?? [])].find(
				(button) => button.textContent === "Send"
			);
		await type(compose?.querySelector("[aria-label='Subject']"), "Launch");
		// Without a recipient there is nobody to send to yet.
		expect(send()?.disabled).toBe(true);
		const to = compose?.querySelector("[role='combobox']");
		await type(to, "gra");
		const option = compose?.querySelector("[role='option']");
		expect(option?.textContent).toContain("Grace");
		await act(async () => {
			option?.dispatchEvent(
				new MouseEvent("mousedown", { bubbles: true, cancelable: true })
			);
		});
		expect(
			compose?.querySelector("[data-testid='mail-compose-recipient']")
				?.textContent
		).toContain("Grace");
		await type(
			compose?.querySelector("[aria-label='Message body']"),
			"Draft the post"
		);
		expect(send()?.disabled).toBe(false);
		await click(send());
		expect(calls).toEqual([
			`start:${JSON.stringify({ agentId: "agent-grace", prompt: "Launch\n\nDraft the post" })}`,
		]);
		expect(view.container.querySelector("[data-testid='mail-compose']")).toBe(
			null
		);
		await view.dispose();
	});

	test("compose from a label files the new thread under it", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(mail({ port }));
		await click(navButton(view.container, "Design Review"));
		await click(
			view.container.querySelector("[data-testid='mail-compose-button']")
		);
		const compose = view.container.querySelector(
			"[data-testid='mail-compose']"
		);
		expect(
			compose?.querySelector("[data-testid='mail-compose-label']")?.textContent
		).toContain("Design Review");
		await type(compose?.querySelector("[role='combobox']"), "ada");
		const field = compose?.querySelector("[role='combobox']");
		await pressOnPage("Enter", field as Element);
		await type(compose?.querySelector("[aria-label='Subject']"), "Review");
		await act(async () => {
			compose
				?.querySelector("form")
				?.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true })
				);
		});
		expect(calls).toEqual([
			`start:${JSON.stringify({ agentId: "agent-ada", prompt: "Review", teamId: "team-design" })}`,
		]);
		await view.dispose();
	});

	test("select all toggles every row on the page", async () => {
		const { port } = recordingPort();
		const view = await mount(mail({ port }));
		await click(view.container.querySelector("[aria-label='Select all']"));
		expect(
			view.container.querySelector("[data-testid='mail-selected-count']")
				?.textContent
		).toBe("2 selected");
		await click(view.container.querySelector("[aria-label='Deselect all']"));
		expect(
			view.container.querySelector("[data-testid='mail-selected-count']")
		).toBeNull();
		await view.dispose();
	});
});
