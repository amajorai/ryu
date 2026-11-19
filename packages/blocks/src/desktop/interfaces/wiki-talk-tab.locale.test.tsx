// The wiki's Talk tab is the talk page (ja "ノート", de "Diskussion") and reads
// through the keyed `wiki.talkTab`. The bare catalog "Talk" is the speak verb
// (ja "話す").
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { renderToStaticMarkup } from "react-dom/server";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}

const { WikiInterface } = await import("./wiki-interface.tsx");

afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

/** Stand-in for the verb sense of the bare catalog row. */
const OVERLAYS = { ja: { Talk: "話す" } };

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "Researcher",
			id: "agent-ada",
			name: "Ada",
			status: "idle",
		},
	],
	groups: [],
	threads: [
		{
			agentIds: ["agent-ada"],
			id: "thread-1",
			lastMessage: "Notes",
			lastMessageRole: "assistant",
			messageCount: 2,
			pinned: false,
			projectId: null,
			running: false,
			teamId: null,
			title: "Release notes",
			updatedAt: "2026-10-12T12:00:00Z",
		},
	],
	version: 1,
};

function render(locale: string): string {
	return renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			manageDocument={false}
			overlays={OVERLAYS}
		>
			<WikiInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={{
					closeThread: () => undefined,
					openThread: () => undefined,
					startThread: () => undefined,
				}}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		</I18nProvider>
	);
}

test("the Japanese wiki names the talk page tab ノート, not the verb", () => {
	const html = render("ja");
	expect(html).toContain(">ノート<");
	expect(html).not.toContain(">話す<");
});

test("the German wiki names the talk page tab Diskussion", () => {
	expect(render("de")).toContain(">Diskussion<");
});

test("English keeps the Talk tab", () => {
	expect(render("en")).toContain(">Talk<");
});
