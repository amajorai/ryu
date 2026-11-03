import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ProfileStatsSummary } from "./profile-settings-types.ts";

// The Lifetime tiles count streak days with an ICU plural and format agent
// hours with the page language's decimal separator.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { ProfileStatsPanel } = await import(
	"./profile-settings-stats-panel.tsx"
);

const DAYS = "{count, plural, one {# day} other {# days}}";
const CATALOGS: Record<string, Record<string, string>> = {
	ar: {
		[DAYS]:
			"{count, plural, zero {# يوم} one {يوم واحد} two {يومان} few {# أيام} many {# يومًا} other {# يوم}}",
	},
	de: { [DAYS]: "{count, plural, one {# Tag} other {# Tage}}" },
};

const SUMMARY: ProfileStatsSummary = {
	level: 3,
	pointsBalance: 0,
	streak: { current: 1, longest: 3 },
	totals: {
		agentSeconds: 45_000,
		costMicroUsd: 0,
		inputTokens: 0,
		outputTokens: 0,
		requestCount: 0,
		sessionCount: 0,
	},
	xp: 0,
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

async function lifetimeIn(locale: string): Promise<string> {
	registerLiteralCatalogLoader(
		(requested) => CATALOGS[requested.split("-")[0] ?? ""] ?? {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<ProfileStatsPanel summary={SUMMARY} />
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container.textContent ?? "";
}

test("English counts one streak day in the singular", async () => {
	const text = await lifetimeIn("en");
	expect(text).toContain("1 day");
	expect(text).not.toContain("1 days");
	expect(text).toContain("3 days");
	expect(text).toContain("12.5");
});

test("German uses its plural forms and decimal comma", async () => {
	const text = await lifetimeIn("de");
	expect(text).toContain("1 Tag");
	expect(text).toContain("3 Tage");
	expect(text).toContain("12,5");
	expect(text).not.toContain("12.5");
	expect(text).not.toMatch(/\d days/);
});

test("Arabic picks the right plural form for each count", async () => {
	const text = await lifetimeIn("ar");
	expect(text).toContain("يوم واحد");
	expect(text).toMatch(/[3٣] أيام/);
	expect(text).not.toMatch(/\d days/);
});
