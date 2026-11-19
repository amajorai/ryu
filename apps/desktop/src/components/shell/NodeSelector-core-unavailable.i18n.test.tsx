import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { useCoreUnavailableLabel } = await import(
	"./NodeSelector-core-unavailable.ts"
);

// The engines, voice and toolkit rows only say why they are disabled through
// this trailing note, so it must follow the UI language.
const CATALOGS: Record<string, Record<string, string>> = {
	de: {
		"Checking…": "Wird geprüft…",
		"Unavailable — Core isn't reachable":
			"Nicht verfügbar — Core ist nicht erreichbar",
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

function Probe({ loading, steady }: { loading: boolean; steady: boolean }) {
	return <output>{useCoreUnavailableLabel(loading, steady) ?? "ready"}</output>;
}

async function renderNote(
	locale: string,
	loading: boolean,
	steady: boolean
): Promise<string> {
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
				<Probe loading={loading} steady={steady} />
			</I18nProvider>
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	return container.textContent ?? "";
}

test("a German selector says Core is unreachable in German", async () => {
	expect(await renderNote("de", false, false)).toBe(
		"Nicht verfügbar — Core ist nicht erreichbar"
	);
});

test("a German selector says it is still checking in German", async () => {
	expect(await renderNote("de", true, false)).toBe("Wird geprüft…");
});

test("English keeps the source note and a reachable Core shows none", async () => {
	expect(await renderNote("en", false, false)).toBe(
		"Unavailable — Core isn't reachable"
	);
	expect(await renderNote("de", false, true)).toBe("ready");
});
