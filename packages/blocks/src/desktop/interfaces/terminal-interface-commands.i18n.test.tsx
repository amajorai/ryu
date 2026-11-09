import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import {
	INTERFACE_PROTOCOL_VERSION,
	type InterfacePort,
	type InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/*
 * Terminal lines are whole translated sentences: a Japanese reader sees
 * "Build pipeline を開きました", never "opened Build pipeline" (whose bare
 * "opened" the DOM localizer used to render as 開封済み), and a German reader
 * sees the team name inside the sentence the catalog wrote.
 */

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { TerminalInterface } = await import("./terminal-interface.tsx");

const GROUP_KEY =
	"started a thread in {kind, select, team {team {name}} other {project {name}}}";

const CATALOGS: Record<string, Record<string, string>> = {
	ar: {
		[GROUP_KEY]:
			"بدأ سلسلة في {kind, select, team {الفريق {name}} other {المشروع {name}}}",
		"Opened {title}": "فُتح {title}",
	},
	de: {
		[GROUP_KEY]:
			"Thread im {kind, select, team {Team {name}} other {Projekt {name}}} gestartet",
	},
	ja: {
		[GROUP_KEY]:
			"{kind, select, team {チーム {name}} other {プロジェクト {name}}} でスレッドを開始しました",
		"Closed {title}": "{title} を閉じました",
		"Did you mean {command}?": "{command} のことですか？",
		"new: no agent, team, or project @{handle}":
			"new: @{handle} というエージェント、チーム、プロジェクトはありません",
		"Opened {title}": "{title} を開きました",
		"started a new thread": "新しいスレッドを開始しました",
		"started a thread with {handle}": "{handle} とのスレッドを開始しました",
		"Try {command}": "{command} を試してください",
	},
};

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "Research",
			id: "agent-atlas",
			name: "Atlas",
			status: "idle",
		},
	],
	groups: [
		{
			id: "team-launch",
			kind: "team",
			memberAgentIds: ["agent-atlas"],
			name: "Launch Crew",
		},
	],
	threads: [
		{
			agentIds: ["agent-atlas"],
			id: "thread-build",
			lastMessage: "Done",
			lastMessageRole: "assistant",
			messageCount: 2,
			pinned: false,
			projectId: null,
			running: false,
			teamId: null,
			title: "Build pipeline",
			updatedAt: "2026-10-12T12:00:00Z",
		},
	],
	version: INTERFACE_PROTOCOL_VERSION,
};

const PORT: InterfacePort = {
	closeThread: () => undefined,
	openThread: () => undefined,
	startThread: () => undefined,
};

let mounted: { container: HTMLElement; root: Root } | undefined;
async function unmount() {
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => root.unmount());
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

const terminal = (locale: string, threadView: string | null) => (
	<I18nProvider initialLocale={locale} initialPackId={null}>
		<TerminalInterface
			activeThreadId={threadView ? "thread-build" : null}
			loading={false}
			params={{}}
			port={PORT}
			snapshot={SNAPSHOT}
			threadView={threadView}
		/>
	</I18nProvider>
);

async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
}

async function mountIn(
	locale: string,
	threadView: string | null = null
): Promise<HTMLElement> {
	registerLiteralCatalogLoader(
		(requested) => CATALOGS[requested.slice(0, 2)] ?? {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => root.render(terminal(locale, threadView)));
	await settle();
	return container;
}

/** Type a command into the prompt and press Enter. */
async function run(container: HTMLElement, command: string) {
	const input = container.querySelector("input");
	if (!(input instanceof HTMLInputElement)) {
		throw new Error("Expected the terminal prompt");
	}
	const setValue = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		input.focus();
		setValue?.call(input, command);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
	await act(async () => {
		input.form?.dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true })
		);
	});
}

/** The last printed line, as text and as its emphasised segments. */
function lastLine(container: HTMLElement) {
	const lines = [...container.querySelectorAll("p.whitespace-pre-wrap")];
	const last = lines.at(-1);
	return {
		primary: [...(last?.querySelectorAll(".text-primary") ?? [])].map(
			(node) => node.textContent
		),
		text: last?.textContent ?? "",
	};
}

test("starting a thread prints whole Japanese sentences with the target emphasised", async () => {
	const container = await mountIn("ja");

	await run(container, "new @atlas check the build");
	const agent = lastLine(container);
	expect(agent.text).toBe("→ @atlas とのスレッドを開始しました");
	expect(agent.primary).toEqual(["@atlas"]);

	await run(container, "new check the build");
	expect(lastLine(container).text).toBe("→ 新しいスレッドを開始しました");

	await run(container, "new @launch-crew ship it");
	const group = lastLine(container);
	expect(group.text).toBe("→ チーム Launch Crew でスレッドを開始しました");
	expect(group.primary).toEqual(["Launch Crew"]);

	expect(container.textContent).not.toContain("started a");
});

test("an unknown handle suggests close handles inside the Japanese question", async () => {
	const container = await mountIn("ja");
	await run(container, "new @atlax hello");
	const unknown = lastLine(container);
	expect(unknown.text).toContain("@atlas のことですか？");
	expect(unknown.primary).toEqual(["@atlas"]);
	expect(unknown.text).not.toContain("did you mean");
});

test("opening and closing a thread reads as a Japanese sentence, never 開封済み", async () => {
	const container = await mountIn("ja");
	await run(container, "ls");
	await run(container, "open 1");
	const opened = lastLine(container).text;
	expect(opened).toBe("#1 Build pipeline を開きました");
	expect(container.textContent).not.toContain("開封済み");
	expect(container.textContent).not.toContain("opened");

	await unmount();
	const closing = await mountIn("ja", "HOST-THREAD-VIEW");
	await run(closing, "close");
	expect(lastLine(closing).text).toBe("Build pipeline を閉じました");
	expect(closing.textContent).not.toContain("closed");
});

test("the team or project word comes from the German sentence, not the raw kind", async () => {
	const container = await mountIn("de");
	await run(container, "new @launch-crew ship it");
	const group = lastLine(container);
	expect(group.text).toBe("→ Thread im Team Launch Crew gestartet");
	expect(group.primary).toEqual(["Launch Crew"]);
});

test("an Arabic line isolates the left-to-right name it emphasises", async () => {
	const container = await mountIn("ar");
	await run(container, "ls");
	await run(container, "open 1");
	expect(lastLine(container).text).toBe("فُتح \u2068#1 Build pipeline\u2069");
	await run(container, "new @launch-crew ship it");
	const group = lastLine(container);
	expect(group.text).toBe("→ بدأ سلسلة في الفريق \u2068Launch Crew\u2069");
	expect(group.primary).toEqual(["Launch Crew"]);
});

test("English keeps the terminal's own wording", async () => {
	const container = await mountIn("en");
	await run(container, "ls");
	await run(container, "open 1");
	expect(lastLine(container).text).toBe("Opened #1 Build pipeline");
	await run(container, "new @launch-crew ship it");
	expect(lastLine(container).text).toBe(
		"→ started a thread in team Launch Crew"
	);
});
