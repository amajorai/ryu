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
import { GraphInterface } from "./graph-interface.tsx";
import { InboxInterface } from "./inbox-interface.tsx";
import {
	button,
	click,
	EMPTY,
	missingTitles,
	mount,
	openProps,
	press,
	props,
	recordingPort,
	SNAPSHOT,
	useLayoutDom,
} from "./layouts-test-support.tsx";
import { TimelineInterface } from "./timeline-interface.tsx";

useLayoutDom();

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

describe("Inbox layout", () => {
	test("groups every thread into urgency sections", () => {
		const html = renderToStaticMarkup(
			<InboxInterface {...props()} params={{}} />
		);
		expect(html).toContain('data-testid="interface-inbox"');
		expect(html).toContain('role="listbox"');
		for (const section of ["attention", "your-turn", "working", "waiting"]) {
			expect(html).toContain(`data-section="${section}"`);
		}
		for (const item of SNAPSHOT.threads) {
			expect(html).toContain(`data-testid="inbox-row-${item.id}"`);
		}
		// Needs attention and your turn are the threads that need you.
		expect(html).toContain("3 need you");
	});

	test("shows loading and empty states", () => {
		const loading = renderToStaticMarkup(
			<InboxInterface
				{...props({ loading: true, snapshot: EMPTY })}
				params={{}}
			/>
		);
		expect(loading).toContain("Loading inbox");
		expect(loading).not.toContain("No threads yet. Start one");
		const empty = renderToStaticMarkup(
			<InboxInterface {...props({ snapshot: EMPTY })} params={{}} />
		);
		expect(empty).toContain("No threads yet. Start one with any agent.");
	});

	test("shows the host thread view in the detail pane", () => {
		const html = renderToStaticMarkup(
			<InboxInterface {...openProps("thread-audit")} params={{}} />
		);
		expect(html).toContain('data-testid="inbox-detail"');
		expect(html).toContain('data-testid="host-thread-view"');
	});

	test("J/K move the cursor and Enter opens the row", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<InboxInterface {...props({ port })} params={{}} />
		);
		const order = [
			...view.container.querySelectorAll<HTMLElement>("[data-inbox-row]"),
		].map((row) => row.dataset.inboxRow ?? "");
		expect(order).toHaveLength(SNAPSHOT.threads.length);
		// Most urgent first: the failed audit leads the list.
		expect(order[0]).toBe("thread-audit");
		const row = (id: string | undefined) =>
			view.container.querySelector(`[data-inbox-row="${id}"]`);

		expect(row(order[0])?.getAttribute("tabindex")).toBe("0");
		await press(row(order[0]), "j");
		expect(document.activeElement).toBe(row(order[1]));
		await press(row(order[1]), "j");
		expect(document.activeElement).toBe(row(order[2]));
		await press(row(order[2]), "k");
		expect(document.activeElement).toBe(row(order[1]));
		await press(row(order[1]), "Enter");
		expect(calls).toEqual([`open:${order[1]}`]);

		// C starts a new thread from the list.
		await press(row(order[1]), "c");
		expect(calls.at(-1)).toBe("start:{}");
		await view.dispose();
	});
});

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

