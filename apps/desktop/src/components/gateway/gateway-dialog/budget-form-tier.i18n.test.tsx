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
const { AlertTierSelect, alertTierOptions } = await import("./budget-form.tsx");

// The budget-rule tier picker shows one whole message per tier in its trigger,
// so a catalog translates "Silent — no notification (default)" as a unit
// instead of meeting a runtime-joined English label. The DOM localizer is off,
// so the component itself must translate.
const DE: Record<string, string> = {
	"Warn — in-app notification only": "Warnen — nur In-App-Benachrichtigung",
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

test("each tier option is one whole literal message, in severity order", () => {
	const seen: string[] = [];
	const options = alertTierOptions((source) => {
		seen.push(source);
		return `«${source}»`;
	});
	expect(options.map((option) => option.value)).toEqual([
		"silent",
		"warn",
		"fanout",
		"email",
	]);
	expect(options[0]?.label).toBe("«Silent — no notification (default)»");
	expect(seen.every((source) => source.includes(" — "))).toBe(true);
});

test("the German trigger shows the translated whole tier option", async () => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("de") ? DE : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="de"
				initialPackId={null}
			>
				<AlertTierSelect id="tier" onChange={() => undefined} value="warn" />
			</I18nProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(50);
	});
	const text = container.textContent ?? "";
	expect(text).toContain("Warnen — nur In-App-Benachrichtigung");
	expect(text).not.toContain("In-app notification only");
});
