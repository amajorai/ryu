import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// Each provider row reads one balance snapshot; the reason decides the row's
// status text, which is the only thing a non-English user sees in that cell.
const SNAPSHOTS: Record<string, unknown> = {
	deepseek: {
		available: false,
		meters: [],
		providerId: "deepseek",
		reason: "token_expired",
		retryAfterSeconds: null,
	},
	moonshot: {
		available: false,
		meters: [],
		providerId: "moonshot",
		reason: "rate_limited",
		retryAfterSeconds: null,
	},
	openrouter: {
		available: false,
		meters: [],
		providerId: "openrouter",
		reason: "not_logged_in",
		retryAfterSeconds: null,
	},
};
mock.module("@/src/hooks/useProviderCredits.ts", () => ({
	useProviderCredits: (providerId: string | null) =>
		SNAPSHOTS[providerId ?? ""] ?? null,
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { ProviderCreditsCard } = await import(
	"./UsageCostSection-provider-credits.tsx"
);

const CATALOGS: Record<string, Record<string, string>> = {
	ar: { "Key rejected": "تم رفض المفتاح" },
	ja: {
		"Key rejected": "キーが拒否されました",
		"No key stored": "キーが保存されていません",
		"Rate limited": "レート制限中",
	},
};

const roots: Root[] = [];

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
});

async function renderCard(locale: string): Promise<string> {
	registerLiteralCatalogLoader((tag) => CATALOGS[tag.split("-")[0]] ?? {});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
			>
				<ProviderCreditsCard />
			</I18nProvider>
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	return container.textContent ?? "";
}

test("a Japanese card states why each balance is missing in Japanese", async () => {
	const text = await renderCard("ja");
	expect(text).toContain("キーが拒否されました");
	expect(text).toContain("キーが保存されていません");
	expect(text).toContain("レート制限中");
	expect(text).not.toContain("Key rejected");
});

test("an Arabic card states a rejected key in Arabic", async () => {
	const text = await renderCard("ar");
	expect(text).toContain("تم رفض المفتاح");
	expect(text).not.toContain("Key rejected");
});
