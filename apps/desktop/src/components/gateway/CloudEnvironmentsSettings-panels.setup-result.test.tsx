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
const { SetupResultDialog } = await import(
	"./CloudEnvironmentsSettings-panels.tsx"
);

// The exit sentence used to be baked into the `<pre>` the DOM localizer skips;
// it now renders as its own translated line above the verbatim output.
const JA: Record<string, string> = {
	"Setup exited with code {code}": "セットアップはコード {code} で終了しました",
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

test("translates the exit-code sentence and keeps the output verbatim", async () => {
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
				<SetupResultDialog
					result={{ exitCode: 2, output: "npm ERR! missing script\n" }}
					setResult={() => undefined}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(50);
	});
	const text = document.body.textContent ?? "";
	expect(text).toContain("セットアップはコード 2 で終了しました");
	expect(text).not.toContain("Setup exited with code");
	const pre = document.body.querySelector("pre");
	expect(pre?.textContent).toBe("npm ERR! missing script\n");
	expect(pre?.getAttribute("dir")).toBe("ltr");
});
