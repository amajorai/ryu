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
import {
	click,
	EMPTY,
	mount,
	openProps,
	press,
	props,
	recordingPort,
	SNAPSHOT,
	submit,
	typeInto,
	useLayoutDom,
} from "./layouts-test-support.tsx";
import { MessengerInterface } from "./messenger-interface.tsx";
import { TerminalInterface } from "./terminal-interface.tsx";
import { listThreads } from "./terminal-model.ts";

useLayoutDom();

// ---------------------------------------------------------------------------
// Messenger
// ---------------------------------------------------------------------------

describe("Messenger layout", () => {
	test("lists agents and the team as contacts", () => {
		const html = renderToStaticMarkup(
			<MessengerInterface {...props()} params={{}} />
		);
		expect(html).toContain('data-testid="interface-messenger"');
		expect(html).toContain('aria-label="Contacts"');
		for (const key of [
			"agent:agent-ada",
			"agent:agent-grace",
			"agent:agent-linus",
			"team:team-design",
		]) {
			expect(html).toContain(`data-messenger-contact="${key}"`);
		}
		expect(html).toContain("No conversation selected");
	});

	test("shows loading and empty states", () => {
		const loading = renderToStaticMarkup(
			<MessengerInterface
				{...props({ loading: true, snapshot: EMPTY })}
				params={{}}
			/>
		);
		expect(loading).toContain("Loading conversations…");
		const empty = renderToStaticMarkup(
			<MessengerInterface {...props({ snapshot: EMPTY })} params={{}} />
		);
		expect(empty).toContain("No contacts yet.");
		expect(empty).toContain("Create an agent to start messaging");
	});

	test("shows the host thread view in the conversation", () => {
		const html = renderToStaticMarkup(
			<MessengerInterface {...openProps("thread-notes")} params={{}} />
		);
		expect(html).toContain('data-testid="messenger-thread"');
		expect(html).toContain('data-testid="host-thread-view"');
	});

	test("clicking a contact opens its latest thread; search filters", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<MessengerInterface {...props({ port })} params={{}} />
		);
		const contact = (key: string) =>
			view.container.querySelector(`[data-messenger-contact="${key}"]`);
		await click(contact("agent:agent-grace"));
		// Grace's most recent thread is the live crash triage.
		expect(calls).toEqual(["open:thread-triage"]);

		const search = view.container.querySelector("input[type='search']");
		await typeInto(search, "advisories");
		expect(contact("agent:agent-linus")).not.toBeNull();
		expect(contact("agent:agent-ada")).toBeNull();
		expect(contact("agent:agent-grace")).toBeNull();

		await typeInto(search, "zzz-no-match");
		expect(view.container.textContent).toContain("No contacts match");

		await typeInto(search, "");
		expect(contact("agent:agent-ada")).not.toBeNull();
		await view.dispose();
	});
});

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

describe("Terminal layout", () => {
	test("prints the banner with live counts and a labelled prompt", () => {
		const html = renderToStaticMarkup(
			<TerminalInterface {...props()} params={{}} />
		);
		expect(html).toContain('data-testid="interface-terminal"');
		expect(html).toContain('role="log"');
		expect(html).toContain("Terminal command");
		expect(html).toContain("1 working");
		expect(html).toContain("3 agents");
		expect(html).toContain("6 threads");
	});

	test("shows loading and empty states", () => {
		const loading = renderToStaticMarkup(
			<TerminalInterface
				{...props({ loading: true, snapshot: EMPTY })}
				params={{}}
			/>
		);
		expect(loading).toContain('aria-busy="true"');
		expect(loading).toContain("loading agents and threads");
		const empty = renderToStaticMarkup(
			<TerminalInterface {...props({ snapshot: EMPTY })} params={{}} />
		);
		expect(empty).toContain("0 agents");
		expect(empty).toContain("0 threads");
	});

	test("shows the host thread view beside the scrollback", () => {
		const html = renderToStaticMarkup(
			<TerminalInterface {...openProps("thread-sync")} params={{}} />
		);
		expect(html).toContain('aria-label="Thread: Weekly design sync"');
		expect(html).toContain('data-testid="host-thread-view"');
	});

	test("ls, open, @agent, unknown commands and history all work", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<TerminalInterface {...props({ port })} params={{}} />
		);
		const input = view.container.querySelector("input[type='text']");
		const form = view.container.querySelector("form");
		const log = () =>
			view.container.querySelector("[role='log']")?.textContent ?? "";
		const run = async (command: string) => {
			await typeInto(input, command);
			await submit(form);
		};

		await run("ls");
		const listed = listThreads(SNAPSHOT, "all");
		for (const row of listed) {
			expect(log()).toContain(row.title);
		}
		await run("open 1");
		expect(calls).toEqual([`open:${listed[0]?.threadId}`]);
		expect(log()).toContain(`Opened #1 ${listed[0]?.title}`);

		await run("@ada hi");
		expect(calls.at(-1)).toBe('start:{"agentId":"agent-ada","prompt":"hi"}');

		await run("frobnicate");
		expect(log()).toContain("ryu: command not found: frobnicate");
		expect(calls).toHaveLength(2);

		expect((input as HTMLInputElement).value).toBe("");
		await press(input, "ArrowUp");
		expect((input as HTMLInputElement).value).toBe("frobnicate");
		await press(input, "ArrowUp");
		expect((input as HTMLInputElement).value).toBe("@ada hi");
		await press(input, "ArrowDown");
		expect((input as HTMLInputElement).value).toBe("frobnicate");
		await view.dispose();
	});
});
