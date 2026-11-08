import { afterEach, beforeEach, expect, test } from "bun:test";
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
const { SimpleTerminal } = await import("./simple-terminal.tsx");

// The banner renders inside a `<pre>`-like output the DOM localizer skips, so
// the no-folder banner must be translated by the component itself.
const JA: Record<string, string> = {
	"Terminal\nType a command and press Enter.":
		"ターミナル\nコマンドを入力して Enter キーを押してください。",
};

const roots: Root[] = [];

beforeEach(() => {
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
});

test("translates the no-folder banner under ja", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
			>
				<SimpleTerminal cwd={null} />
			</I18nProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(50);
	});
	const text = container.textContent ?? "";
	expect(text).toContain("コマンドを入力して Enter キーを押してください。");
	expect(text).not.toContain("Type a command and press Enter.");
});
