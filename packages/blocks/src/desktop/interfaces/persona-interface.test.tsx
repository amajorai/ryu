// Must stay first: happy-dom has to exist before React DOM and Base UI load.
import "./persona-test-dom.ts";
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
import { PersonaActivity } from "./persona-activity.tsx";
import { personaNextActions } from "./persona-context.tsx";
import { PersonaInterface } from "./persona-interface.tsx";
import {
	defaultPersonaId,
	descriptionTopics,
	isThreadAnswered,
	mainThread,
	personaActivity,
	personaForThread,
	personaGoals,
	personaIdeas,
	personaStatus,
	personaThreads,
	projectFeed,
	sideChats,
	untilLabel,
} from "./persona-model.ts";
import { PERSONA_DOM_FLAG } from "./persona-test-dom.ts";

const MINUTE = 60_000;
const BASE = Date.parse("2026-10-12T12:00:00Z");
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
			description: "Deploys, alerts and on-call runbooks",
			id: "agent-delta",
			name: "Delta",
			status: "working",
		},
		{
			avatarUrl: null,
			description: "Security reviews",
			id: "agent-cipher",
			name: "Cipher",
			status: "idle",
		},
		{
			avatarUrl: null,
			description: "",
			id: "agent-quiet",
			name: "Quiet",
			status: "idle",
		},
	],
	events: [
		{
			agentId: "agent-delta",
			end: ago(170),
			id: "run-backup",
			kind: "past",
			label: "Daily at 6 AM",
			outcome: "success",
			start: ago(180),
			title: "Backup check",
		},
		{
			agentId: "agent-cipher",
			id: "run-audit",
			kind: "upcoming",
			label: "Mondays",
			start: new Date(BASE + 90 * MINUTE).toISOString(),
			title: "Dependency audit",
		},
	],
	groups: [
		{
			id: "project-site",
			kind: "project",
			memberAgentIds: ["agent-delta"],
			name: "Website",
		},
		{
			id: "team-ops",
			kind: "team",
			memberAgentIds: ["agent-cipher"],
			name: "Ops",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-delta"],
			id: "thread-deploy",
			lastMessage: "Canary at 25%.",
			messageCount: 12,
			projectId: "project-site",
			running: true,
			title: "Roll out 2.4",
			updatedAt: ago(3),
		}),
		thread({
			agentIds: ["agent-delta"],
			id: "thread-runbook",
			lastMessage: "Runbook updated.",
			projectId: "project-site",
			title: "Update the runbook",
			updatedAt: ago(60 * 30),
		}),
		thread({
			agentIds: ["agent-delta", "agent-cipher"],
			id: "thread-shared",
			lastMessage: "Can you check the alerts?",
			lastMessageRole: "user",
			teamId: "team-ops",
			title: "Alert review",
			updatedAt: ago(20),
		}),
		thread({
			agentIds: ["agent-cipher"],
			id: "thread-audit",
			lastMessage: "Two advisories.",
			runState: "failed",
			title: "Audit lockfile",
			updatedAt: ago(90),
		}),
		thread({
			id: "thread-orphan",
			lastMessage: "Office closed Friday.",
			lastMessageRole: "user",
			title: "Office",
			updatedAt: ago(600),
		}),
	],
	version: 1,
};

const registeredDom = Reflect.get(globalThis, PERSONA_DOM_FLAG) === true;
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
		root,
	};
}

async function click(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a clickable element");
	}
	await act(async () => element.click());
}

function buttonNamed(container: HTMLElement, name: string) {
	return Array.from(container.querySelectorAll("button")).find(
		(button) =>
			button.getAttribute("aria-label") === name ||
			button.textContent?.trim() === name
	);
}

async function typeInto(field: HTMLTextAreaElement | null, value: string) {
	if (!field) {
		throw new Error("Expected a text field");
	}
	const setter = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		field.focus();
		setter?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		// React picks its change events when it loads; under happy-dom that
		// can be the keyup fallback, so send both.
		field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
}

function recordingPort() {
	const calls: string[] = [];
	const port: InterfacePort = {
		closeThread: () => calls.push("close"),
		openThread: (id) => calls.push(`open:${id}`),
		startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
	};
	return { calls, port };
}

