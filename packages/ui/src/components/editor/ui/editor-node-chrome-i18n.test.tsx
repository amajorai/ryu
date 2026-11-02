import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import type { Value } from "platejs";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// The DOM localizer skips everything under [contenteditable="true"] so it never
// rewrites what the user typed. Editor chrome rendered inside the editable
// (contentEditable={false} islands included) therefore has to translate its
// own copy with tl(). These tests record both halves of that contract.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { I18nRuntime, registerLiteralCatalogLoader } = await import(
	"@ryu/i18n/core"
);
const { localizeDomRoot } = await import("@ryu/i18n/react");
const { Plate, PlateContent, usePlateEditor } = await import("platejs/react");
const { TocKit } = await import("../plugins/toc-kit.tsx");
const { ToggleKit } = await import("../plugins/toggle-kit.tsx");
const { MediaKit } = await import("../plugins/media-kit.tsx");
const { TableResizeContext } = await import("./table-node-resize-context.ts");
const { TableCellResizeControls } = await import(
	"./table-node-resize-controls.tsx"
);
const { CodeBlockKit } = await import("../plugins/code-block-kit.tsx");

const JA: Record<string, string> = {
	"Add an image": "画像を追加",
	"Add a video": "動画を追加",
	"Create a heading to display the table of contents.":
		"見出しを作成すると目次が表示されます。",
	Expand: "展開",
	Collapse: "折りたたむ",
	Agents: "エージェント",
	"Plain Text": "プレーンテキスト",
	"Resize column": "列のサイズを変更",
	"Resize row": "行のサイズを変更",
	"Resize table left margin": "表の左余白のサイズを変更",
};

const settle = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});

let cleanup: (() => Promise<void> | void) | undefined;
afterEach(async () => {
	registerLiteralCatalogLoader(null);
	await cleanup?.();
	cleanup = undefined;
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function mountInJapanese(node: ReactNode): Promise<HTMLElement> {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root: Root = createRoot(container);
	cleanup = async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	};
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				{node}
			</I18nProvider>
		);
	});
	await settle();
	return container;
}

test("the DOM localizer leaves copy inside an editable untouched", async () => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	container.innerHTML = [
		'<p id="outside">Agents</p>',
		'<div contenteditable="true">',
		'<p id="typed">Agents</p>',
		'<div contenteditable="false">',
		'<span id="island" aria-label="Agents">Agents</span>',
		"</div>",
		"</div>",
	].join("");
	document.body.append(container);
	const runtime = new I18nRuntime([], {
		initialLocale: "ja",
		initialPackId: null,
	});
	const stop = localizeDomRoot(runtime, container);
	cleanup = () => {
		stop();
		container.remove();
	};
	await settle();

	expect(container.querySelector("#outside")?.textContent).toBe("エージェント");
	// User text and editor islands alike stay as rendered.
	expect(container.querySelector("#typed")?.textContent).toBe("Agents");
	const island = container.querySelector("#island");
	expect(island?.textContent).toBe("Agents");
	expect(island?.getAttribute("aria-label")).toBe("Agents");
});

function NodeEditor({
	plugins,
	value,
}: {
	plugins: NonNullable<Parameters<typeof usePlateEditor>[0]>["plugins"];
	value: Value;
}) {
	const editor = usePlateEditor({ plugins, value });
	return (
		<Plate editor={editor}>
			<PlateContent />
		</Plate>
	);
}

test("an empty table of contents prompts in the reader's language", async () => {
	const container = await mountInJapanese(
		<NodeEditor
			plugins={TocKit}
			value={[{ type: "toc", children: [{ text: "" }] }]}
		/>
	);
	expect(container.querySelector('[contenteditable="true"]')).not.toBeNull();
	expect(container.textContent).toContain(
		"見出しを作成すると目次が表示されます。"
	);
	expect(container.textContent).not.toContain("Create a heading");
});

test("the toggle button names its action in the reader's language", async () => {
	const container = await mountInJapanese(
		<NodeEditor
			plugins={ToggleKit}
			value={[{ type: "toggle", id: "t1", children: [{ text: "Details" }] }]}
		/>
	);
	const button = container.querySelector("button[aria-expanded]");
	expect(button?.getAttribute("aria-label")).toBe("展開");
});

test("media placeholders invite uploads in the reader's language", async () => {
	const container = await mountInJapanese(
		<NodeEditor
			plugins={MediaKit}
			value={[
				{
					type: "placeholder",
					mediaType: "img",
					id: "m1",
					children: [{ text: "" }],
				},
				{
					type: "placeholder",
					mediaType: "video",
					id: "m2",
					children: [{ text: "" }],
				},
			]}
		/>
	);
	expect(container.textContent).toContain("画像を追加");
	expect(container.textContent).toContain("動画を追加");
	expect(container.textContent).not.toContain("Add an");
});

test("table resize handles are named in the reader's language", async () => {
	const noop = () => undefined;
	const context = {
		clearResizePreview: noop,
		colSizes: [120],
		disableMarginLeft: false,
		marginLeft: 0,
		minColumnWidth: 48,
		resizeBy: noop,
		setResizePreview: noop,
		startResize: noop,
	};
	// The first cell carries every focusable handle.
	const container = await mountInJapanese(
		<div contentEditable={true} suppressContentEditableWarning={true}>
			<TableResizeContext.Provider value={context}>
				<TableCellResizeControls colIndex={0} rowIndex={0} />
			</TableResizeContext.Provider>
		</div>
	);
	const labels = Array.from(
		container.querySelectorAll('[role="separator"]'),
		(handle) => handle.getAttribute("aria-label")
	);
	expect(labels).toEqual([
		"列のサイズを変更",
		"行のサイズを変更",
		"表の左余白のサイズを変更",
	]);
});

test("a plain code block's language button reads in the reader's language", async () => {
	const container = await mountInJapanese(
		<NodeEditor
			plugins={CodeBlockKit}
			value={[
				{
					type: "code_block",
					lang: "plaintext",
					children: [{ type: "code_line", children: [{ text: "ls" }] }],
				},
			]}
		/>
	);
	const trigger = container.querySelector('[role="combobox"]');
	expect(trigger?.textContent).toBe("プレーンテキスト");
});
