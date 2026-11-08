import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider, useLiteralMessages } from "@ryu/i18n/react";
import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import AR from "../../../../i18n/locales/ar.json" with { type: "json" };
import JA from "../../../../i18n/locales/ja.json" with { type: "json" };

// Untitled threads render inside data-ryu-i18n="off" spans and as {title}
// values of translated sentences, where the DOM localizer never reaches, so
// the fallback itself must already be in the reader's language.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const {
	conversationLabel,
	newConversationLabel,
	threadDisplayTitle,
	untitledDisplayTitle,
} = await import("./thread-display-title.ts");
const { CardFace } = await import("./card-table-face.tsx");
const { GraphNodePanel, GraphThreadPanel } = await import("./graph-panel.tsx");
const { buildSheetRows } = await import("./sheet-model.ts");

const DE: Record<string, string> = {
	Conversation: "Unterhaltung",
	"New conversation": "Neue Unterhaltung",
	Untitled: "Unbenannt",
	"Untitled thread": "Unbenannter Thread",
};

const thread = (title: string): InterfaceThread =>
	({
		agentIds: [],
		id: "thread-1",
		lastMessage: null,
		messageCount: 0,
		pinned: false,
		status: "idle",
		title,
		updatedAt: "2026-11-01T10:00:00.000Z",
	}) as unknown as InterfaceThread;

const SNAPSHOT = {
	agents: [],
	groups: [],
	threads: [],
} as unknown as InterfaceSnapshot;

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

async function render(
	locale: string,
	node: ReactElement
): Promise<HTMLElement> {
	registerLiteralCatalogLoader((requested) => {
		if (requested.startsWith("de")) {
			return DE;
		}
		if (requested.startsWith("ja")) {
			return JA as Record<string, string>;
		}
		return requested.startsWith("ar") ? (AR as Record<string, string>) : {};
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				{node}
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return container;
}

function Labels({ title }: { title: string }) {
	const tl = useLiteralMessages();
	return (
		<ul>
			<li data-testid="hook">{threadDisplayTitle(thread(title), tl)}</li>
			<li data-testid="module">{threadDisplayTitle(thread(title))}</li>
			<li data-testid="untitled">{untitledDisplayTitle(title, tl)}</li>
			<li data-testid="new">{newConversationLabel(tl)}</li>
			<li data-testid="conversation">{conversationLabel()}</li>
		</ul>
	);
}

const text = (container: HTMLElement, id: string): string | null =>
	container.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;

describe("thread display fallbacks", () => {
	test("English keeps the source fallbacks and real titles pass through trimmed", async () => {
		expect(threadDisplayTitle(thread("  Launch plan "))).toBe("Launch plan");
		expect(threadDisplayTitle(thread("   "))).toBe("Untitled thread");
		expect(untitledDisplayTitle(undefined)).toBe("Untitled");
		expect(untitledDisplayTitle(" Draft ")).toBe("Draft");
		const container = await render("en", <Labels title="" />);
		expect(text(container, "hook")).toBe("Untitled thread");
		expect(text(container, "new")).toBe("New conversation");
	});

	test("German renders the catalog values through the hook and module translators", async () => {
		const container = await render("de", <Labels title=" " />);
		expect(text(container, "hook")).toBe("Unbenannter Thread");
		expect(text(container, "module")).toBe("Unbenannter Thread");
		expect(text(container, "untitled")).toBe("Unbenannt");
		expect(text(container, "new")).toBe("Neue Unterhaltung");
		expect(text(container, "conversation")).toBe("Unterhaltung");
	});

	test("a German card face shows the translated fallback inside its off-region", async () => {
		const container = await render(
			"de",
			<CardFace
				active={false}
				exposed={200}
				height={240}
				last
				now={Date.parse("2026-11-01T12:00:00.000Z")}
				snapshot={SNAPSHOT}
				thread={thread("")}
				width={170}
			/>
		);
		const off = [...container.querySelectorAll('[data-ryu-i18n="off"]')].map(
			(node) => node.textContent
		);
		expect(off).toContain("Unbenannter Thread");
		expect(container.textContent).not.toContain("Untitled thread");
	});

	test("the German graph panel names a not-yet-started conversation", async () => {
		const container = await render(
			"de",
			<GraphThreadPanel
				backLabel="Back"
				headingRef={null}
				onBack={() => undefined}
				snapshot={SNAPSHOT}
				thread={undefined}
				threadView={null}
			/>
		);
		expect(container.textContent).toContain("Neue Unterhaltung");
		expect(container.textContent).not.toContain("New conversation");
	});

	test("a German graph thread row shows the translated fallback inside its off-region", async () => {
		const container = await render(
			"de",
			<GraphNodePanel
				activeThreadId={null}
				agent={undefined}
				composerAgents={[]}
				description="Hub"
				headingRef={null}
				linkedAgents={[]}
				linkedLabel="Agents"
				node={{
					id: "you",
					kind: "you",
					label: "You",
					refId: null,
					status: "idle",
					threadCount: 1,
					x: 0,
					y: 0,
				}}
				onClose={() => undefined}
				onOpenThread={() => undefined}
				onSelectNode={() => undefined}
				onStart={() => undefined}
				snapshot={SNAPSHOT}
				threads={[thread("")]}
			/>
		);
		const off = [...container.querySelectorAll('[data-ryu-i18n="off"]')].map(
			(node) => node.textContent
		);
		expect(off).toContain("Unbenannter Thread");
		expect(container.textContent).not.toContain("Untitled thread");
	});

	test.each([
		["ja", JA as Record<string, string>],
		["ar", AR as Record<string, string>],
	])("the shipped %s catalog localizes every fallback, sheet rows included", async (locale, catalog) => {
		function SheetTitles() {
			const rows = buildSheetRows({
				...SNAPSHOT,
				threads: [thread("  ")],
			} as unknown as InterfaceSnapshot);
			return <span data-testid="sheet">{rows[0]?.title}</span>;
		}
		const container = await render(
			locale,
			<>
				<Labels title="" />
				<SheetTitles />
			</>
		);
		expect(catalog["Untitled thread"]).toBeTruthy();
		expect(text(container, "hook")).toBe(catalog["Untitled thread"] ?? null);
		expect(text(container, "module")).toBe(catalog["Untitled thread"] ?? null);
		expect(text(container, "untitled")).toBe(catalog.Untitled ?? null);
		expect(text(container, "new")).toBe(catalog["New conversation"] ?? null);
		expect(text(container, "conversation")).toBe(catalog.Conversation ?? null);
		expect(text(container, "sheet")).toBe(catalog["Untitled thread"] ?? null);
		expect(container.textContent).not.toMatch(/Untitled|New conversation/);
	});
});
