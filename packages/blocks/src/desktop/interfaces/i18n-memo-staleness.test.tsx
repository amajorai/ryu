// memo() stickies, posters and actors, and the noticeboard's per-snapshot
// caches, keep the same props when the literal catalog arrives after the first
// render or the language changes. Each one must still re-render its translated
// accessible names in place, without a remount.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	INTERFACE_PROTOCOL_VERSION,
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { I18nProvider, useI18n, useLiteralMessages } = await import(
	"@ryu/i18n/react"
);
const { CanvasCard } = await import("./canvas-card.tsx");
const { CinemaPoster } = await import("./cinema-poster.tsx");
const { cinemaTitle } = await import("./cinema-model.ts");
const { LiveBoxArt } = await import("./live-tile.tsx");
const { LocalizedNoticeboardInterface } = await import(
	"./noticeboard-interface-localized.tsx"
);
const { AgentActor } = await import("./world-2d-actors.tsx");
const { useLocalizedSnapshot } = await import("./use-localized-snapshot.ts");

const JA: Record<string, string> = {
	"Number {rank}": "{rank} 位",
	"Talk to {name}": "{name} と話す",
	Team: "チーム",
	"Your turn": "あなたの番",
	"{count, plural, one {# note} other {# notes}}": "メモ {count} 件",
	"{title}, {status}, with {who}{open, select, yes {, open} other {}}":
		"{title}、{status}、{who} と一緒{open, select, yes {、開いています} other {}}",
};

const DE: Record<string, string> = {
	"Talk to {name}": "Mit {name} sprechen",
	"Your turn": "Du bist dran",
	"{count, plural, one {# note} other {# notes}}":
		"{count, plural, one {# Notiz} other {# Notizen}}",
};

const ADA: InterfaceAgent = {
	avatarUrl: null,
	description: "Writes the release notes",
	id: "agent-ada",
	name: "Ada",
	status: "idle",
};

const THREAD: InterfaceThread = {
	agentIds: [ADA.id],
	id: "thread-notes",
	lastMessage: "Can you check the draft?",
	lastMessageRole: "assistant",
	messageCount: 2,
	pinned: false,
	projectId: null,
	running: false,
	teamId: null,
	title: "Release notes",
	updatedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
};

const SNAPSHOT: InterfaceSnapshot = {
	agents: [ADA],
	groups: [],
	threads: [THREAD],
	version: INTERFACE_PROTOCOL_VERSION,
};

const noop = () => undefined;

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

/**
 * Mount `element` under Japanese while the catalog is still loading, then
 * let the catalog arrive. Returns the container and a resolver.
 */