describe("persona model", () => {
	test("suggests next steps from the persona's threads, never the open one", () => {
		const threads = [
			thread({ id: "waiting", lastMessageRole: "user" }),
			thread({ id: "running", running: true }),
			thread({ id: "reply", lastMessageRole: "assistant" }),
		];
		expect(
			personaNextActions(threads, null).map((action) => action.threadId)
		).toEqual(["reply", "running"]);
		const withoutReply = personaNextActions(threads, "reply");
		expect(withoutReply.map((action) => action.threadId)).toEqual([
			"running",
			null,
		]);
		expect(withoutReply.at(-1)?.label).toBe(
			"Start a side chat on something new"
		);
	});

	test("picks the agent behind the latest conversation", () => {
		expect(defaultPersonaId(SNAPSHOT)).toBe("agent-delta");
		expect(defaultPersonaId({ ...SNAPSHOT, threads: [] })).toBe("agent-delta");
		expect(defaultPersonaId({ ...SNAPSHOT, agents: [], threads: [] })).toBe(
			null
		);
	});

	test("splits the main chat from side chats", () => {
		const threads = personaThreads(SNAPSHOT, "agent-delta");
		const main = mainThread(threads, "agent-delta");
		expect(main?.id).toBe("thread-deploy");
		expect(sideChats(threads, main).map((item) => item.id)).toEqual([
			"thread-shared",
			"thread-runbook",
		]);
	});

	test("the main chat stays put when a newer one-to-one chat arrives", () => {
		const fresh = thread({
			agentIds: ["agent-delta"],
			id: "thread-fresh",
			lastMessage: "On it.",
			messageCount: 2,
			title: "Check the alert thresholds",
			updatedAt: ago(0),
		});
		const withFresh = { ...SNAPSHOT, threads: [fresh, ...SNAPSHOT.threads] };
		const threads = personaThreads(withFresh, "agent-delta");
		const main = mainThread(threads, "agent-delta");
		expect(main?.id).toBe("thread-deploy");
		expect(sideChats(threads, main).map((item) => item.id)).toContain(
			"thread-fresh"
		);
		// A tie on messages keeps the older chat, not the newer one.
		const tied = mainThread(
			[{ ...fresh, messageCount: 12 }, ...threads],
			"agent-delta"
		);
		expect(tied?.id).toBe("thread-deploy");
		// Pinning a chat makes it the main chat.
		const pinned = mainThread(
			[{ ...fresh, pinned: true }, ...threads],
			"agent-delta"
		);
		expect(pinned?.id).toBe("thread-fresh");
	});

	test("resolves the persona for an open thread", () => {
		const shared = SNAPSHOT.threads.find((item) => item.id === "thread-shared");
		expect(personaForThread(SNAPSHOT, shared, "agent-cipher")).toBe(
			"agent-cipher"
		);
		const audit = SNAPSHOT.threads.find((item) => item.id === "thread-audit");
		expect(personaForThread(SNAPSHOT, audit, "agent-delta")).toBe(
			"agent-cipher"
		);
		const orphan = SNAPSHOT.threads.find((item) => item.id === "thread-orphan");
		expect(personaForThread(SNAPSHOT, orphan, "agent-delta")).toBe(
			"agent-delta"
		);
	});

	test("status leads with live work and keeps totals", () => {
		const [delta, , quiet] = SNAPSHOT.agents;
		const status = personaStatus(
			delta,
			personaThreads(SNAPSHOT, "agent-delta")
		);
		expect(status.headline).toBe("Roll out 2.4 · Working");
		expect(status.label).toBe("Working");
		expect(status.status).toBe("working");
		expect(status.steps.map((item) => item.id)).toEqual([
			"thread-deploy",
			"thread-shared",
			"thread-runbook",
		]);
		expect(status.totals).toEqual({
			lastActiveAt: ago(3),
			messages: 16,
			threads: 3,
		});
		const idle = personaStatus(quiet, []);
		expect(idle.status).toBe("idle");
		expect(idle.headline).toBe("Free to chat");
	});

	test("feed groups the latest messages by day", () => {
		const feed = projectFeed(SNAPSHOT, null, BASE);
		expect(feed.flatMap((day) => day.threads).at(0)?.id).toBe("thread-deploy");
		expect(feed.flatMap((day) => day.threads)).toHaveLength(5);
		const mine = projectFeed(SNAPSHOT, "agent-cipher", BASE);
		expect(mine.flatMap((day) => day.threads.map((item) => item.id))).toEqual([
			"thread-shared",
			"thread-audit",
		]);
	});

	test("ideas come from thread state and the description", () => {
		const [delta] = SNAPSHOT.agents;
		const groups = personaIdeas(delta, personaThreads(SNAPSHOT, "agent-delta"));
		expect(groups.map((group) => group.key)).toEqual([
			"recent",
			"skills",
			"routine",
		]);
		expect(groups[0]?.ideas.map((idea) => idea.prompt)).toEqual([
			"Give me a short status on Roll out 2.4",
			"Add more detail to Alert review",
			"Follow up on Update the runbook",
		]);
		expect(groups[1]?.ideas[0]?.prompt).toBe(
			"What changed in deploys this week?"
		);
		expect(groups[2]?.ideas[0]?.prompt).toBe("Summarise this week");
		expect(descriptionTopics("Deploys, alerts and on-call runbooks")).toEqual([
			"deploys",
			"alerts",
			"on-call runbooks",
		]);
		// Actions and roles are not topics.
		expect(descriptionTopics("Digs through papers, docs and the web")).toEqual([
			"docs",
			"web",
		]);
		expect(descriptionTopics("Full-stack engineer")).toEqual([]);
		// A role-only description still gives ideas from the description.
		const engineer = personaIdeas(
			delta ? { ...delta, description: "Full-stack engineer" } : undefined,
			personaThreads(SNAPSHOT, "agent-delta")
		);
		expect(
			engineer.find((group) => group.key === "skills")?.ideas[0]?.prompt
		).toBe("What would you tackle next?");
		expect(personaIdeas(undefined, [])).toEqual([]);
	});

	test("goals count answered against open threads", () => {
		const goals = personaGoals(SNAPSHOT, "agent-delta");
		const site = goals.projects[0];
		expect(site?.group.id).toBe("project-site");
		expect([site?.answered, site?.open, site?.total]).toEqual([1, 1, 2]);
		expect(site?.includesPersona).toBeTrue();
		expect(goals.teams[0]?.includesPersona).toBeTrue();
		const runbook = SNAPSHOT.threads.find(
			(item) => item.id === "thread-runbook"
		);
		expect(runbook ? isThreadAnswered(runbook) : false).toBeTrue();
		const deploy = SNAPSHOT.threads.find((item) => item.id === "thread-deploy");
		expect(deploy ? isThreadAnswered(deploy) : true).toBeFalse();
	});

	test("a stopped run with no agent is not credited to the user", () => {
		const snapshot: InterfaceSnapshot = {
			...SNAPSHOT,
			threads: [
				thread({
					id: "thread-lone",
					runState: "failed",
					title: "Lone run",
					updatedAt: ago(5),
				}),
			],
		};
		const html = renderToStaticMarkup(
			<PersonaActivity
				activity={personaActivity(snapshot, BASE)}
				onOpen={() => undefined}
				snapshot={snapshot}
			/>
		);
		expect(html).toContain("Needs attention");
		expect(html).toContain("Run stopped</span> · No agent ·");
		const empty = { ...SNAPSHOT, threads: [] };
		expect(
			renderToStaticMarkup(
				<PersonaActivity
					activity={personaActivity(empty, BASE)}
					onOpen={() => undefined}
					snapshot={empty}
				/>
			)
		).toContain("No stopped runs.");
	});

	test("activity lists stopped runs, schedule and a dated log", () => {
		const activity = personaActivity(SNAPSHOT, BASE);
		expect(activity.stopped.map((item) => item.id)).toEqual(["thread-audit"]);
		expect(activity.upcoming.map((event) => event.id)).toEqual(["run-audit"]);
		const ids = activity.log.flatMap((day) =>
			day.entries.map((entry) => entry.id)
		);
		expect(ids.slice(0, 3)).toEqual([
			"thread:thread-deploy",
			"thread:thread-shared",
			"thread:thread-audit",
		]);
		expect(ids).toContain("run:run-backup");
		expect(untilLabel(new Date(BASE + 90 * MINUTE).toISOString(), BASE)).toBe(
			"in 2h"
		);
	});
});

