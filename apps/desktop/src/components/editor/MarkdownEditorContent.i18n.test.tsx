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
const { MarkdownEditor } = await import("./MarkdownEditorContent.tsx");

const PLACEHOLDER_EN = "Start writing, or press / for commands…";
const PLACEHOLDER_JA = "入力を始めるか、/ を押してコマンドを表示…";

// "Settings" is UI copy the catalog knows; typed into the document it is the
// user's own words and must stay English.
const JA: Record<string, string> = {
	[PLACEHOLDER_EN]: PLACEHOLDER_JA,
	Settings: "設定",
};

async function mountInJapanese(markdown: string): Promise<{
	container: HTMLDivElement;
	unmount: () => Promise<void>;
}> {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				<MarkdownEditor
					initialMarkdown={markdown}
					onChangeMarkdown={() => undefined}
					toolbar="inline"
				/>
			</I18nProvider>
		);
	});
	// Let the catalog load and the DOM localizer pass settle.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	return {
		container,
		unmount: async () => {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

test("the empty-document placeholder renders in the reader's language", async () => {
	const { container, unmount } = await mountInJapanese("");
	const html = container.innerHTML;
	expect(html).toContain(PLACEHOLDER_JA);
	expect(html).not.toContain(PLACEHOLDER_EN);
	await unmount();
});

test("text the user typed is never rewritten by the localizer", async () => {
	const { container, unmount } = await mountInJapanese("Settings");
	const editable = container.querySelector('[contenteditable="true"]');
	expect(editable?.textContent).toContain("Settings");
	expect(editable?.textContent).not.toContain("設定");
	await unmount();
});
