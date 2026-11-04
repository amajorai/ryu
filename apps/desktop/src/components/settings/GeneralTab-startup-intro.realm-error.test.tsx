import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// The startup-realm save error is an English literal from product-mode.ts that
// the section splices into a translated sentence; a German user must read both
// halves in German. The realm hook stands in for a failed localStorage write.
const SAVE_ERROR =
	"Startup realm could not be saved. Allow local storage and retry.";
mock.module("@/src/hooks/useStartupRealm.ts", () => ({
	useStartupRealm: () => ({
		error: SAVE_ERROR,
		pendingRealm: "chat",
		realm: "last-used",
		retry: () => undefined,
		setRealm: () => undefined,
	}),
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { GeneralTabStartupIntro } = await import(
	"./GeneralTab-startup-intro.tsx"
);

const DE: Record<string, string> = {
	[SAVE_ERROR]:
		"Der Startbereich konnte nicht gespeichert werden. Erlaube lokalen Speicher und versuche es erneut.",
	"{error} Your choice isn't saved yet.":
		"{error} Deine Auswahl ist noch nicht gespeichert.",
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
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function renderAlert(locale: string): Promise<string> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("de") ? DE : {}
	);
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
				<GeneralTabStartupIntro />
			</I18nProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(25);
	});
	return container.querySelector('[role="alert"]')?.textContent ?? "";
}

test("a German user reads the whole startup-realm save error in German", async () => {
	expect(await renderAlert("de")).toBe(
		"Der Startbereich konnte nicht gespeichert werden. Erlaube lokalen Speicher und versuche es erneut. Deine Auswahl ist noch nicht gespeichert."
	);
});

test("English keeps the English sentence", async () => {
	expect(await renderAlert("en")).toBe(
		`${SAVE_ERROR} Your choice isn't saved yet.`
	);
});