describe("Graph layout", () => {
	test("puts you, every agent, the team and the project on the map", async () => {
		const view = await mount(<GraphInterface {...props()} params={{}} />);
		expect(
			view.container.querySelector("[data-testid='interface-graph']")
		).not.toBeNull();
		const nodes = [
			...view.container.querySelectorAll<HTMLElement>("[data-graph-node]"),
		].map((node) => node.dataset.graphNode);
		expect(nodes).toEqual(
			expect.arrayContaining([
				"you",
				"agent:agent-ada",
				"agent:agent-grace",
				"agent:agent-linus",
			])
		);
		expect(nodes.some((id) => id?.includes("team-design"))).toBe(true);
		expect(nodes.some((id) => id?.includes("project-docs"))).toBe(true);
		await view.dispose();
	});

	test("shows loading and empty states", () => {
		const loading = renderToStaticMarkup(
			<GraphInterface
				{...props({ loading: true, snapshot: EMPTY })}
				params={{}}
			/>
		);
		expect(loading).toContain('aria-label="Loading the map"');
		expect(loading).toContain('aria-busy="true"');
		const empty = renderToStaticMarkup(
			<GraphInterface {...props({ snapshot: EMPTY })} params={{}} />
		);
		expect(empty).toContain("No one on the map yet");
	});

	test("shows the host thread view in the thread panel", async () => {
		const view = await mount(
			<GraphInterface {...openProps("thread-triage")} params={{}} />
		);
		const panel = view.container.querySelector(
			"[data-testid='graph-thread-panel']"
		);
		expect(panel?.getAttribute("aria-label")).toBe("Thread: Crash triage");
		expect(
			panel?.querySelector("[data-testid='host-thread-view']")
		).not.toBeNull();
		await view.dispose();
	});

	test("clicking a node opens its side panel, which opens threads", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<GraphInterface {...props({ port })} params={{}} />
		);
		expect(
			view.container.querySelector("[data-testid='graph-node-panel']")
		).toBeNull();
		await click(
			view.container.querySelector("[data-graph-node='agent:agent-grace']")
		);
		const panel = view.container.querySelector(
			"[data-testid='graph-node-panel']"
		);
		expect(panel?.getAttribute("aria-label")).toBe("Grace details");
		expect(panel?.textContent).toContain("Triages bugs");
		expect(panel?.textContent).toContain("Crash triage");
		expect(panel?.textContent).toContain("Weekly design sync");
		expect(panel?.textContent).not.toContain("Audit dependencies");

		await click(button(panel, /Crash triage/));
		expect(calls).toEqual(["open:thread-triage"]);

		await click(button(panel, "Close details"));
		expect(
			view.container.querySelector("[data-testid='graph-node-panel']")
		).toBeNull();
		await view.dispose();
	});
});

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

describe("Timeline layout", () => {
	test("renders one section per active day, newest first", () => {
		const html = renderToStaticMarkup(
			<TimelineInterface {...props()} params={{ scale: "day" }} />
		);
		expect(html).toContain('data-testid="interface-timeline"');
		expect(html).toContain('aria-label="Threads by day"');
		expect(html).toContain('aria-label="Threads, Today"');
		expect(html).toContain('aria-label="Threads, Yesterday"');
		expect(html.match(/data-day-key="/g)).toHaveLength(3);
		expect(html.indexOf("Threads, Today")).toBeLessThan(
			html.indexOf("Threads, Yesterday")
		);
		expect(missingTitles(html)).toEqual([]);
	});

	test("shows loading and empty states", () => {
		const loading = renderToStaticMarkup(
			<TimelineInterface
				{...props({ loading: true, snapshot: EMPTY })}
				params={{ scale: "day" }}
			/>
		);
		expect(loading).toContain('aria-busy="true"');
		expect(loading).not.toContain("No threads yet");
		const empty = renderToStaticMarkup(
			<TimelineInterface
				{...props({ snapshot: EMPTY })}
				params={{ scale: "day" }}
			/>
		);
		expect(empty).toContain("No threads yet");
	});

	test("shows the host thread view in its panel", () => {
		const html = renderToStaticMarkup(
			<TimelineInterface
				{...openProps("thread-intro")}
				params={{ scale: "week" }}
			/>
		);
		expect(html).toContain('data-testid="timeline-thread-panel"');
		expect(html).toContain('data-testid="host-thread-view"');
	});

	test("the Day/Week toggle switches scale and events open threads", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<TimelineInterface {...props({ port })} params={{ scale: "day" }} />
		);
		const region = () =>
			view.container.querySelector("[role='region'][aria-label^='Threads ']");
		expect(region()?.getAttribute("aria-label")).toBe("Threads by day");
		const scale = view.container.querySelector("[aria-label='Timeline scale']");
		await click(button(scale, "Week"));
		expect(region()?.getAttribute("aria-label")).toBe("Threads this week");
		// The week grid labels today's column.
		expect(
			[...view.container.querySelectorAll("[aria-label^='Today, ']")].length
		).toBeGreaterThan(0);

		await click(button(view.container, /^Release notes, Ada/));
		expect(calls).toEqual(["open:thread-notes"]);

		await click(button(scale, "Day"));
		expect(region()?.getAttribute("aria-label")).toBe("Threads by day");
		await view.dispose();
	});
});
