// Labels spliced into translated sentences ("{label} (Esc)", "{label}, {badge}
// need you", a widget's title in its controls) are translated first, so a
// Japanese reader never meets an English label inside a Japanese sentence.
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import { I18nProvider } from "@ryu/i18n/react";
import {
	INTERFACE_PROTOCOL_VERSION,
	type InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// The provider registers its runtime here; the module-level `tr` reads it.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}

const { BankThreadPanel } = await import("./bank-panel.tsx");
const { DashboardInterface } = await import("./dashboard-interface.tsx");
const { NotebookSidebar } = await import("./notebook-sidebar.tsx");

afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

const JA: Record<string, string> = {
	"Close thread": "スレッドを閉じる",
	Home: "ホーム",
	"Your turn": "あなたの番",
	"{label} (Esc)": "{label} (Esc)",
	"{label}, {badge} need you": "{label}、{badge} 件の対応待ち",
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

const EMPTY: InterfaceSnapshot = {
	agents: [],
	groups: [],
	threads: [],
	version: INTERFACE_PROTOCOL_VERSION,
};

describe("labels inside translated sentences", () => {
	test("the bank panel's close button names itself in Japanese", () => {
		const html = render(
			<BankThreadPanel
				agentsLabel={null}
				headingRef={{ current: null }}
				onBack={null}
				onClose={() => undefined}
				thread={undefined}
				threadView={null}
			/>
		);
		expect(html).toContain('title="スレッドを閉じる (Esc)"');
		expect(html).toContain('aria-label="スレッドを閉じる"');
	});

	test("the notebook's Home row reads its label in Japanese", () => {
		const html = render(
			<NotebookSidebar
				activeThreadId={null}
				expanded={new Set()}
				focusRequest={null}
				homeActive
				loading
				needsYouCount={2}
				onClose={() => undefined}
				onHome={() => undefined}
				onNewPage={() => undefined}
				onOpen={() => undefined}
				onQueryChange={() => undefined}
				onSetExpanded={() => undefined}
				onStart={() => undefined}
				overlay={false}
				query=""
				sections={[]}
				snapshot={EMPTY}
			/>
		);
		expect(html).toContain('aria-label="ホーム、2 件の対応待ち"');
	});

	test("a dashboard widget's title is translated before it is shown", () => {
		const runtime = {
			direction: "ltr" as const,
			locale: "ja",
			translate: (_id: string, values?: MessageValuesInput, fallback = "") =>
				formatMessage(JA[fallback] ?? fallback, values ?? {}, "ja"),
		};
		registerActiveI18nRuntime(runtime);
		const html = render(
			<DashboardInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={{
					closeThread: () => undefined,
					openThread: () => undefined,
					startThread: () => undefined,
				}}
				snapshot={{
					...EMPTY,
					agents: [
						{
							avatarUrl: null,
							description: "",
							id: "a1",
							name: "Ada",
							status: "idle",
						},
					],
					threads: [
						{
							agentIds: ["a1"],
							id: "t1",
							lastMessage: "Done",
							lastMessageRole: "assistant",
							messageCount: 2,
							pinned: false,
							projectId: null,
							running: false,
							teamId: null,
							title: "Plan",
							updatedAt: new Date().toISOString(),
						},
					],
				}}
				threadView={null}
			/>
		);
		unregisterActiveI18nRuntime(runtime);
		expect(html).toContain('id="dashboard-widget-your-turn">あなたの番</h2>');
	});
});
