import { afterEach, describe, expect, test } from "bun:test";
import { registerLiteralCatalogLoader } from "@ryu/i18n/core";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlanArtifact } from "@/src/lib/plan-artifacts.ts";
import { PlansList } from "./cowork-lists.tsx";

// The pinned plan rows badged a saved agent plan with the bare word "Plan",
// which every catalog reads as a billing plan (de "Tarif", ja "プラン").

// Stub catalogs: the shipped catalog has no entries for these strings yet.
const CATALOGS: Record<string, Record<string, string>> = {
	ar: { "Agent plan": "خطة الوكيل" },
	de: { "Agent plan": "Agentenplan", Error: "Fehler", Plan: "Tarif" },
	ja: { "Agent plan": "エージェントの計画", Plan: "プラン" },
};

function plan(overrides: Partial<PlanArtifact> = {}): PlanArtifact {
	return {
		artifact: {
			content: "# Ship the release",
			id: "msg-1-plan",
			kind: "space",
			sourceMessageId: "msg-1",
			title: "Ship the release",
		},
		key: "msg-1-plan",
		saved: true,
		sourceLabel: "Plan tool",
		title: "Ship the release",
		...overrides,
	};
}

function render(locale: string, plans: PlanArtifact[]): string {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith(locale) ? (CATALOGS[locale] ?? {}) : {}
	);
	return renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			initialPackId={null}
		>
			<PlansList plans={plans} />
		</I18nProvider>
	);
}

afterEach(() => registerLiteralCatalogLoader(null));

describe("PlansList badge", () => {
	test("labels a saved plan as the agent plan in English", () => {
		expect(render("en", [plan()])).toContain(">Agent plan</span>");
	});

	test("translates the badge without the billing word", () => {
		const german = render("de", [plan()]);
		expect(german).toContain(">Agentenplan</span>");
		expect(german).not.toContain("Tarif");
		const japanese = render("ja", [plan()]);
		expect(japanese).toContain(">エージェントの計画</span>");
		expect(japanese).not.toContain("プラン");
		expect(render("ar", [plan()])).toContain(">خطة الوكيل</span>");
	});

	test("translates the error badge", () => {
		expect(
			render("de", [plan({ error: "disk full", saved: false })])
		).toContain(">Fehler</span>");
	});
});
