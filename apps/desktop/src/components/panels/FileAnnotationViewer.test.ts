import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

const { fileTreeRowPathFromEvent } = await import("./FileAnnotationViewer.tsx");

function row(type: "file" | "folder", path: string): HTMLButtonElement {
	const element = document.createElement("button");
	element.setAttribute("data-type", "item");
	element.setAttribute("data-item-type", type);
	element.setAttribute("data-item-path", path);
	return element;
}

const pathFrom = (target: Element, ...ancestors: Element[]) =>
	fileTreeRowPathFromEvent([target, ...ancestors, document.body, window]);

test("a click anywhere inside a file row resolves to its path", () => {
	const file = row("file", "src/app.ts");
	const label = document.createElement("span");
	expect(pathFrom(label, file)).toBe("src/app.ts");
	expect(pathFrom(file)).toBe("src/app.ts");
});

test("folders, nested controls and the context menu do not open the viewer", () => {
	expect(pathFrom(row("folder", "src/"))).toBeNull();

	const actionButton = document.createElement("button");
	expect(pathFrom(actionButton, row("file", "src/app.ts"))).toBeNull();

	const renameInput = document.createElement("input");
	expect(pathFrom(renameInput, row("file", "src/app.ts"))).toBeNull();

	const menu = document.createElement("div");
	menu.setAttribute("data-file-tree-context-menu-root", "true");
	expect(pathFrom(document.createElement("button"), menu)).toBeNull();

	expect(fileTreeRowPathFromEvent([undefined, document.body])).toBeNull();
});
