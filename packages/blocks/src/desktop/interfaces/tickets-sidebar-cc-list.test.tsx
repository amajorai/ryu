import { afterEach, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import type {
	InterfaceAgent,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { renderToStaticMarkup } from "react-dom/server";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";
import { buildTickets } from "./tickets-model.ts";
import { TicketsSidebar } from "./tickets-page-sidebar.tsx";

// The sidebar's CC line lists agents with the UI locale's list pattern, not a
// hand-joined English ", ".
const NOW = Date.now();
const passthrough: LiteralMessage = (source, values) =>
	formatMessage(source, values);
const japanese = {
	direction: "ltr" as const,
	locale: "ja",
	translate(id: string, values?: MessageValuesInput, fallback?: string) {
		return formatMessage(fallback ?? id, values, "ja");
	},
};

function agent(id: string, name: string): InterfaceAgent {
	return { avatarUrl: null, description: "", id, name, status: "idle" };
}

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		agent("a", "Ada"),
		agent("b", "Grace"),
		agent("c", "Echo"),
		agent("d", "Forge"),
	],
	groups: [],
	threads: [
		{
			agentIds: ["a", "b", "c", "d"],
			id: "thread-1",
			lastMessage: "Ready.",
			lastMessageRole: "assistant",
			messageCount: 2,
			pinned: false,
			projectId: null,
			running: false,
			teamId: null,
			title: "Release notes",
			updatedAt: new Date(NOW - 60_000).toISOString(),
		},
	],
	version: 1,
};

afterEach(() => unregisterActiveI18nRuntime(japanese));

function sidebarHtml(): string {
	const [ticket] = buildTickets(SNAPSHOT, NOW, passthrough);
	if (!ticket) {
		throw new Error("no ticket built");
	}
	return renderToStaticMarkup(
		<TicketsSidebar
			floating={false}
			now={NOW}
			onClose={() => undefined}
			onOpenTicket={() => undefined}
			others={[]}
			ticket={ticket}
		/>
	);
}

test("lists CC agents with the Japanese list pattern", () => {
	registerActiveI18nRuntime(japanese);
	const expected = new Intl.ListFormat("ja", { type: "conjunction" }).format([
		"Grace",
		"Echo",
		"Forge",
	]);
	const html = sidebarHtml();
	expect(html).toContain(expected);
	expect(html).not.toContain("Grace, Echo, Forge");
});

test("lists CC agents as an English conjunction by default", () => {
	expect(sidebarHtml()).toContain("Grace, Echo, and Forge");
});
