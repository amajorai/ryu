import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import type { PluginSettingsField } from "@/src/lib/pluginSettings.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { sileo } = await import("sileo");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { NumberField } = await import("./PluginSettingsFields-number-field.tsx");

// A rejected number toasts "<label> — <reason>" as one whole message whose
// reason is itself translated, so neither half stays English in German.
const DE: Record<string, string> = {
	"{label} — {error}": "{label}: {error}",
	"{label} — Enter a number.": "{label}: Gib eine Zahl ein.",
	"Enter a number.": "Bitte eine Zahl eingeben.",
	"Must be {max} or less.": "Höchstens {max}.",
};

const FIELD: PluginSettingsField = {
	type: "number",
	label: "Max tokens",
	prefKey: "fixture.max_tokens",
	max: 100,
	options: [],
};

const roots: Root[] = [];
let errorTitles: string[] = [];

beforeEach(() => {
	errorTitles = [];
	spyOn(sileo, "error").mockImplementation((options) => {
		errorTitles.push(String(options.title));
		return "toast";
	});
	registerLiteralCatalogLoader((locale) => (locale.startsWith("de") ? DE : {}));
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
});

async function commitInGerman(
	raw: string,
	{ sanitized = true }: { sanitized?: boolean } = {}
): Promise<void> {
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
				<NumberField
					field={FIELD}
					pluginId="fixture.plugin"
					storedPreference="10"
					target={{ url: "https://one.fixture", token: "one-token" }}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(50);
	});
	const input = container.querySelector("input");
	if (!input) {
		throw new Error("number input did not render");
	}
	if (!sanitized) {
		// A value the DOM did not flag as badInput but that still parses to a
		// non-finite number reaches the component's own validator.
		Object.defineProperty(input, "validity", {
			configurable: true,
			value: { badInput: false, stepMismatch: false },
		});
	}
	const setValue = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		setValue?.call(input, raw);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () => {
		input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		await Bun.sleep(10);
	});
}

test("toasts an out-of-range value as one German message", async () => {
	await commitInGerman("200");
	expect(errorTitles).toEqual(["Max tokens: Höchstens 100."]);
});

test("toasts input the DOM flags as unparseable as one German message", async () => {
	await commitInGerman("1e999");
	expect(errorTitles).toEqual(["Max tokens: Gib eine Zahl ein."]);
});

test("translates the validator's non-finite reason inside the German toast", async () => {
	await commitInGerman("1e999", { sanitized: false });
	expect(errorTitles).toEqual(["Max tokens: Bitte eine Zahl eingeben."]);
});
