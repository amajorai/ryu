import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// Editor chrome inside the editable is skipped by the DOM localizer (it
// protects user text), so the islands translate their own copy with tl().
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { Plate, PlateContent, usePlateEditor } = await import("platejs/react");
const { DateKit } = await import("../plugins/date-kit.tsx");
const { BlockPlaceholderKit } = await import(
	"../plugins/block-placeholder-kit.tsx"
);
const { formatCommentDate } = await import("./comment-shared.ts");

const JA: Record<string, string> = {
	"Pick a date": "日付を選択",
	"Type something…": "何か入力…",
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

async function mountInJapanese(node: ReactNode): Promise<HTMLElement> {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				{node}
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container;
}

function EmptyDateEditor() {
	const editor = usePlateEditor({
		plugins: DateKit,
		value: [
			{
				type: "p",
				children: [
					{ text: "" },
					{ type: "date", children: [{ text: "" }] },
					{ text: "" },
				],
			},
		],
	});
	return (
		<Plate editor={editor}>
			<PlateContent />
		</Plate>
	);
}

test("an empty date node prompts in the reader's language", async () => {
	const container = await mountInJapanese(<EmptyDateEditor />);
	expect(container.textContent).toContain("日付を選択");
	expect(container.textContent).not.toContain("Pick a date");
});

function PlaceholderEditor({
	onReady,
}: {
	onReady: (focus: () => void) => void;
}) {
	const editor = usePlateEditor({
		plugins: BlockPlaceholderKit,
		value: [
			{ type: "p", children: [{ text: "Written by the user" }] },
			{ type: "p", children: [{ text: "" }] },
		],
	});
	onReady(() => {
		editor.tf.select({ path: [1, 0], offset: 0 });
		editor.tf.focus();
	});
	return (
		<Plate editor={editor}>
			<PlateContent />
		</Plate>
	);
}

test("the empty-block placeholder renders in the reader's language", async () => {
	let focus: () => void = () => undefined;
	const container = await mountInJapanese(
		<PlaceholderEditor
			onReady={(next) => {
				focus = next;
			}}
		/>
	);
	await act(async () => {
		focus();
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	const placeholders = Array.from(container.querySelectorAll("[placeholder]"));
	expect(placeholders.map((node) => node.getAttribute("placeholder"))).toEqual([
		"何か入力…",
	]);
	expect(container.textContent).toContain("Written by the user");
});

test("comment timestamps follow the reader's locale", () => {
	const now = Date.now();
	expect(formatCommentDate(new Date(now - 5 * 60_000), "en")).toBe("5m");
	expect(formatCommentDate(new Date(now - 3 * 3_600_000), "en")).toBe("3h");
	expect(formatCommentDate(new Date(now - 5 * 3_600_000), "ko")).toBe("5시간");
	const old = new Date(2026, 2, 4);
	expect(formatCommentDate(old, "en-US")).toBe("3/4/26");
	expect(formatCommentDate(old, "de")).toBe("04.03.26");
});
