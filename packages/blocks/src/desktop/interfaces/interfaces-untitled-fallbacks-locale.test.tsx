import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import type {
	InterfaceAccountTransaction,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import JA from "../../../../i18n/locales/ja.json" with { type: "json" };

// Bank and Forum render a conversation or topic title inside an off-region,
// so an untitled one must be localized before it is rendered, and a real
// title (even one equal to a catalog string, like "Settings") must reach the
// reader exactly as written.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { BankFeed } = await import("./bank-feed.tsx");
const { BankTransactionPanel } = await import("./bank-panel.tsx");
const { CategoriesTable } = await import("./forum-categories.tsx");
const { untitledConversationTitle, untitledTopicTitle } = await import(
	"./thread-display-title.ts"
);

const CATALOG = JA as Record<string, string>;
const UNTITLED_CONVERSATION_JA = CATALOG["Untitled conversation"] ?? "";
const UNTITLED_TOPIC_JA = CATALOG["Untitled topic"] ?? "";

const thread = (title: string): InterfaceThread =>
	({
		agentIds: [],
		id: "thread-1",
		lastMessage: null,
		lastMessageRole: "user",
		messageCount: 0,
		pinned: false,
		status: "idle",
		title,
		updatedAt: "2026-11-01T10:00:00.000Z",
	}) as unknown as InterfaceThread;

const TRANSACTION: InterfaceAccountTransaction = {
	amount: -1_250_000,
	at: "2026-11-01T10:00:00.000Z",
	balanceAfter: null,
	id: "tx-1",
	inputTokens: 1200,
	kind: "debit",
	label: "Chat",
	model: null,
	outputTokens: 300,
	provider: null,
	threadId: "thread-1",
};

const snapshot = (title: string): InterfaceSnapshot =>
	({
		agents: [],
		groups: [],
		threads: [thread(title)],
	}) as unknown as InterfaceSnapshot;

const NOW = Date.parse("2026-11-01T12:00:00.000Z");

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
	registerLiteralCatalogLoader(null);
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function render(node: ReactElement): Promise<HTMLElement> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("ja") ? CATALOG : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				{node}
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return container;
}

const offText = (container: HTMLElement): (string | null)[] =>
	[...container.querySelectorAll('[data-ryu-i18n="off"]')].map(
		(node) => node.textContent
	);

const feed = (title: string) => (
	<BankFeed
		currency="usd"
		month={null}
		now={NOW}
		onClearMonth={() => undefined}
		onQuery={() => undefined}
		onSelect={() => undefined}
		query=""
		selectedId={null}
		snapshot={snapshot(title)}
		transactions={[TRANSACTION]}
	/>
);

const panel = (title: string) => (
	<BankTransactionPanel
		context={{ agents: [], thread: thread(title) }}
		currency="usd"
		headingRef={null}
		onClose={() => undefined}
		onViewConversation={() => undefined}
		transaction={TRANSACTION}
	/>
);

const categories = (title: string) => (
	<CategoriesTable
		categories={[
			{
				agent: null,
				description: "Launch work",
				id: "project-1",
				kind: "project",
				latest: thread(title),
				memberIds: [],
				name: "Launch",
				swatch: 0,
				topicIds: ["thread-1"],
			},
		]}
		now={NOW}
		onOpen={() => undefined}
		onSelect={() => undefined}
		snapshot={snapshot(title)}
	/>
);

describe("interface untitled fallbacks", () => {
	test("the helpers keep real titles and localize the empty ones", () => {
		expect(untitledConversationTitle(" Launch plan ")).toBe("Launch plan");
		expect(untitledConversationTitle(null)).toBe("Untitled conversation");
		expect(untitledTopicTitle("  ")).toBe("Untitled topic");
		expect(UNTITLED_CONVERSATION_JA).not.toBe("");
		expect(UNTITLED_TOPIC_JA).not.toBe("");
	});

	for (const [name, view] of [
		["bank feed", feed],
		["bank panel", panel],
	] as const) {
		test(`a Japanese ${name} shows the translated fallback inside its off-region`, async () => {
			const container = await render(view(" "));
			expect(offText(container)).toContain(UNTITLED_CONVERSATION_JA);
			expect(container.textContent).not.toContain("Untitled conversation");
		});

		test(`a Japanese ${name} keeps a real title that matches a catalog string`, async () => {
			const container = await render(view("Settings"));
			expect(offText(container)).toContain("Settings");
		});
	}

	test("Japanese forum categories show the translated topic fallback inside its off-region", async () => {
		const container = await render(categories(""));
		expect(offText(container)).toContain(UNTITLED_TOPIC_JA);
		expect(container.textContent).not.toContain("Untitled topic");
	});

	test("Japanese forum categories keep a real topic title", async () => {
		const container = await render(categories("Settings"));
		expect(offText(container)).toContain("Settings");
	});
});
