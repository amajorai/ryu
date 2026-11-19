// Sentences the interfaces used to build from English pieces ("by" + names,
// "of" + a count, "{speaker} in " + a title, "the {title} {kind}", a bare
// noun in "a {noun}") are whole catalog sentences, so a Japanese reader sees
// each in Japanese word order.
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { formatMessage } from "@ryu/i18n/core";
import { I18nProvider, type LiteralMessage } from "@ryu/i18n/react";
import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}

const { chapterPlaceholder, BookDetail } = await import("./library-detail.tsx");
const { agentBooks } = await import("./library-model.ts");
const { AtAGlance } = await import("./newspaper-sidebar.tsx");
const { QuizClueCard } = await import("./quiz-cards.tsx");
const { Missing } = await import("./wiki-articles-shared.tsx");
const { WikiNavProvider } = await import("./wiki-parts.tsx");

afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

const MISSING_KEY =
	"{article, select, agent {The wiki does not have an agent with this name. It may have been deleted or renamed.} group {The wiki does not have a team or project with this name. It may have been deleted or renamed.} other {The wiki does not have a thread with this name. It may have been deleted or renamed.}}";
const PLACEHOLDER_KEY =
	"{kind, select, agent {Start a new conversation with {title}} team {Start a new conversation with the {title} team} project {Start a new conversation with the {title} project} other {Start a new conversation with the {title} collection}}";

const JA: Record<string, string> = {
	[MISSING_KEY]:
		"{article, select, agent {この名前のエージェントはありません。} group {この名前のチームまたはプロジェクトはありません。} other {この名前のスレッドはありません。}}",
	[PLACEHOLDER_KEY]:
		"{kind, select, agent {{title} と新しい会話を始める} team {{title} チームと新しい会話を始める} project {{title} プロジェクトと新しい会話を始める} other {{title} コレクションと新しい会話を始める}}",
	"by <authors>{authors}</authors>": "著者: <authors>{authors}</authors>",
	"{speaker} in <title>{title}</title>": "<title>{title}</title> の {speaker}",
	"{working} <total>of {count}</total>":
		"<total>{count} 人中</total> {working} 人",
};

function render(node: ReactElement): string {
	return renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale="ja"
			manageDocument={false}
			overlays={{ ja: JA }}
		>
			{node}
		</I18nProvider>
	);
}

const text = (html: string) => html.replace(/<[^>]+>/g, "");

const THREAD: InterfaceThread = {
	agentIds: ["agent-ada"],
	id: "thread-1",
	lastMessage: "Ship it",
	lastMessageRole: "assistant",
	messageCount: 2,
	pinned: false,
	projectId: null,
	running: false,
	teamId: null,
	title: "Release notes",
	updatedAt: "2026-10-12T12:00:00Z",
};

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "Writes",
			id: "agent-ada",
			name: "Ada",
			status: "idle",
		},
	],
	groups: [],
	threads: [THREAD],
	version: 1,
};

describe("whole interface sentences in Japanese", () => {
	test("the wiki's missing article names its kind inside the sentence", () => {
		const nav = {
			current: { kind: "main" as const },
			go: () => undefined,
			idPrefix: "w",
		};
		const html = render(
			<WikiNavProvider value={nav}>
				<Missing article="group" />
			</WikiNavProvider>
		);
		expect(text(html)).toContain(
			"この名前のチームまたはプロジェクトはありません。"
		);
	});

	test("the newspaper's working count reads in Japanese order", () => {
		const counts = {
			attention: 0,
			quiet: 0,
			waiting: 0,
			working: 0,
			"your-turn": 0,
		};
		const html = render(
			<AtAGlance agentCount={5} agentsWorking={2} counts={counts} id="g" />
		);
		expect(text(html)).toContain("5 人中 2 人");
	});

	test("the library byline puts the authors inside the sentence", () => {
		const [book] = agentBooks(SNAPSHOT);
		if (!book) {
			throw new Error("no book");
		}
		const html = render(
			<BookDetail
				backLabel="Home"
				book={book}
				headingRef={{ current: null }}
				now={Date.parse("2026-10-12T13:00:00Z")}
				onBack={() => undefined}
				onOpenChapter={() => undefined}
				onWrite={() => undefined}
			/>
		);
		expect(text(html)).toContain("著者: Ada");
		expect(html).toContain('placeholder="Ada と新しい会話を始める"');
	});

	test("the quiz clue names the speaker and title in one sentence", () => {
		const html = render(
			<QuizClueCard
				animate={false}
				answerRef={{ current: null }}
				onAnswer={() => undefined}
				onBack={() => undefined}
				snapshot={SNAPSHOT}
				tile={{
					agentId: "agent-ada",
					categoryName: "Ada",
					needsYou: false,
					row: 0,
					status: "quiet",
					thread: THREAD,
					value: 200,
				}}
			/>
		);
		expect(text(html)).toContain("Release notes の Ada");
	});
});

describe("the chapter placeholder", () => {
	const english: LiteralMessage = (source, values) =>
		formatMessage(source, values ?? {});
	test("names each kind of book in its own English sentence", () => {
		expect(chapterPlaceholder({ kind: "agent", title: "Ada" }, english)).toBe(
			"Start a new conversation with Ada"
		);
		expect(
			chapterPlaceholder({ kind: "unassigned", title: "Loose" }, english)
		).toBe("Start a new conversation with the Loose collection");
		expect(chapterPlaceholder({ kind: "team", title: "Ops" }, english)).toBe(
			"Start a new conversation with the Ops team"
		);
	});
});
