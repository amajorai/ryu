// The context panel's "Free" row is the window's remaining room (ja "空き",
// de "Frei") and reads through the keyed `context.freeTokens`. The bare
// catalog "Free" is the price (ja "無料", de "Kostenlos").
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ContextBreakdownData } from "./context-breakdown-model.ts";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}

const { ContextBreakdownPanel } = await import("./context-breakdown.tsx");

afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

/** Stand-in for the price sense of the bare catalog row. */
const OVERLAYS = { de: { Free: "Kostenlos" }, ja: { Free: "無料" } };

const BREAKDOWN: ContextBreakdownData = {
	attributed: 1000,
	plane: "acp",
	reserveOutput: 0,
	segments: [{ kind: "messages", label: "Conversation history", tokens: 1000 }],
	window: 8000,
};

function render(locale: string): string {
	return renderToStaticMarkup(
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale={locale}
			manageDocument={false}
			overlays={OVERLAYS}
		>
			<ContextBreakdownPanel breakdown={BREAKDOWN} />
		</I18nProvider>
	);
}

function freeRowLabel(html: string): string | undefined {
	// The last summary row is the free room.
	const labels = [
		...html.matchAll(/<span class="text-muted-foreground">([^<]*)<\/span>/g),
	].map((match) => match[1]);
	return labels.at(-1);
}

test("the Japanese free row names the remaining room, not the price", () => {
	expect(freeRowLabel(render("ja"))).toBe("空き");
});

test("the German free row names the remaining room, not the price", () => {
	expect(freeRowLabel(render("de"))).toBe("Frei");
});

test("English keeps Free", () => {
	expect(freeRowLabel(render("en"))).toBe("Free");
});
