import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { FormulaStatus } = await import("./ColumnEditor-formula-status.tsx");

// A malformed formula's error is a fixed catalog sentence, so the column
// editor shows it in the UI language. The status renders under
// `data-ryu-i18n="off"` so only the component's own translation counts, not
// the DOM localizer's pass over English text.
const JA: Record<string, string> = {
	"Formula is valid": "数式は有効です",
	"Missing closing quote": "閉じ引用符がありません",
};

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

async function renderStatus(expression: string): Promise<string> {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const render = (value: string) =>
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				<div data-ryu-i18n="off">
					<FormulaStatus
						columns={[{ id: "price", label: "Price" }]}
						expression={value}
					/>
				</div>
			</I18nProvider>
		);
	await act(async () => render(""));
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	// The draft changes after the catalog loaded, as typing would.
	await act(async () => render(expression));
	const text = container.textContent ?? "";
	await act(async () => root.unmount());
	container.remove();
	return text;
}

test("an unclosed quote is reported in Japanese", async () => {
	const text = await renderStatus('{Price} & "unclosed');
	expect(text).toBe("閉じ引用符がありません");
	expect(text).not.toContain("Missing closing quote");
});

test("a valid formula's confirmation is in Japanese", async () => {
	const text = await renderStatus("{Price} * 2");
	expect(text).toBe("数式は有効です");
});
