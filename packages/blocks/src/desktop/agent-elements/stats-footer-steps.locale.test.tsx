// The stats footer's "Steps" counts agent steps (de "Schritte") and reads
// through the keyed `agentStats.steps`. The bare catalog "Steps" is a stepped
// chart curve (de "Stufen").
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}

const { StatsFooter } = await import("./stats-footer.tsx");

afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

/** Stand-in for the curve sense of the bare catalog row. */
const OVERLAYS = { de: { Steps: "Stufen" } };

function stepsChip(locale: string): string {
	const html = renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			manageDocument={false}
			overlays={OVERLAYS}
		>
			<StatsFooter conversationMessages={[]} />
		</I18nProvider>
	);
	const chip = html.match(
		/data-testid="stats-steps"[^>]*><span[^>]*>([^<]*)<\/span>/
	);
	return chip?.[1] ?? html;
}

test("the German stats footer counts Schritte, not a stepped curve", () => {
	expect(stepsChip("de")).toBe("Schritte");
});

test("the Russian stats footer counts Шаги", () => {
	expect(stepsChip("ru")).toBe("Шаги");
});

test("English keeps Steps", () => {
	expect(stepsChip("en")).toBe("Steps");
});
