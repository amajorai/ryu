import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import type {
	InterfaceAgent,
	InterfaceGroup,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

// Composites that name agents ("Affects Ada and Grace", "Ada and Grace ·
// Design") join the names the way the reader's language lists them, and an
// empty list's fallback ("No agent assigned", "No agent", "You") is
// translated before it lands inside the translated sentence: the DOM
// localizer only matches whole strings, so an English word inside one stays
// English.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { StatusThreadPanel } = await import("./status-panel.tsx");
const { ConversationHeader } = await import("./desk-conversation-header.tsx");
const { PosterList } = await import("./forum-parts.tsx");
const { ChatTalk } = await import("./wiki-interface-route-bodies.tsx");

const JA: Record<string, string> = {
	"A new conversation. Your first message starts the thread.":
		"新しい会話です。最初のメッセージでスレッドが始まります。",
	"Conversation with {agentNames}.": "{agentNames}との会話。",
	"Affects {agentNames}": "影響: {agentNames}",
	"New thread": "新しいスレッド",
	"No agent": "エージェントなし",
	"No agent assigned": "担当エージェントなし",
	"Pick an agent and write the first message below":
		"エージェントを選んで最初のメッセージを書いてください",
	"Posters: {names}": "投稿者: {names}",
	You: "あなた",
	"{names} · {group}": "{names}・{group}",
};
const DE: Record<string, string> = {
	"Affects {agentNames}": "Betrifft {agentNames}",
	"New thread": "Neuer Thread",
};
const AR: Record<string, string> = {
	"Posters: {names}": "الناشرون: {names}",
	You: "أنت",
};

const agent = (id: string, name: string): InterfaceAgent =>
	({ id, name, status: "idle" }) as InterfaceAgent;

const GROUP = { id: "g-1", kind: "team", name: "デザイン" } as InterfaceGroup;

let mounted: { container: HTMLElement; root: Root } | undefined;
async function unmount(): Promise<void> {
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
}
afterEach(async () => {
	registerLiteralCatalogLoader(null);
	await unmount();
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function render(
	locale: string,
	element: ReactElement
): Promise<HTMLElement> {
	registerLiteralCatalogLoader((requested) => {
		if (requested.startsWith("ja")) {
			return JA;
		}
		if (requested.startsWith("de")) {
			return DE;
		}
		return requested.startsWith("ar") ? AR : {};
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				{element}
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container;
}

function statusPanel(agentNames: readonly string[]): ReactElement {
	return (
		<StatusThreadPanel
			agentNames={agentNames}
			headingRef={null}
			incident={{
				affected: [],
				agentIds: [],
				at: "2026-11-01T10:00:00.000Z",
				body: "",
				id: "incident-1",
				kind: "thread",
				resolvedAt: null,
				schedule: null,
				severity: "outage",
				stage: "失敗",
				threadId: null,
				title: "",
			}}
			onClose={() => undefined}
			thread={undefined}
			threadView={null}
		/>
	);
}

function subtitle(container: HTMLElement): string {
	return container.querySelector("header p")?.textContent ?? "";
}

test("an incident with no agents reads entirely in Japanese", async () => {
	const container = await render("ja", statusPanel([]));
	expect(subtitle(container)).toBe("失敗 · 影響: 担当エージェントなし");
	expect(subtitle(container)).not.toMatch(/[A-Za-z]/);
});

test("an incident's affected agents are joined as Japanese lists them", async () => {
	const container = await render("ja", statusPanel(["Ada", "Grace"]));
	expect(subtitle(container)).toBe("失敗 · 影響: Ada、Grace");
});

test("an incident's affected agents read as an English list in English", async () => {
	const container = await render("en", statusPanel(["Ada", "Echo", "Forge"]));
	expect(subtitle(container)).toEndWith("Affects Ada, Echo, and Forge");
});

test("an incident's affected agents read as a German list in German", async () => {
	const container = await render("de", statusPanel(["Ada", "Echo", "Forge"]));
	expect(subtitle(container)).toBe("失敗 · Betrifft Ada, Echo und Forge");
});

function deskRow(
	agents: InterfaceAgent[],
	group: InterfaceGroup | undefined
): Parameters<typeof ConversationHeader>[0]["row"] {
	return {
		actorLabel: "",
		agents,
		group,
		lead: agents[0],
		needsYou: false,
		preview: "",
		status: "quiet",
		thread: { id: "thread-1" } as InterfaceThread,
		title: "Launch notes",
	};
}

function header(
	row: Parameters<typeof ConversationHeader>[0]["row"]
): ReactElement {
	return (
		<ConversationHeader
			detailsInline
			detailsOpen={false}
			newTargetLabel={null}
			onClose={() => undefined}
			onToggleDetails={null}
			row={row}
			stacked
		/>
	);
}

function context(container: HTMLElement): string {
	return container.querySelector("header p")?.textContent ?? "";
}

test("a conversation with no agent says so in Japanese beside its group", async () => {
	const container = await render("ja", header(deskRow([], GROUP)));
	expect(context(container)).toBe("エージェントなし・デザイン");
});

test("a conversation's agents are joined with the Japanese list mark", async () => {
	const container = await render(
		"ja",
		header(deskRow([agent("a", "Ada"), agent("g", "Grace")], undefined))
	);
	expect(context(container)).toBe("Ada、Grace");
});

test("a new conversation's prompt is translated", async () => {
	const container = await render("ja", header(null));
	expect(context(container)).toBe(
		"エージェントを選んで最初のメッセージを書いてください"
	);
});

function posters(container: HTMLElement): string {
	return container.querySelector(".sr-only")?.textContent ?? "";
}

test("a topic only you wrote in names you in the reader's language", async () => {
	const topic = { posters: [] } as unknown as Parameters<
		typeof PosterList
	>[0]["topic"];
	const container = await render("ja", <PosterList topic={topic} />);
	expect(posters(container)).toBe("投稿者: あなた");
});

test("a topic's posters are joined as Arabic lists them", async () => {
	const topic = {
		posters: [agent("a", "Ada"), agent("g", "Grace")],
	} as unknown as Parameters<typeof PosterList>[0]["topic"];
	const container = await render("ar", <PosterList topic={topic} />);
	expect(posters(container)).toBe("الناشرون: Ada وGrace");
});

function chatTalk(
	threadId: string | null,
	agentIds: readonly string[]
): ReactElement {
	const snapshot = {
		agents: [agent("a", "Ada"), agent("g", "Grace")],
		groups: [],
		threads: [{ agentIds, id: "thread-1", title: "Launch notes" }],
	} as unknown as Parameters<typeof ChatTalk>[0]["snapshot"];
	return <ChatTalk snapshot={snapshot} threadId={threadId} threadView={null} />;
}

function talkNote(container: HTMLElement): string {
	return container.querySelector("p")?.textContent ?? "";
}

test("a wiki talk page with no thread yet reads in Japanese", async () => {
	const container = await render("ja", chatTalk(null, []));
	expect(talkNote(container)).toBe(
		"新しい会話です。最初のメッセージでスレッドが始まります。"
	);
});

test("a wiki talk page joins its agents the Japanese way", async () => {
	const container = await render("ja", chatTalk("thread-1", ["a", "g"]));
	expect(talkNote(container)).toBe("Ada、Graceとの会話。");
});
