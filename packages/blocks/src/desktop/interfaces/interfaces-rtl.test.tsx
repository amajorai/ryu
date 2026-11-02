// Productivity interface skins follow the reading direction: the mail folder
// rail and the inbox triage row render only logical inline utilities, so an
// Arabic UI mirrors their pills, rails, dots and padding with the layout.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InboxRow } from "./inbox-row.tsx";
import { MAIL_INBOX_VIEW } from "./mail-model.ts";
import { MailNav } from "./mail-nav.tsx";

const NOW = Date.parse("2026-10-31T12:00:00Z");

function classNames(html: string): string {
	return Array.from(html.matchAll(/class="([^"]*)"/g), (match) => match[1])
		.join("\n")
		.replaceAll("&amp;", "&");
}

// The physical inline utilities the RTL ratchet counts (tools/check-ui-ratchet.mjs).
const PHYSICAL_INLINE_UTILITY =
	/(?<![\w\-/.[])(?<!(?:rtl|ltr):)(?:-?m[lr]-(?:[\d[]|px\b|auto\b)|p[lr]-(?:[\d[]|px\b)|-?(?:left|right)-(?!1\/2\b)(?:[\d[]|px\b|full\b|auto\b)|text-(?:left|right)\b(?!-)|border-[lr](?:\b(?!-)|-(?=[\d[a-z]))|rounded-(?:[lr]|tl|tr|bl|br)(?:\b(?!-)|-))/g;

function physicalUtilities(html: string): string[] {
	return classNames(html).match(PHYSICAL_INLINE_UTILITY) ?? [];
}

describe("interface skins under right-to-left", () => {
	test("the mail folder rail uses logical inline utilities", () => {
		for (const collapsed of [false, true]) {
			const html = renderToStaticMarkup(
				<div dir="rtl">
					<MailNav
						collapsed={collapsed}
						composeDisabled={false}
						counts={{ all: 4, inbox: 2, sent: 1, starred: 1, working: 1 }}
						labels={[
							{
								id: "team-docs",
								kind: "team",
								memberAgentIds: [],
								name: "Docs",
							},
						]}
						labelUnread={new Map([["team-docs", 1]])}
						loading={false}
						onCompose={() => undefined}
						onSelect={() => undefined}
						view={MAIL_INBOX_VIEW}
					/>
				</div>
			);
			if (!collapsed) {
				expect(html).toContain("rounded-e-full");
			}
			expect(physicalUtilities(html)).toEqual([]);
		}
	});

	test("the inbox row keeps its unread dot and rail on the inline start", () => {
		const html = renderToStaticMarkup(
			<div dir="rtl">
				<InboxRow
					cursor={false}
					item={{
						actorLabel: "Ada",
						agents: [],
						groupKind: null,
						groupName: null,
						leadAgent: undefined,
						preview: "Draft is ready for review.",
						status: "attention",
						thread: {
							agentIds: [],
							id: "thread-notes",
							lastMessage: "Draft is ready for review.",
							lastMessageRole: "assistant",
							messageCount: 2,
							pinned: true,
							projectId: null,
							running: false,
							teamId: null,
							title: "Release notes",
							updatedAt: new Date(NOW - 60 * 60_000).toISOString(),
						},
						unassigned: false,
					}}
					now={NOW}
					onFocusRow={() => undefined}
					onOpen={() => undefined}
					open
					registerRow={() => undefined}
				/>
			</div>
		);
		expect(html).toContain("before:start-0");
		expect(physicalUtilities(html)).toEqual([]);
	});
});
