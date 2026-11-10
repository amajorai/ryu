// Cross-layout contract tests for the eight layout interfaces — Board, Inbox,
// Graph, Timeline, Messenger, Terminal, Arena and Desk. Every renderer gets
// the same small fixture that covers each thread status (working, needs
// attention, your turn, waiting on the agent, not started), a team, a
// project and an unassigned thread. Each layout is checked for its key
// content, loading and empty states, the host's thread view, and at least
// one real interaction that reaches the port.
//
// Static markup (react-dom/server) covers what a renderer prints; happy-dom
// with createRoot covers interactions, so clicks and keys run real React
// state and real handlers.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ArenaInterface } from "./arena-interface.tsx";
import { DeskInterface } from "./desk-interface.tsx";
import {
	button,
	click,
	EMPTY,
	mount,
	openProps,
	press,
	props,
	recordingPort,
	SNAPSHOT,
	useLayoutDom,
} from "./layouts-test-support.tsx";

useLayoutDom();

// ---------------------------------------------------------------------------
// Arena
// ---------------------------------------------------------------------------

describe("Arena layout", () => {
	test("puts a card on the wall for every agent", () => {
		const html = renderToStaticMarkup(
			<ArenaInterface {...props()} params={{}} />
		);
		expect(html).toContain('data-testid="interface-arena"');
		expect(html).toContain('aria-label="All agents"');
		for (const name of ["Ada", "Grace", "Linus"]) {
			expect(html).toContain(`aria-label="Message ${name}"`);
		}
		// The thread with no agent is listed apart from the agent cards.
		expect(html).toContain("Office closed Friday");
	});

	test("shows loading and empty states", () => {
		const loading = renderToStaticMarkup(
			<ArenaInterface
				{...props({ loading: true, snapshot: EMPTY })}
				params={{}}
			/>
		);
		expect(loading).toContain('aria-busy="true"');
		expect(loading).not.toContain("No agents on the wall yet");
		const empty = renderToStaticMarkup(
			<ArenaInterface {...props({ snapshot: EMPTY })} params={{}} />
		);
		expect(empty).toContain("No agents on the wall yet");
	});

	test("shows the host thread view in its panel", () => {
		const html = renderToStaticMarkup(
			<ArenaInterface {...openProps("thread-audit")} params={{}} />
		);
		expect(html).toContain('data-testid="arena-thread-panel"');
		expect(html).toContain('data-testid="host-thread-view"');
	});

	test("filter chips narrow the wall and Message starts a thread", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<ArenaInterface {...props({ port })} params={{}} />
		);
		const cards = () =>
			[...view.container.querySelectorAll("article h2, article h3")].map(
				(heading) => heading.textContent?.trim()
			);
		const messageButtons = () =>
			[...view.container.querySelectorAll("button")]
				.map((candidate) => candidate.getAttribute("aria-label") ?? "")
				.filter((label) => label.startsWith("Message "));
		expect(messageButtons()).toHaveLength(3);

		await click(button(view.container, /^Working \(/));
		expect(
			view.container.querySelector("ul[aria-label='Working agents']")
		).not.toBeNull();
		expect(messageButtons()).toEqual(["Message Grace"]);

		await click(button(view.container, /^Idle \(/));
		expect(messageButtons()).not.toContain("Message Grace");

		await click(button(view.container, /^All \(/));
		expect(messageButtons()).toHaveLength(3);
		expect(cards().length).toBeGreaterThan(0);

		await click(button(view.container, "Message Linus"));
		expect(calls).toEqual(['start:{"agentId":"agent-linus"}']);
		await view.dispose();
	});
});

// ---------------------------------------------------------------------------
// Desk
// ---------------------------------------------------------------------------

describe("Desk layout", () => {
	test("renders the views rail and the conversation list", () => {
		const html = renderToStaticMarkup(
			<DeskInterface {...props()} params={{}} />
		);
		expect(html).toContain('data-testid="interface-desk"');
		expect(html).toContain('aria-label="Desk views"');
		for (const view of ["needs-you", "working", "all"]) {
			expect(html).toContain(`data-testid="desk-view-${view}"`);
		}
		for (const agent of SNAPSHOT.agents) {
			expect(html).toContain(`data-testid="desk-view-agent:${agent.id}"`);
		}
		expect(html).toContain('data-testid="desk-no-selection"');
	});

	test("shows loading and empty states", () => {
		const loading = renderToStaticMarkup(
			<DeskInterface
				{...props({ loading: true, snapshot: EMPTY })}
				params={{}}
			/>
		);
		expect(loading).toContain('aria-busy="true"');
		const empty = renderToStaticMarkup(
			<DeskInterface {...props({ snapshot: EMPTY })} params={{}} />
		);
		expect(empty).toContain("No conversations yet");
	});

	test("shows the host thread view in the conversation pane", () => {
		const html = renderToStaticMarkup(
			<DeskInterface {...openProps("thread-sync")} params={{}} />
		);
		expect(html).toContain('data-testid="host-thread-view"');
		expect(html).toContain('aria-label="Conversation: Weekly design sync"');
	});

	test("views filter the list and Enter opens the focused row", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<DeskInterface {...props({ port })} params={{}} />
		);
		const rows = () =>
			[...view.container.querySelectorAll("[data-testid^='desk-row-']")].map(
				(row) => row.getAttribute("data-testid")?.replace("desk-row-", "")
			);
		await click(view.container.querySelector("[data-testid='desk-view-all']"));
		expect(rows()).toHaveLength(SNAPSHOT.threads.length);

		await click(
			view.container.querySelector("[data-testid='desk-view-working']")
		);
		expect(rows()).toEqual(["thread-triage"]);

		await click(
			view.container.querySelector(
				"[data-testid='desk-view-agent:agent-linus']"
			)
		);
		expect(rows()).toEqual(["thread-audit"]);

		await press(
			view.container.querySelector("[data-testid='desk-row-thread-audit']"),
			"Enter"
		);
		expect(calls).toEqual(["open:thread-audit"]);
		await view.dispose();
	});

	test("the details toggle shows the agents on the conversation", async () => {
		const view = await mount(
			<DeskInterface {...openProps("thread-sync")} params={{}} />
		);
		const details = () =>
			view.container.querySelector("[data-testid='desk-details']");
		const toggle = () =>
			view.container.querySelector("[data-testid='desk-details-toggle']");
		if (details()) {
			await click(toggle());
			expect(details()).toBeNull();
		}
		expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
		await click(toggle());
		expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
		const panel = details();
		expect(panel?.textContent).toContain("Agents");
		expect(button(panel, "Open Ada's inbox")).toBeDefined();
		expect(button(panel, "Open Grace's inbox")).toBeDefined();
		expect(button(panel, "Open Linus's inbox")).toBeUndefined();
		expect(panel?.textContent).toContain("Design Review");
		await view.dispose();
	});
});
