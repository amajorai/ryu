import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LanguagePack } from "@ryu/i18n";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { LanguageSettings } = await import("./LanguageSettings.tsx");

/*
 * A pack's Export button is named by one translated sentence, so German reads
 * "Kansai-Paket exportieren", never "Exportieren Kansai-Paket".
 */
const DE: Record<string, string> = {
	"Export {name}": "{name} exportieren",
};

const PACK: LanguagePack = {
	baseLocale: "de",
	direction: "ltr",
	enabled: true,
	id: "coverage/export-label",
	locale: "de",
	messages: {},
	name: "Kansai-Paket",
	schemaVersion: 1,
	version: "1.0.0",
};

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

async function exportLabels(locale: string): Promise<(string | null)[]> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("de") ? DE : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<MemoryRouter>
				<I18nProvider
					initialLocale={locale}
					initialPackId={null}
					packs={[PACK]}
				>
					<LanguageSettings />
				</I18nProvider>
			</MemoryRouter>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	const labels = [...container.querySelectorAll("button[aria-label]")]
		.map((button) => button.getAttribute("aria-label"))
		.filter((label) => label?.includes(PACK.name));
	await act(async () => root.unmount());
	return labels;
}

test("the pack Export button is named in German word order", async () => {
	expect(await exportLabels("de")).toEqual(["Kansai-Paket exportieren"]);
});

test("the pack Export button keeps its English name", async () => {
	expect(await exportLabels("en")).toEqual(["Export Kansai-Paket"]);
});
