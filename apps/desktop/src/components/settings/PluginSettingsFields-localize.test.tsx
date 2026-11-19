import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LiteralMessage } from "@ryu/i18n/react";
import type { PluginSettingsTab } from "@/src/lib/pluginSettings.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider, useLiteralMessages } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { parseSettingsTabs } = await import("@/src/lib/pluginSettings.ts");
const { localizeSettingsTab } = await import(
	"./PluginSettingsFields-localize.ts"
);

// Core's own Memory plugin ships its "Memory behaviour" tab from a Core-only
// manifest, not a store one; its copy is catalogued like any store manifest.
const MEMORY_MANIFEST = new URL(
	"../../../../core/src/plugin_manifest/fixtures/memory.manifest.json",
	import.meta.url
);

const JA: Record<string, string> = {
	"Memory behaviour": "メモリの動作",
	"Minimum relevance": "最小関連度",
	"Off — always add the closest facts (default)":
		"オフ — 常に最も近い事実を追加 (既定)",
	"Low — skip clearly unrelated facts": "低 — 明らかに無関係な事実をスキップ",
};

function memoryBehaviourTab(): PluginSettingsTab {
	const manifest = JSON.parse(readFileSync(MEMORY_MANIFEST, "utf8")) as {
		contributes: { settings_tabs: Record<string, unknown>[] };
	};
	const raw = manifest.contributes.settings_tabs.map((tab) => ({
		...tab,
		plugin: "memory",
	}));
	const tab = parseSettingsTabs(raw).find(
		(entry) => entry.id === "memory.behavior"
	);
	if (!tab) {
		throw new Error("memory.manifest.json has no memory.behavior tab");
	}
	return tab;
}

async function localizeInJapanese(
	tab: PluginSettingsTab
): Promise<PluginSettingsTab> {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	let localized: PluginSettingsTab = tab;
	function Probe() {
		const tl: LiteralMessage = useLiteralMessages();
		localized = localizeSettingsTab(tl, tab);
		return null;
	}
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				<Probe />
			</I18nProvider>
		);
	});
	// Let the catalog load and the provider re-render with it.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	await act(async () => root.unmount());
	container.remove();
	return localized;
}

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

test("the Core Memory behaviour tab renders its manifest copy in Japanese", async () => {
	const tab = memoryBehaviourTab();
	expect(tab.title).toBe("Memory behaviour");

	const localized = await localizeInJapanese(tab);
	expect(localized.title).toBe("メモリの動作");
	const relevance = localized.fields.find(
		(field) => field.prefKey === "memory.recall-min-relevance"
	);
	expect(relevance?.label).toBe("最小関連度");
	expect(relevance?.options.map((option) => option.label)).toEqual([
		"オフ — 常に最も近い事実を追加 (既定)",
		"低 — 明らかに無関係な事実をスキップ",
		"Medium — only reasonably close matches",
		"High — only close matches",
	]);
	// Uncatalogued copy passes through as English, and values never change.
	expect(relevance?.options.map((option) => option.value)).toEqual(
		tab.fields
			.find((field) => field.prefKey === "memory.recall-min-relevance")
			?.options.map((option) => option.value)
	);
	expect(
		localized.fields.find((field) => field.prefKey === "memory.recall-mode")
			?.label
	).toBe("Recall mode");
});
