import { describe, expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import type { InterfaceThread } from "@ryuhq/protocol/interfaces";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type PostActions, PostRow } from "./community-feed.tsx";
import type { Community, CommunityPost } from "./community-model.ts";
import { CharacterRing, FEED_PROMPT_LIMIT } from "./feed-composer.tsx";
import { ThreadSwitcher } from "./messenger-conversation-threads.tsx";
import type { MessengerEntry } from "./messenger-model.ts";

// Counted interface labels are whole ICU plurals, so Arabic and German pick
// their own forms. The stub rows stand in for the generated catalog rows.
const COMMENTS =
	"{comments, plural, one {# comment on “{title}”} other {# comments on “{title}”}}";
const REMAINING =
	"{remaining, plural, one {# character remaining} other {# characters remaining}}";
const MORE_CONVERSATIONS =
	"{count, plural, one {# more conversation with {name}} other {# more conversations with {name}}}";

const AR = {
	[COMMENTS]:
		"{comments, plural, zero {لا تعليقات على «{title}»} one {تعليق واحد على «{title}»} two {تعليقان على «{title}»} few {# تعليقات على «{title}»} many {# تعليقًا على «{title}»} other {# تعليق على «{title}»}}",
	[MORE_CONVERSATIONS]:
		"{count, plural, zero {لا محادثات أخرى مع {name}} one {محادثة أخرى مع {name}} two {محادثتان أخريان مع {name}} few {# محادثات أخرى مع {name}} many {# محادثة أخرى مع {name}} other {# محادثة أخرى مع {name}}}",
	[REMAINING]:
		"{remaining, plural, zero {لا أحرف متبقية} one {حرف واحد متبقٍ} two {حرفان متبقيان} few {# أحرف متبقية} many {# حرفًا متبقيًا} other {# حرف متبقٍ}}",
};
const DE = {
	[COMMENTS]:
		"{comments, plural, one {# Kommentar zu „{title}“} other {# Kommentare zu „{title}“}}",
	[MORE_CONVERSATIONS]:
		"{count, plural, one {# weitere Unterhaltung mit {name}} other {# weitere Unterhaltungen mit {name}}}",
	[REMAINING]:
		"{remaining, plural, one {# Zeichen übrig} other {# Zeichen übrig}}",
};

// Arabic isolates interpolated strings with FSI/PDI; drop them to compare text.
const BIDI_ISOLATES = /[\u2068\u2069]/g;

function inLocale(locale: string, element: ReactElement): string {
	const html = renderToStaticMarkup(
		<I18nProvider
			initialLocale={locale}
			manageDocument={false}
			overlays={{ ar: AR, de: DE }}
		>
			{element}
		</I18nProvider>
	);
	return html.replace(BIDI_ISOLATES, "");
}

function thread(id: string): InterfaceThread {
	return {
		agentIds: [],
		id,
		lastMessage: null,
		lastMessageRole: "assistant",
		messageCount: 2,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		title: `Thread ${id}`,
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

const COMMUNITY: Community = {
	agentId: null,
	description: "Launch work",
	handle: "Launch",
	key: "project:launch",
	kind: "project",
	lastActivity: null,
	members: [],
	name: "Launch",
	prefix: "r/",
	seed: "launch",
	sourceId: "launch",
	threadCount: 1,
	workingCount: 0,
};

const ACTIONS: PostActions = {
	copiedId: null,
	onOpen: () => undefined,
	onSave: () => undefined,
	onSelectCommunity: () => undefined,
	onSelectPoster: () => undefined,
	onShare: () => undefined,
	onVote: () => undefined,
	saved: new Set(),
	votes: {},
};

function commentsLabel(locale: string, comments: number): string {
	const post: CommunityPost = {
		comments,
		community: COMMUNITY,
		excerpt: null,
		poster: null,
		score: 2,
		status: "quiet",
		thread: { ...thread("p1"), title: "Roadmap" },
	};
	return inLocale(
		locale,
		<PostRow
			actions={ACTIONS}
			inCommunity
			now={Date.parse("2026-01-01T01:00:00.000Z")}
			post={post}
			registerRow={() => undefined}
		/>
	);
}

// Past three pills the rest overflow, so the menu always holds two or more.
function moreConversationsHtml(locale: string, overflow: number): string {
	const threads = Array.from({ length: 3 + overflow }, (_, index) =>
		thread(`t${index}`)
	);
	const entry = {
		id: "agent-ada",
		key: "agent:agent-ada",
		kind: "agent",
		name: "Ada",
	} as MessengerEntry;
	return inLocale(
		locale,
		<ThreadSwitcher
			activeThreadId={null}
			entry={entry}
			onOpen={() => undefined}
			threads={threads}
		/>
	);
}

describe("community feed comment counts", () => {
	test("pluralize in English", () => {
		expect(commentsLabel("en", 1)).toContain(
			'aria-label="1 comment on “Roadmap”"'
		);
		expect(commentsLabel("en", 4)).toContain(
			'aria-label="4 comments on “Roadmap”"'
		);
	});

	test("select the Arabic one, two and many forms", () => {
		expect(commentsLabel("ar", 1)).toContain("تعليق واحد على «Roadmap»");
		expect(commentsLabel("ar", 2)).toContain("تعليقان على «Roadmap»");
		expect(commentsLabel("ar", 11)).toContain("11 تعليقًا على «Roadmap»");
	});

	test("select the German singular", () => {
		expect(commentsLabel("de", 1)).toContain("1 Kommentar zu „Roadmap“");
		expect(commentsLabel("de", 3)).toContain("3 Kommentare zu „Roadmap“");
	});
});

describe("feed composer remaining characters", () => {
	const ring = (locale: string, remaining: number) =>
		inLocale(locale, <CharacterRing length={FEED_PROMPT_LIMIT - remaining} />);

	test("pluralize in English", () => {
		expect(ring("en", 1)).toContain("1 character remaining");
		expect(ring("en", 5)).toContain("5 characters remaining");
	});

	test("select the Arabic forms for 1, 2 and 11", () => {
		expect(ring("ar", 1)).toContain("حرف واحد متبقٍ");
		expect(ring("ar", 2)).toContain("حرفان متبقيان");
		expect(ring("ar", 11)).toContain("11 حرفًا متبقيًا");
	});
});

describe("messenger overflow conversations", () => {
	test("pluralize in English", () => {
		expect(moreConversationsHtml("en", 2)).toContain(
			'aria-label="2 more conversations with Ada"'
		);
		expect(moreConversationsHtml("en", 11)).toContain(
			'aria-label="11 more conversations with Ada"'
		);
	});

	test("select the Arabic and German forms", () => {
		expect(moreConversationsHtml("ar", 2)).toContain("محادثتان أخريان مع Ada");
		expect(moreConversationsHtml("ar", 11)).toContain("11 محادثة أخرى مع Ada");
		expect(moreConversationsHtml("de", 3)).toContain(
			"3 weitere Unterhaltungen mit Ada"
		);
	});
});