async function mountBeforeCatalog(element: ReactElement) {
	let resolveCatalog: (catalog: Record<string, string>) => void = noop;
	const pending = new Promise<Record<string, string>>((resolve) => {
		resolveCatalog = resolve;
	});
	registerLiteralCatalogLoader((locale) =>
		locale.startsWith("ja") ? pending : null
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				{/* The page localizer stays out, so only a React re-render can
				    translate the copy under test. */}
				<div data-ryu-i18n="off">{element}</div>
			</I18nProvider>
		);
	});
	const arrive = async () => {
		await act(async () => {
			resolveCatalog(JA);
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
	};
	return { arrive, container };
}

function labelled(container: HTMLElement, selector: string): HTMLElement {
	const element = container.querySelector<HTMLElement>(selector);
	if (!element) {
		throw new Error(`No element matches ${selector}`);
	}
	return element;
}

describe("memoized interface copy follows the catalog", () => {
	test("a canvas sticky's accessible name updates in place", async () => {
		const { arrive, container } = await mountBeforeCatalog(
			<CanvasCard
				card={{
					agents: [ADA],
					frameId: "your-turn",
					group: undefined,
					home: { x: 0, y: 0 },
					id: THREAD.id,
					lead: ADA,
					status: "your-turn",
					thread: THREAD,
				}}
				compact={false}
				dragging={false}
				gliding={false}
				loose={false}
				now={Date.now()}
				onBlurCard={noop}
				onFocusCard={noop}
				onOpenCard={noop}
				onSelectCard={noop}
				open={false}
				selected={false}
				showGroup={false}
				x={0}
				y={0}
				z={1}
			/>
		);
		const card = labelled(container, '[data-testid="canvas-card"]');
		expect(card.getAttribute("aria-label")).toBe(
			"Release notes, Your turn, with Ada"
		);
		await arrive();
		const after = labelled(container, '[data-testid="canvas-card"]');
		expect(after).toBe(card);
		expect(after.getAttribute("aria-label")).toBe(
			"Release notes、あなたの番、Ada と一緒"
		);
	});

	test("a cinema poster's description updates in place", async () => {
		const { arrive, container } = await mountBeforeCatalog(
			<CinemaPoster
				current={false}
				layout="boxart"
				onHoverEnd={noop}
				onHoverStart={noop}
				onSelect={noop}
				rank={2}
				title={cinemaTitle(SNAPSHOT, THREAD)}
			/>
		);
		const description = labelled(container, ".sr-only");
		expect(description.textContent).toContain("Number 2");
		await arrive();
		expect(labelled(container, ".sr-only")).toBe(description);
		expect(description.textContent).toContain("2 位");
		expect(description.textContent).not.toContain("Number");
	});

	test("a world villager's talk button updates in place", async () => {
		const { arrive, container } = await mountBeforeCatalog(
			<AgentActor
				emote={false}
				entity={{
					agentId: ADA.id,
					name: ADA.name,
					status: "idle",
					threadCount: 1,
					x: 2,
					y: 2,
				}}
				indoor={false}
				margin={{ x: 0, y: 0 }}
				near={false}
				onTalk={noop}
				talking={false}
			/>
		);
		const button = labelled(container, "button");
		expect(button.getAttribute("aria-label")).toBe("Talk to Ada");
		await arrive();
		expect(labelled(container, "button")).toBe(button);
		expect(button.getAttribute("aria-label")).toBe("Ada と話す");
	});

	test("live box art's kind label updates in place", async () => {
		const { arrive, container } = await mountBeforeCatalog(
			<LiveBoxArt category={{ id: "team-docs", kind: "team", name: "Docs" }} />
		);
		expect(container.textContent).toContain("Team");
		await arrive();
		expect(container.textContent).toContain("チーム");
		expect(container.textContent).not.toContain("Team");
	});

	test("the noticeboard's summary and notes update in place", async () => {
		const { arrive, container } = await mountBeforeCatalog(
			<LocalizedNoticeboardInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={{ closeThread: noop, openThread: noop, startThread: noop }}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const note = labelled(container, '[data-noticeboard-note="thread-notes"]');
		expect(container.textContent).toContain("1 note");
		expect(note.getAttribute("aria-label")).toContain("Your turn");
		await arrive();
		expect(labelled(container, '[data-noticeboard-note="thread-notes"]')).toBe(
			note
		);
		expect(container.textContent).toContain("メモ 1 件");
		expect(container.textContent).not.toContain("1 note");
		expect(note.getAttribute("aria-label")).toContain("あなたの番");
		expect(note.getAttribute("aria-label")).not.toContain("Your turn");
	});

	test("a language switch re-renders memoized copy in place", async () => {
		registerLiteralCatalogLoader((locale) => {
			if (locale.startsWith("ja")) {
				return Promise.resolve(JA);
			}
			return locale.startsWith("de") ? Promise.resolve(DE) : null;
		});
		let switchTo: (locale: string) => void = noop;
		function Switcher() {
			const i18n = useI18n();
			switchTo = (locale) => i18n.setLocale(locale);
			return null;
		}
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		mounted = { container, root };
		const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
		await act(async () => {
			root.render(
				<I18nProvider initialLocale="ja" initialPackId={null}>
					<Switcher />
					<div data-ryu-i18n="off">
						<AgentActor
							emote={false}
							entity={{
								agentId: ADA.id,
								name: ADA.name,
								status: "idle",
								threadCount: 1,
								x: 2,
								y: 2,
							}}
							indoor={false}
							margin={{ x: 0, y: 0 }}
							near={false}
							onTalk={noop}
							talking={false}
						/>
						<LocalizedNoticeboardInterface
							activeThreadId={null}
							loading={false}
							params={{}}
							port={{ closeThread: noop, openThread: noop, startThread: noop }}
							snapshot={SNAPSHOT}
							threadView={null}
						/>
					</div>
				</I18nProvider>
			);
			await settle();
		});
		const button = labelled(container, 'button[aria-label*="Ada"]');
		const note = labelled(container, '[data-noticeboard-note="thread-notes"]');
		expect(button.getAttribute("aria-label")).toBe("Ada と話す");
		expect(note.getAttribute("aria-label")).toContain("あなたの番");
		await act(async () => {
			switchTo("de");
			await settle();
		});
		expect(labelled(container, 'button[aria-label*="Ada"]')).toBe(button);
		expect(button.getAttribute("aria-label")).toBe("Mit Ada sprechen");
		expect(labelled(container, '[data-noticeboard-note="thread-notes"]')).toBe(
			note
		);
		expect(note.getAttribute("aria-label")).toContain("Du bist dran");
		expect(container.textContent).toContain("1 Notiz");
		expect(container.textContent).not.toContain("メモ");
	});

	test("a localized snapshot is re-keyed but keeps its threads", async () => {
		const seen: InterfaceSnapshot[] = [];
		// Reading a literal is what asks the runtime for the catalog.
		function Probe() {
			seen.push(useLocalizedSnapshot(SNAPSHOT));
			return <span>{useLiteralMessages()("Team")}</span>;
		}
		const { arrive } = await mountBeforeCatalog(<Probe />);
		await arrive();
		const first = seen[0];
		const last = seen.at(-1);
		expect(first).not.toBe(SNAPSHOT);
		expect(last).not.toBe(first);
		expect(last?.threads).toBe(SNAPSHOT.threads);
		expect(last?.agents).toBe(SNAPSHOT.agents);
	});
});
