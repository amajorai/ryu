import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { Plate, PlateContent, usePlateEditor } = await import("platejs/react");
const { IndentKit } = await import("./indent-kit.tsx");
const { IndentToolbarButton, OutdentToolbarButton } = await import(
	"../ui/indent-toolbar-button.tsx"
);
const { Toolbar } = await import("../ui/toolbar.tsx");

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
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

async function mount(node: ReactNode): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(node);
	});
	return container;
}

function IndentedEditor({ children }: { children?: ReactNode }) {
	const editor = usePlateEditor({
		plugins: IndentKit,
		value: [
			{ type: "p", indent: 2, children: [{ text: "Indented twice" }] },
			{ type: "p", children: [{ text: "Not indented" }] },
		],
	});
	return (
		<Plate editor={editor}>
			{children}
			<PlateContent />
		</Plate>
	);
}

function blockStyle(container: HTMLElement, text: string): string {
	const block = Array.from(
		container.querySelectorAll<HTMLElement>("[data-slate-node='element']")
	).find((node) => node.textContent === text);
	if (!block) {
		throw new Error(`No block renders "${text}"`);
	}
	return block.getAttribute("style") ?? "";
}

test("indented blocks use the inline-start margin so RTL indents from the right", async () => {
	const container = await mount(<IndentedEditor />);
	const style = blockStyle(container, "Indented twice");
	expect(style).toContain("margin-inline-start: 48px");
	expect(style).not.toContain("margin-left");
	expect(blockStyle(container, "Not indented")).not.toContain("margin");
});

test("indent and outdent icons mirror in RTL", async () => {
	const container = await mount(
		<IndentedEditor>
			<Toolbar>
				<IndentToolbarButton />
				<OutdentToolbarButton />
			</Toolbar>
		</IndentedEditor>
	);
	const icons = Array.from(container.querySelectorAll("button svg"));
	expect(icons).toHaveLength(2);
	for (const icon of icons) {
		expect(icon.getAttribute("class") ?? "").toContain("rtl:-scale-x-100");
	}
});