describe("PersonaInterface", () => {
	test("renders loading and empty states", () => {
		const { port } = recordingPort();
		const empty = { ...SNAPSHOT, agents: [], groups: [], threads: [] };
		const loading = renderToStaticMarkup(
			<PersonaInterface
				activeThreadId={null}
				loading
				params={{}}
				port={port}
				snapshot={empty}
				threadView={null}
			/>
		);
		expect(loading).toContain('data-testid="interface-persona"');
		expect(loading).toContain('aria-busy="true"');
		const none = renderToStaticMarkup(
			<PersonaInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={empty}
				threadView={null}
			/>
		);
		expect(none).toContain("No persona yet");
	});

	test("shows the profile, status line and main chat preview", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			<PersonaInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(markup).toContain("Delta");
		expect(markup).toContain("Roll out 2.4");
		expect(markup).toContain("· Working");
		expect(markup).toContain("Main chat");
		expect(markup).toContain("Canary at 25%.");
		expect(markup).toContain("11 earlier messages");
		// The message bar opens the real chat; it is not a second composer.
		expect(markup).toContain("Open chat with Delta");
		expect(markup).not.toContain("<textarea");
	});

	test("frames the host thread view for the open thread", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			<PersonaInterface
				activeThreadId="thread-audit"
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={<div data-testid="host-thread-view">Host</div>}
			/>
		);
		expect(markup).toContain('data-testid="host-thread-view"');
		// The open thread decides the persona.
		expect(markup).toContain("Audit lockfile · Run stopped");
		expect(markup).toContain('aria-label="Close chat"');
		expect(markup).toContain('aria-keyshortcuts="Escape"');
	});

	test("Escape in the open thread closes it", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<PersonaInterface
				activeThreadId="thread-deploy"
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={<textarea aria-label="Host composer" />}
			/>
		);
		const field = view.container.querySelector("textarea");
		await act(async () => {
			field?.focus();
		});
		await act(async () => {
			field?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
			);
		});
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});

	test("side chats open, and a new one sends only what was typed", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<PersonaInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		await click(buttonNamed(view.container, "Open chat with Delta"));
		expect(calls).toEqual(["open:thread-deploy"]);
		await click(buttonNamed(view.container, "Update the runbook, Your turn"));
		expect(calls.at(-1)).toBe("open:thread-runbook");

		await click(buttonNamed(view.container, "New side chat"));
		expect(calls).toHaveLength(2);
		const field = view.container.querySelector("textarea");
		await typeInto(field, "Check the alert thresholds");
		await act(async () => {
			field?.form?.requestSubmit();
		});
		expect(calls.at(-1)).toBe(
			'start:{"agentId":"agent-delta","prompt":"Check the alert thresholds"}'
		);
		await view.dispose();
	});

	test("an idea fills the composer and is sent only on submit", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<PersonaInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		await click(buttonNamed(view.container, "Ideas"));
		await click(
			view.container.querySelector('[data-persona-idea="routine:week"]')
		);
		expect(calls).toEqual([]);
		const field = view.container.querySelector("textarea");
		expect(field?.value).toBe("Summarise this week");
		await act(async () => {
			field?.form?.requestSubmit();
		});
		expect(calls).toEqual([
			'start:{"agentId":"agent-delta","prompt":"Summarise this week"}',
		]);
		await view.dispose();
	});

	test("the header switcher opens a menu and selects a persona", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<PersonaInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const trigger = buttonNamed(view.container, "Switch persona");
		await click(trigger);
		const items = Array.from(
			document.querySelectorAll('[role="menuitemradio"]')
		);
		expect(items.map((item) => item.textContent?.trim())).toEqual([
			"Delta",
			"Cipher",
			"Quiet",
		]);
		expect(items[0]?.getAttribute("aria-checked")).toBe("true");
		await click(items[1]);
		expect(view.container.querySelector("h1")?.textContent).toBe("Cipher");
		expect(calls).toEqual([]);
		await view.dispose();
	});

	test("switching persona, goals and activity act through the port", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<PersonaInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const cipher = view.container.querySelector(
			'nav[aria-label="Persona"] button[aria-label^="Cipher"]'
		);
		await click(cipher);
		expect(view.container.querySelector("h1")?.textContent).toBe("Cipher");

		await click(buttonNamed(view.container, "Goals"));
		expect(view.container.textContent).toContain("1 of 2 answered · 1 open");
		await click(buttonNamed(view.container, "New chat in Ops"));
		expect(calls.at(-1)).toBe('start:{"teamId":"team-ops"}');

		await click(buttonNamed(view.container, "Activity, 1 needs attention"));
		expect(view.container.textContent).toContain("Needs attention");
		expect(view.container.textContent).not.toContain("Approvals");
		expect(view.container.textContent).toContain("Dependency audit");
		await click(buttonNamed(view.container, "Review Audit lockfile"));
		expect(calls.at(-1)).toBe("open:thread-audit");
		await view.dispose();
	});

	test("tabs move with arrow keys", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<PersonaInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const chat = view.container.querySelector('[data-persona-tab="chat"]');
		await act(async () => {
			chat?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })
			);
		});
		expect(
			view.container
				.querySelector('[data-persona-tab="feed"]')
				?.getAttribute("aria-selected")
		).toBe("true");
		expect(view.container.textContent).toContain("Canary at 25%.");
		await view.dispose();
	});
});
