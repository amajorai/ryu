// Inbox row names under a non-English UI: the "pinned" status is its own whole
// message, so Japanese reads a status word instead of the bare counter suffix
// ("件のピン留め", "items pinned" without a number) that the count copy uses.

import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import {
	INTERFACE_PROTOCOL_VERSION,
	type InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { renderToStaticMarkup } from "react-dom/server";
import JA from "../../../../i18n/locales/ja.json" with { type: "json" };
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";
import { InboxInterface } from "./inbox-interface.tsx";

const catalog: Readonly<Record<string, string>> = JA;

const japanese = {
	direction: "ltr" as const,
	locale: "ja",
	translate(source: string, values?: MessageValuesInput, fallback?: string) {
		const english = fallback ?? source;
		return formatMessage(catalog[english] ?? english, values, "ja");
	},
};

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "Writes the release notes",
			id: "agent-ada",
			name: "Ada",
			status: "idle",
		},
	],
	groups: [],
	threads: [
		{
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			lastMessageRole: "assistant",
			messageCount: 2,
			pinned: true,
			projectId: null,
			running: false,
			teamId: null,
			title: "Release notes",
			updatedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
		},
	],
	version: INTERFACE_PROTOCOL_VERSION,
};

afterEach(() => {
	unregisterActiveI18nRuntime(japanese);
});

describe("inbox row names in Japanese", () => {
	test("a pinned row says it is pinned, not a counter suffix without a count", () => {
		registerActiveI18nRuntime(japanese);
		const html = renderToStaticMarkup(
			<InboxInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={{
					closeThread: () => undefined,
					openThread: () => undefined,
					startThread: () => undefined,
				}}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const label = /aria-label="(Release notes, [^"]*)"/.exec(html)?.[1] ?? "";
		expect(label).toContain(catalog.Pinned ?? "");
		expect(catalog.Pinned).not.toContain("件");
		expect(label).not.toContain("件のピン留め");
	});
});
