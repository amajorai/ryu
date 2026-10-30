import { DROP_ATTRIBUTE } from "./canvas.ts";
import {
	canContainChildren,
	type DropPosition,
	dropPositionFor,
	NODE_ATTRIBUTE,
	ROOT_NODE_ID,
	type VisualOperation,
} from "./core.ts";
import {
	BLOCK_MIME,
	clearDropMarks,
	NODE_MIME,
	nodeFromEvent,
} from "./visual-editor-config.ts";

export interface VisualCanvasHandlers {
	apply: (operations: VisualOperation[], select?: string | null) => boolean;
	dropOperations: (
		dragged: { block?: string; node?: string },
		overId: string,
		position: DropPosition
	) => VisualOperation[] | null;
	setSelectedId: (id: string | null) => void;
	working: string;
}

/** Wires the canvas iframe document to the editor through `handlers`. */
export function attachCanvasListeners(
	frameDocument: Document,
	handlers: { readonly current: VisualCanvasHandlers }
): void {
	let dragSource: string | null = null;
	const position = (node: Element, clientY: number): DropPosition => {
		const box = node.getBoundingClientRect();
		return dropPositionFor(
			clientY - box.top,
			box.height,
			canContainChildren(node.tagName)
		);
	};
	frameDocument.addEventListener("click", (event) => {
		event.preventDefault();
		const node = nodeFromEvent(event.target);
		// SAFETY: the native HTML editing mixin may be absent on SVG/MathML.
		// This optional field view preserves that absent read and its negation.
		if (
			node &&
			!(node as Element & Partial<ElementContentEditable>).isContentEditable
		) {
			handlers.current.setSelectedId(node.getAttribute(NODE_ATTRIBUTE));
		}
	});
	frameDocument.addEventListener("dblclick", (event) => {
		// SAFETY: the parsed text/html canvas supplies native HTML, SVG or MathML
		// elements with focus/events; optional HTML editing fields preserve non-HTML
		// absent properties and the original assignments, without an HTML brand gate.
		const node = nodeFromEvent(event.target) as
			| (Element &
					Partial<ElementContentEditable> &
					HTMLOrSVGElement &
					GlobalEventHandlers)
			| null;
		const id = node?.getAttribute(NODE_ATTRIBUTE);
		if (!(node && id) || id === ROOT_NODE_ID || node.children.length > 0) {
			return;
		}
		const original = node.textContent ?? "";
		node.contentEditable = "true";
		node.focus();
		const finish = (save: boolean) => {
			node.contentEditable = "false";
			const text = node.textContent ?? "";
			if (save && text !== original) {
				handlers.current.apply([{ kind: "setText", nodeId: id, text }], id);
			} else {
				node.textContent = original;
			}
		};
		node.addEventListener("blur", () => finish(true), { once: true });
		node.addEventListener("keydown", (keyEvent: KeyboardEvent) => {
			if (keyEvent.key === "Enter" && !keyEvent.shiftKey) {
				keyEvent.preventDefault();
				node.blur();
			} else if (keyEvent.key === "Escape") {
				node.textContent = original;
				node.blur();
			}
		});
	});
	frameDocument.addEventListener("dragstart", (event) => {
		const node = nodeFromEvent(event.target);
		const id = node?.getAttribute(NODE_ATTRIBUTE);
		if (!(id && event.dataTransfer) || id === ROOT_NODE_ID) {
			event.preventDefault();
			return;
		}
		dragSource = id;
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData(NODE_MIME, id);
	});
	frameDocument.addEventListener("dragend", () => {
		dragSource = null;
		clearDropMarks(frameDocument);
	});
	frameDocument.addEventListener("dragover", (event) => {
		const node = nodeFromEvent(event.target);
		const types = event.dataTransfer?.types ?? [];
		if (!(node && (types.includes(NODE_MIME) || types.includes(BLOCK_MIME)))) {
			return;
		}
		const where = position(node, event.clientY);
		const overId = node.getAttribute(NODE_ATTRIBUTE) ?? "";
		const allowed = handlers.current.dropOperations(
			dragSource ? { node: dragSource } : { block: "section" },
			overId,
			where
		);
		clearDropMarks(frameDocument);
		if (allowed) {
			event.preventDefault();
			node.setAttribute(
				DROP_ATTRIBUTE,
				overId === ROOT_NODE_ID ? "inside" : where
			);
		}
	});
	frameDocument.addEventListener("dragleave", (event) => {
		if (event.target === frameDocument.documentElement) {
			clearDropMarks(frameDocument);
		}
	});
	frameDocument.addEventListener("drop", (event) => {
		event.preventDefault();
		clearDropMarks(frameDocument);
		const node = nodeFromEvent(event.target);
		const overId = node?.getAttribute(NODE_ATTRIBUTE);
		if (!(node && overId && event.dataTransfer)) {
			return;
		}
		const nodeId = event.dataTransfer.getData(NODE_MIME) || undefined;
		const block = event.dataTransfer.getData(BLOCK_MIME) || undefined;
		const operations = handlers.current.dropOperations(
			{ node: nodeId, block },
			overId,
			position(node, event.clientY)
		);
		if (operations) {
			handlers.current.apply(operations, nodeId ?? null);
		}
	});
}
