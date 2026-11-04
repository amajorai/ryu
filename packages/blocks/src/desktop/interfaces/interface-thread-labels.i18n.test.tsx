import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/*
 * Words that fill a translated sentence are translated first: a Japanese
 * reader hovering a sheet's close button sees "スレッドを閉じる（Esc）", never
 * "Close thread（Esc）", and a screen reader names a new thread
 * "スレッド: 新しいスレッド", never "スレッド: New thread".
 */

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { GameSheet } = await import("./game-shell.tsx");
const { LobbyThreadPanel } = await import("./lobby-panel.tsx");

const JA: Record<string, string> = {
	"{label} (Esc)": "{label}（Esc）",
	Back: "戻る",
	Close: "閉じる",
	"Close thread": "スレッドを閉じる",
	"New thread": "新しいスレッド",
	"Thread: {title}": "スレッド: {title}",
	"Untitled thread": "無題のスレッド",
};

const SNAPSHOT: InterfaceSnapshot = {
	agents: [],
	events: [],
	groups: [],
	threads: [],
	version: 1,
};

const UNTITLED: InterfaceThread = {
	agentIds: [],
	id: "thread-blank",
	lastMessage: null,
	lastMessageRole: "assistant",
	messageCount: 0,
	pinned: false,
	projectId: null,
	running: false,
	teamId: null,
	title: "  ",
	updatedAt: "2026-10-12T12:00:00Z",
};

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

async function renderIn(
	locale: string,
	element: ReactElement
): Promise<HTMLElement> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("ja") ? JA : {}
	);
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

const sheet = (closeLabel?: string) => (
	<GameSheet
		closeLabel={closeLabel}
		label="Sheet"
		onBack={() => undefined}
		onClose={() => undefined}
		title="Title"
	>
		{null}
	</GameSheet>
);

const titles = (container: HTMLElement) =>
	[...container.querySelectorAll("button[title]")].map((button) =>
		button.getAttribute("title")
	);

test("the GameSheet close and back tooltips translate their label in Japanese", async () => {
	const container = await renderIn("ja", sheet("Close thread"));
	expect(titles(container)).toEqual(["戻る（Esc）", "スレッドを閉じる（Esc）"]);
	const labels = [...container.querySelectorAll("button[aria-label]")].map(
		(button) => button.getAttribute("aria-label")
	);
	expect(labels).toEqual(["戻る", "スレッドを閉じる"]);
});

test("the GameSheet default close label is translated too", async () => {
	const container = await renderIn("ja", sheet());
	expect(titles(container)).toContain("閉じる（Esc）");
});

test("English stays English", async () => {
	const container = await renderIn("en", sheet("Close thread"));
	expect(titles(container)).toEqual(["Back (Esc)", "Close thread (Esc)"]);
});

test("a new thread's accessible name is wholly Japanese", async () => {
	const container = await renderIn(
		"ja",
		<LobbyThreadPanel
			headingRef={null}
			onClose={() => undefined}
			snapshot={SNAPSHOT}
			thread={undefined}
			threadView={null}
		/>
	);
	const aside = container.querySelector("aside");
	expect(aside?.getAttribute("aria-label")).toBe("スレッド: 新しいスレッド");
});

test("an untitled thread's accessible name is wholly Japanese", async () => {
	const container = await renderIn(
		"ja",
		<LobbyThreadPanel
			headingRef={null}
			onClose={() => undefined}
			snapshot={SNAPSHOT}
			thread={UNTITLED}
			threadView={null}
		/>
	);
	const aside = container.querySelector("aside");
	expect(aside?.getAttribute("aria-label")).toBe("スレッド: 無題のスレッド");
});
