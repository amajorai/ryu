// Fallback copy an interface writes itself follows the UI language: an
// untitled board row reads as the catalog's "Untitled thread", and the Town
// HUD legend's ends ("Busy now", "All quiet") come from the catalog rather
// than staying English.

import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	BoardColumn,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { INTERFACE_PROTOCOL_VERSION } from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import JA from "../../../../i18n/locales/ja.json" with { type: "json" };

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { I18nProvider } = await import("@ryu/i18n/react");
const { BoardListView } = await import("./board-list.tsx");
const { DataViewControl } = await import("./town-hud.tsx");
const { EMPTY_THEME, townPalette } = await import("./town-palette.ts");

// The shipped Japanese pack, plus stand-ins for keys the coordinator has not
// translated yet so the test does not depend on catalog timing.
const JA_PACK: Readonly<Record<string, string>> = JA;
const catalog: Readonly<Record<string, string>> = {
	...JA_PACK,
	"All quiet": JA_PACK["All quiet"] ?? "静かです",
	"Busy now": JA_PACK["Busy now"] ?? "混雑中",
};

let mounted: { container: HTMLElement; root: Root } | undefined;

async function render(node: ReactNode): Promise<HTMLElement> {
	registerLiteralCatalogLoader((locale) =>
		locale.startsWith("ja") ? catalog : {}
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
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container;
}

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

const UNTITLED: InterfaceThread = {
	agentIds: [],
	id: "thread-blank",
	lastMessage: null,
	lastMessageRole: null,
	messageCount: 0,
	pinned: false,
	projectId: null,
	running: false,
	teamId: null,
	title: "  ",
	updatedAt: new Date(Date.now() - 60_000).toISOString(),
};

const SNAPSHOT: InterfaceSnapshot = {
	agents: [],
	groups: [],
	threads: [UNTITLED],
	version: INTERFACE_PROTOCOL_VERSION,
};

const COLUMN: BoardColumn = {
	agentId: null,
	groupId: null,
	id: "column-all",
	label: "All",
	status: null,
	threadIds: [UNTITLED.id],
};

test("an untitled board row shows the Japanese fallback title", async () => {
	expect(catalog["Untitled thread"]).toBeTruthy();
	const root = await render(
		<BoardListView
			collapsedIds={new Set()}
			columns={[COLUMN]}
			compact={false}
			groupedByProject={false}
			now={Date.now()}
			onOpen={() => undefined}
			onStart={() => undefined}
			onToggle={() => undefined}
			selectedThreadId={null}
			snapshot={SNAPSHOT}
			tabStopThreadId={null}
			threadsById={new Map([[UNTITLED.id, UNTITLED]])}
		/>
	);
	const text = root.textContent ?? "";
	expect(text).toContain(catalog["Untitled thread"] ?? "");
	expect(text).not.toContain("Untitled thread");
});

test("the Town HUD legend ends come from the catalog", async () => {
	const palette = townPalette(EMPTY_THEME);
	const needs = await render(
		<DataViewControl
			onChange={() => undefined}
			palette={palette}
			value="needs"
		/>
	);
	expect(needs.textContent).toContain(catalog["All quiet"] ?? "");
	expect(needs.textContent).not.toContain("All quiet");
	// "Settled" keeps its payouts sense and is no longer the legend's word.
	expect(needs.textContent).not.toContain(catalog.Settled ?? "Settled");
	unmountCurrent();
	const activity = await render(
		<DataViewControl
			onChange={() => undefined}
			palette={palette}
			value="activity"
		/>
	);
	expect(activity.textContent).toContain(catalog["Busy now"] ?? "");
	expect(activity.textContent).not.toContain("Busy now");
});

function unmountCurrent(): void {
	if (mounted) {
		const { container, root } = mounted;
		act(() => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
}
