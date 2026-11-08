import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { ComposerSettingsMenu } = await import("./composer-settings-menu.tsx");

type Section = Parameters<typeof ComposerSettingsMenu>[0]["sections"][number];

const section = (
	key: string,
	items: { id: string; name: string }[],
	value: string,
	variant?: Section["variant"]
): Section => ({
	ariaLabel: key,
	items,
	key,
	label: key,
	onChange: () => undefined,
	value,
	variant,
});

const SECTIONS: Section[] = [
	section("agent", [{ id: "ryu", name: "Ryu" }], "ryu"),
	section("model", [{ id: "opus", name: "Opus 5.5" }], "opus"),
	section(
		"effort",
		[
			{ id: "medium", name: "Medium" },
			{ id: "high", name: "High" },
		],
		"high",
		"slider"
	),
];

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.replaceChildren();
});

async function triggerName(locale: string): Promise<string | null> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
			>
				<ComposerSettingsMenu sections={SECTIONS} />
			</I18nProvider>
		);
	});
	const name =
		container
			.querySelector("[data-composer-settings-trigger]")
			?.getAttribute("aria-label") ?? null;
	await act(async () => {
		root.unmount();
	});
	return name;
}

test("the trigger's accessible name is one translated sentence", async () => {
	registerLiteralCatalogLoader(
		(locale): Record<string, string> =>
			locale.startsWith("ja")
				? {
						"Chat settings: {settings}": "チャット設定: {settings}",
						"{model} ({effort})": "{model}（{effort}）",
						High: "高",
					}
				: {}
	);
	const name = await triggerName("ja");
	expect(name?.startsWith("チャット設定: ")).toBe(true);
	expect(name).toContain("Ryu");
	expect(name).toContain("Opus 5.5（高）");
	expect(name).not.toContain("Chat settings");
	expect(name).not.toContain("High");
	expect(name).not.toContain(" · ");
});

test("English reads the settings as a list after one label", async () => {
	expect(await triggerName("en")).toBe("Chat settings: Ryu, Opus 5.5 (High)");
});

test("Arabic joins the settings as an Arabic list", async () => {
	registerLiteralCatalogLoader(
		(locale): Record<string, string> =>
			locale.startsWith("ar")
				? {
						"Chat settings: {settings}": "إعدادات الدردشة: {settings}",
						"{model} ({effort})": "{model} ({effort})",
						High: "مرتفع",
					}
				: {}
	);
	// Interpolated values are wrapped in Unicode isolates (FSI/PDI) for RTL.
	const name = (await triggerName("ar"))?.replace(/[\u2068\u2069]/gu, "");
	expect(name).toBe(
		`إعدادات الدردشة: ${new Intl.ListFormat("ar", { type: "unit" }).format(["Ryu", "Opus 5.5 (مرتفع)"])}`
	);
	expect(name).toContain("Ryu و");
	expect(name).not.toContain("High");
});
