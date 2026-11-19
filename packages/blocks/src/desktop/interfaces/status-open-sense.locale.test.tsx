// "Open" as a status (an open job, the chef's open orders) reads through the
// keyed `status.open`. The bare catalog word is the open verb (ja 開く).
import { expect, test } from "bun:test";
import { I18nRuntime } from "@ryu/i18n/core";
import { I18nProvider } from "@ryu/i18n/react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// The provider registers its runtime here; a test registers its own.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";
import { jobStatusLabel } from "./jobs-model-core.ts";
import { JobStatusPill } from "./jobs-parts.tsx";
import type { KitchenStation } from "./kitchen-model.ts";
import { KitchenPanel } from "./kitchen-panel.tsx";

/** Stand-in for the verb sense of the bare catalog row. */
const OVERLAYS = { ja: { Open: "開く" } };

const STATION: KitchenStation = {
	agent: {
		avatarUrl: null,
		description: "Line cook",
		id: "agent-ada",
		name: "Ada",
		status: "idle",
	},
	burnt: false,
	column: 0,
	index: 0,
	kind: "stove",
	orders: [],
	row: 0,
	runStartedAt: null,
	typicalFromHistory: false,
	typicalMs: 60_000,
	working: false,
	x: 0,
	z: 0,
};

function render(locale: string, node: ReactNode): string {
	return renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			manageDocument={false}
			overlays={OVERLAYS}
		>
			{node}
		</I18nProvider>
	);
}

function chefSheet(locale: string): string {
	return render(
		locale,
		<KitchenPanel
			headingRef={null}
			onBack={undefined}
			onClose={() => undefined}
			onOpen={() => undefined}
			onOrder={() => undefined}
			threadView={null}
			view={{ kind: "chef", orders: [], station: STATION }}
		/>
	);
}

test("the Japanese job pill names the open status, not the verb", () => {
	const html = render("ja", <JobStatusPill status="open" />);
	expect(html).toContain("オープン");
	expect(html).not.toContain("開く");
});

test("the German chef sheet counts open orders as Offen", () => {
	const html = chefSheet("de");
	expect(html).toContain("Offen");
	expect(html).not.toContain("Öffnen");
});

test("English keeps the Open label", () => {
	expect(render("en", <JobStatusPill status="open" />)).toContain(">Open<");
	expect(chefSheet("en")).toContain("Open");
});

test("the job detail's status row reads the open status in Japanese", () => {
	const runtime = new I18nRuntime([], { initialPackId: "official/ja" });
	registerActiveI18nRuntime(runtime);
	try {
		expect(jobStatusLabel("open")).toBe("オープン");
	} finally {
		unregisterActiveI18nRuntime(runtime);
	}
});
