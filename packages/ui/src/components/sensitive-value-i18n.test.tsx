import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The reveal button's label prop is an English catalog literal; it must be
// translated before it fills "Reveal {label}", or the sentence mixes languages.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { SensitiveDataScope, SensitiveValue } = await import(
	"./sensitive-value.tsx"
);

const JA: Record<string, string> = {
	"all sensitive values": "すべての機密値",
	"API key": "APIキー",
	"Reveal {label}": "{label}を表示",
};

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
	registerLiteralCatalogLoader(null);
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

test("reveal labels translate the interpolated noun", async () => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				<SensitiveDataScope>
					<SensitiveValue label="API key" value="never-render-this-secret" />
				</SensitiveDataScope>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	const labels = [...container.querySelectorAll("[aria-label]")].map((node) =>
		node.getAttribute("aria-label")
	);
	expect(labels).toContain("APIキーを表示");
	expect(labels).toContain("すべての機密値を表示");
	expect(labels.join(" ")).not.toContain("API key");
	expect(container.textContent).not.toContain("never-render-this-secret");
});
