import { afterEach, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";
import { flowLogs } from "./flow-model-panel.ts";

// The flow panel's request log shows a verb per row. Each verb is catalog
// copy, so a Japanese reader sees "質問済み" rather than the English "Asked".
const JA: Record<string, string> = {
	Asked: "質問済み",
	Failed: "失敗",
	Ran: "実行済み",
	Replied: "返信済み",
	Working: "作業中",
};

const runtime = {
	direction: "ltr" as const,
	locale: "ja",
	translate(id: string, values?: MessageValuesInput, fallback?: string) {
		const source = fallback ?? id;
		return formatMessage(JA[source] ?? source, values, "ja");
	},
};

afterEach(() => {
	unregisterActiveI18nRuntime(runtime);
});

const BASE = Date.parse("2026-10-12T12:00:00Z");

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
		updatedAt: new Date(BASE - 60_000).toISOString(),
		...input,
	};
}

const SNAPSHOT = {
	agents: [],
	events: [
		{
			agentId: null,
			end: new Date(BASE - 119_000).toISOString(),
			id: "event-run",
			kind: "past",
			label: "Every hour",
			outcome: "success",
			start: new Date(BASE - 120_000).toISOString(),
			title: "Nightly run",
		},
	],
	groups: [],
	threads: [
		thread({ id: "asked", lastMessageRole: "user" }),
		thread({ id: "replied", lastMessageRole: "assistant" }),
		thread({ id: "working", running: true }),
	],
} as unknown as InterfaceSnapshot;

test("the log verbs follow the UI language", () => {
	registerActiveI18nRuntime(runtime);
	const verbs = Object.fromEntries(
		flowLogs(SNAPSHOT, { kind: "all" }, BASE).map((entry) => [
			entry.title,
			entry.verb,
		])
	);
	expect(verbs).toEqual({
		asked: "質問済み",
		"Nightly run": "実行済み",
		replied: "返信済み",
		working: "作業中",
	});
});
