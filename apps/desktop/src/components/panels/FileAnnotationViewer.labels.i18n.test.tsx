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
const { FileAnnotationViewer } = await import("./FileAnnotationViewer.tsx");

// Line labels are whole sentences: no English "line 12" inside the Japanese.
const JA: Record<string, string> = {
	"Lines {start}–{end}": "{start}〜{end} 行目",
	"Remove note on lines {start}–{end}": "{start}〜{end} 行目のメモを削除",
};

const AR: Record<string, string> = {
	"Line {line}": "السطر {line}",
	"Remove note on line {line}": "إزالة الملاحظة على السطر {line}",
};

const roots: Root[] = [];

beforeEach(() => {
	registerLiteralCatalogLoader((locale) => {
		if (locale.startsWith("ja")) {
			return JA;
		}
		return locale.startsWith("ar") ? AR : {};
	});
	const text = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
	Reflect.set(window, "__TAURI_INTERNALS__", {
		invoke: () => Promise.resolve(btoa(text.join("\n"))),
		transformCallback: () => 0,
	});
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
	Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

async function renderViewer(
	locale: string,
	range: { endLine: number; startLine: number }
): Promise<HTMLElement> {
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
				<FileAnnotationViewer
					folder="/work"
					notes={[
						{
							comment: "Rename this",
							excerpt: "line 3",
							id: "n1",
							...range,
						},
					]}
					onClose={() => undefined}
					onNotesChange={() => undefined}
					onOpenExternally={() => undefined}
					path="notes.txt"
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(100);
	});
	return container;
}

test("a single-line note under ar uses the whole Arabic sentence and the locale's digits", async () => {
	const container = await renderViewer("ar", { endLine: 11, startLine: 11 });
	const digits = new Intl.NumberFormat("ar", { useGrouping: false }).format(11);
	expect(
		container.querySelector(
			`button[aria-label="إزالة الملاحظة على السطر ${digits}"]`
		)
	).not.toBeNull();
	expect(container.textContent).toContain(`السطر ${digits}`);
	expect(container.textContent).not.toContain("line 11");
});

test("a saved note's line chip and remove label render the Japanese sentence", async () => {
	const container = await renderViewer("ja", { endLine: 7, startLine: 3 });
	const remove = container.querySelector(
		'button[aria-label="3〜7 行目のメモを削除"]'
	);
	expect(remove).not.toBeNull();
	expect(container.textContent).toContain("3〜7 行目");
	expect(container.textContent).not.toContain("lines 3–7");
});
