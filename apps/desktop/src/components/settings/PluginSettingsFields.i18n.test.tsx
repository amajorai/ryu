import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import type { PluginSettingsTab } from "@/src/lib/pluginSettings.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { PluginSettingsFields } = await import("./PluginSettingsFields.tsx");

// Manifest copy (here the action-summary plugin's settings tab) is catalogued
// as exact literals; the tab renders it through the active locale.
const JA: Record<string, string> = {
	"Action summaries": "アクションの要約",
	"Explain thinking and tool actions": "思考とツールの操作を説明",
	"Show one plain-language line for each surfaced thinking block and tool call.":
		"表示される思考ブロックとツール呼び出しごとに、わかりやすい説明を 1 行表示します。",
};

const TABS: PluginSettingsTab[] = [
	{
		id: "action-summary",
		title: "Action summaries",
		plugin: "com.fixture",
		enabled: true,
		scope: "user",
		fields: [
			{
				type: "toggle",
				label: "Explain thinking and tool actions",
				prefKey: "fixture.explain",
				options: [],
			},
			{
				type: "textarea",
				label: "Fixture notes",
				description:
					"Show one plain-language line for each surfaced thinking block and tool call.",
				prefKey: "fixture.notes",
				options: [],
			},
			{
				type: "text",
				label: "Uncatalogued {name} label",
				prefKey: "fixture.raw",
				options: [],
			},
		],
	},
];

const realFetch = globalThis.fetch;
const roots: Root[] = [];

beforeEach(() => {
	globalThis.fetch = Object.assign(
		async () => Response.json({ key: "fixture", value: "true" }),
		{ preconnect: realFetch.preconnect }
	);
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
	globalThis.fetch = realFetch;
});

async function mountInJapanese(): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				<PluginSettingsFields
					tabs={TABS}
					target={{ url: "https://one.fixture", token: "one-token" }}
				/>
			</I18nProvider>
		);
	});
	// Let the literal catalog load and the preference reads settle.
	await act(async () => {
		await Bun.sleep(50);
	});
	return container;
}

test("renders a catalogued manifest label, description and tab title in Japanese", async () => {
	const container = await mountInJapanese();
	const text = container.textContent ?? "";
	expect(text).toContain("アクションの要約");
	expect(text).toContain("思考とツールの操作を説明");
	expect(text).toContain(
		"表示される思考ブロックとツール呼び出しごとに、わかりやすい説明を 1 行表示します。"
	);
	expect(text).not.toContain("Explain thinking and tool actions");
	expect(
		container.querySelector('[aria-label="思考とツールの操作を説明"]')
	).not.toBeNull();
});

test("keeps uncatalogued manifest copy with braces verbatim", async () => {
	const container = await mountInJapanese();
	expect(container.textContent ?? "").toContain("Uncatalogued {name} label");
});
