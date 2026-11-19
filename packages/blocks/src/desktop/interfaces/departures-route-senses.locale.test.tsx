// The departures route ends ("From", "To") and the arrivals board's "From"
// column read through the keyed `departures.origin` and
// `departures.destination` (ja "出発地", "到着地"). The bare catalog "From" and
// "To" are a move source and target (ja "移動元", "移動先").
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nRuntime } from "@ryu/i18n/core";
import { I18nProvider } from "@ryu/i18n/react";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { renderToStaticMarkup } from "react-dom/server";
// The provider registers its runtime here; a test registers its own.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}

const { BoardColumnHeader } = await import("./departures-board.tsx");
const { buildBoards } = await import("./departures-model.ts");
const { DeparturesPanel } = await import("./departures-panel.tsx");

afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

/** Stand-ins for the move senses of the bare catalog rows. */
const OVERLAYS = { ja: { From: "移動元", To: "移動先" } };
const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime();

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "Researcher",
			id: "agent-ada",
			name: "Ada",
			status: "working",
		},
	],
	groups: [],
	threads: [
		{
			agentIds: ["agent-ada"],
			id: "thread-live",
			lastMessage: "Working on it",
			lastMessageRole: "assistant",
			messageCount: 2,
			pinned: false,
			projectId: null,
			running: true,
			teamId: null,
			title: "Release notes",
			updatedAt: new Date(NOW - 60_000).toISOString(),
		},
	],
	version: 1,
};

function flightPanel(locale: string): string {
	const boards = buildBoards(SNAPSHOT, NOW);
	const flights = [...boards.departures, ...boards.arrivals];
	return renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			manageDocument={false}
			overlays={OVERLAYS}
		>
			<DeparturesPanel
				booking={false}
				flight={flights[0]}
				flights={flights}
				headingRef={null}
				now={NOW}
				onBook={() => undefined}
				onClose={() => undefined}
				onOpen={() => undefined}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		</I18nProvider>
	);
}

test("the Japanese flight card names the route's origin and destination", () => {
	const html = flightPanel("ja");
	expect(html).toContain(">出発地<");
	expect(html).toContain(">到着地<");
});

test("English keeps the From and To route ends", () => {
	const html = flightPanel("en");
	expect(html).toContain(">From<");
	expect(html).toContain(">To<");
});

test("the Japanese arrivals board heads its origin column 出発地", () => {
	const runtime = new I18nRuntime([], { initialPackId: "official/ja" });
	registerActiveI18nRuntime(runtime);
	try {
		const html = renderToStaticMarkup(
			<BoardColumnHeader board="arrivals" showTerminal={false} />
		);
		expect(html).toContain(">出発地<");
	} finally {
		unregisterActiveI18nRuntime(runtime);
	}
	expect(
		renderToStaticMarkup(
			<BoardColumnHeader board="arrivals" showTerminal={false} />
		)
	).toContain(">From<");
});

// The departures board's "Destination" column reads through the keyed
// `departures.destinationColumn` (ja 行き先); the bare catalog "Destination"
// is a save location (ja 保存先).
test("the Japanese departures board heads its destination column 行き先", () => {
	const runtime = new I18nRuntime([], { initialPackId: "official/ja" });
	registerActiveI18nRuntime(runtime);
	try {
		const html = renderToStaticMarkup(
			<BoardColumnHeader board="departures" showTerminal={false} />
		);
		expect(html).toContain(">行き先<");
		expect(html).not.toContain("保存先");
	} finally {
		unregisterActiveI18nRuntime(runtime);
	}
	expect(
		renderToStaticMarkup(
			<BoardColumnHeader board="departures" showTerminal={false} />
		)
	).toContain(">Destination<");
});
