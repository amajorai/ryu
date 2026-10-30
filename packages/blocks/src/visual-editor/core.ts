/**
 * Framework-free core of the shared visual + chat editor.
 *
 * An editable document is ordinary HTML whose body elements carry an
 * editor-only `data-ryu-node` id. Every change, whether it comes from the
 * canvas, the layers panel, or chat, is a typed {@link VisualOperation}
 * applied through {@link editHtml}. Ids are stripped by {@link cleanHtml}, so
 * no editor machinery reaches a saved or published document.
 *
 * The node-id tree, the operation verbs, and the drop-target rules follow the
 * page-tree design of corebunch/instatic (MIT); the single action layer shared
 * by UI and agent follows BuilderIO/agent-native (MIT). No code is copied.
 */
import {
	type DropPosition,
	type DropTarget,
	type EditResult,
	FORBIDDEN_FRAGMENT,
	type HtmlParser,
	LEAF_CONTENT,
	NODE_ATTRIBUTE,
	NODE_ID,
	NON_VISUAL,
	type OutlineNode,
	ROOT_NODE_ID,
	UNSAFE_CSS,
	UNSAFE_URL,
	URL_ATTRIBUTES,
	type VisualOperation,
	VisualOperationListSchema,
	VOID,
} from "./core-schema.ts";

export type {
	DropPosition,
	DropTarget,
	EditResult,
	HtmlParser,
	OutlineNode,
	VisualOperation,
} from "./core-schema.ts";
export {
	MAX_FRAGMENT_BYTES,
	MAX_OPERATIONS,
	NODE_ATTRIBUTE,
	ROOT_NODE_ID,
	VisualOperationListSchema,
	VisualOperationSchema,
} from "./core-schema.ts";

class EditError extends Error {}

export function canContainChildren(tagName: string): boolean {
	const tag = tagName.toUpperCase();
	return !(VOID.has(tag) || NON_VISUAL.has(tag) || LEAF_CONTENT.has(tag));
}

function isEditable(element: Element): boolean {
	return !NON_VISUAL.has(element.tagName.toUpperCase());
}

function highestId(root: Element): number {
	let highest = 0;
	for (const element of root.querySelectorAll(`[${NODE_ATTRIBUTE}]`)) {
		const match = /^n(\d+)$/.exec(element.getAttribute(NODE_ATTRIBUTE) ?? "");
		if (match) {
			highest = Math.max(highest, Number(match[1]));
		}
	}
	return highest;
}

/**
 * Give every visual body element an id, keeping ids that are already present
 * and unique so selection and history survive re-renders.
 */
export function annotate(document: Document): void {
	const body = document.body;
	body.setAttribute(NODE_ATTRIBUTE, ROOT_NODE_ID);
	let next = highestId(body) + 1;
	const seen = new Set<string>([ROOT_NODE_ID]);
	for (const element of body.querySelectorAll("*")) {
		if (!isEditable(element) || element.parentElement?.closest("svg")) {
			element.removeAttribute(NODE_ATTRIBUTE);
			continue;
		}
		const current = element.getAttribute(NODE_ATTRIBUTE);
		if (current && NODE_ID.test(current) && !seen.has(current)) {
			seen.add(current);
			continue;
		}
		const id = `n${next}`;
		next += 1;
		seen.add(id);
		element.setAttribute(NODE_ATTRIBUTE, id);
	}
}

export function findNode(document: Document, id: string): Element | null {
	if (!NODE_ID.test(id)) {
		return null;
	}
	return document.querySelector(`[${NODE_ATTRIBUTE}="${id}"]`);
}

function requireNode(document: Document, id: string): Element {
	const node = findNode(document, id);
	if (!node) {
		throw new EditError(`Node ${id} no longer exists`);
	}
	return node;
}

function editableChildren(parent: Element): Element[] {
	return [...parent.children].filter((child) =>
		child.hasAttribute(NODE_ATTRIBUTE)
	);
}

function insertAt(parent: Element, nodes: Node[], position: number): void {
	const anchor = editableChildren(parent)[position] ?? null;
	for (const node of nodes) {
		parent.insertBefore(node, anchor);
	}
}

/**
 * The URL parser drops ASCII tab/LF/CR anywhere and leading C0 controls and
 * spaces, so `java\tscript:` and `\u0001javascript:` still run. Normalize the
 * same way before testing the scheme.
 */
function urlSchemeView(value: string): string {
	const stripped = value.replace(/[\t\n\r]/g, "");
	let start = 0;
	while (start < stripped.length && stripped.charCodeAt(start) <= 0x20) {
		start += 1;
	}
	return stripped.slice(start);
}

function isSafeAttribute(name: string, value: string): boolean {
	if (name.startsWith("on") || name === "srcdoc" || name === NODE_ATTRIBUTE) {
		return false;
	}
	if (name === "style") {
		return !UNSAFE_CSS.test(value);
	}
	return !(URL_ATTRIBUTES.has(name) && UNSAFE_URL.test(urlSchemeView(value)));
}

/** Remove executable or frame-escaping content from an inserted fragment. */
function sanitizeFragment(root: ParentNode): void {
	for (const element of Array.from(root.querySelectorAll("*"))) {
		if (FORBIDDEN_FRAGMENT.has(element.tagName.toUpperCase())) {
			element.remove();
			continue;
		}
		for (const attribute of Array.from(element.attributes)) {
			if (!isSafeAttribute(attribute.name.toLowerCase(), attribute.value)) {
				element.removeAttribute(attribute.name);
			}
		}
	}
}

function parseFragment(document: Document, html: string): Node[] {
	const template = document.createElement("template");
	template.innerHTML = html;
	sanitizeFragment(template.content);
	const nodes = [...template.content.childNodes];
	if (!nodes.some((node) => node.nodeType === 1 || node.textContent?.trim())) {
		throw new EditError(
			"The inserted HTML is empty after removing unsafe content"
		);
	}
	return nodes;
}

function assertContainer(parent: Element): void {
	if (!canContainChildren(parent.tagName)) {
		throw new EditError(
			`<${parent.tagName.toLowerCase()}> cannot contain other elements`
		);
	}
}

function applyOne(document: Document, operation: VisualOperation): string[] {
	switch (operation.kind) {
		case "insertHtml": {
			const parent = requireNode(document, operation.parentId);
			assertContainer(parent);
			insertAt(
				parent,
				parseFragment(document, operation.html),
				operation.index
			);
			return [operation.parentId];
		}
		case "replaceHtml": {
			if (operation.nodeId === ROOT_NODE_ID) {
				throw new EditError(
					"Replace the page's sections instead of the page body"
				);
			}
			const node = requireNode(document, operation.nodeId);
			node.replaceWith(...parseFragment(document, operation.html));
			return [operation.nodeId];
		}
		case "move": {
			const node = requireNode(document, operation.nodeId);
			const parent = requireNode(document, operation.parentId);
			if (operation.nodeId === ROOT_NODE_ID) {
				throw new EditError("The page body cannot move");
			}
			if (node === parent || node.contains(parent)) {
				throw new EditError("A node cannot move inside itself");
			}
			assertContainer(parent);
			node.remove();
			insertAt(parent, [node], operation.index);
			return [operation.nodeId];
		}
		case "setText": {
			const node = requireNode(document, operation.nodeId);
			if (node.children.length > 0) {
				throw new EditError(
					"Only elements without child elements can have their text replaced"
				);
			}
			node.textContent = operation.text;
			return [operation.nodeId];
		}
		case "setStyle": {
			// SAFETY: supported text/html HTML, SVG and MathML elements expose the native
			// inline-style mixin. This describes only the existing style operation; an
			// unsupported injected element still fails at the same missing-style access.
			const node = requireNode(document, operation.nodeId) as Element &
				ElementCSSInlineStyle;
			if (operation.value === null || operation.value.trim() === "") {
				node.style.removeProperty(operation.property);
			} else if (UNSAFE_CSS.test(operation.value)) {
				throw new EditError(`Unsafe value for ${operation.property}`);
			} else {
				node.style.setProperty(operation.property, operation.value);
			}
			if (node.getAttribute("style") === "") {
				node.removeAttribute("style");
			}
			return [operation.nodeId];
		}
		case "setAttribute": {
			const node = requireNode(document, operation.nodeId);
			const name = operation.name.toLowerCase();
			if (operation.value === null) {
				if (name !== NODE_ATTRIBUTE) {
					node.removeAttribute(name);
				}
			} else if (isSafeAttribute(name, operation.value)) {
				node.setAttribute(name, operation.value);
			} else {
				throw new EditError(
					`The ${name} attribute cannot be set to that value`
				);
			}
			return [operation.nodeId];
		}
		case "remove": {
			if (operation.nodeId === ROOT_NODE_ID) {
				throw new EditError("The page body cannot be removed");
			}
			requireNode(document, operation.nodeId).remove();
			return [operation.nodeId];
		}
		case "duplicate": {
			if (operation.nodeId === ROOT_NODE_ID) {
				throw new EditError("The page body cannot be duplicated");
			}
			const node = requireNode(document, operation.nodeId);
			// SAFETY: requireNode returns an Element, and native cloneNode preserves its
			// element node type; the base Node signature does not express that return.
			const copy = node.cloneNode(true) as Element;
			copy.removeAttribute(NODE_ATTRIBUTE);
			for (const child of copy.querySelectorAll(`[${NODE_ATTRIBUTE}]`)) {
				child.removeAttribute(NODE_ATTRIBUTE);
			}
			node.after(copy);
			return [operation.nodeId];
		}
		default:
			throw new EditError("Unknown operation");
	}
}

export function serialize(document: Document): string {
	return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

/** Parse and annotate a document. Keeps existing ids stable. */
export function prepareHtml(html: string, parser: HtmlParser): string {
	const document = parser.parseFromString(html, "text/html");
	annotate(document);
	return serialize(document);
}

/**
 * Apply operations atomically: either every operation succeeds and the new
 * annotated HTML is returned, or nothing changes and the first error is
 * reported with its position.
 */
export function editHtml(
	html: string,
	operations: readonly unknown[],
	parser: HtmlParser
): EditResult {
	const parsed = VisualOperationListSchema.safeParse(operations);
	if (!parsed.success) {
		return {
			ok: false,
			error: `Invalid edit: ${parsed.error.issues[0]?.message ?? "unknown"}`,
		};
	}
	const document = parser.parseFromString(html, "text/html");
	annotate(document);
	const affected = new Set<string>();
	for (const [position, operation] of parsed.data.entries()) {
		try {
			for (const id of applyOne(document, operation)) {
				affected.add(id);
			}
		} catch (cause) {
			const message =
				cause instanceof EditError ? cause.message : "The edit failed";
			return {
				ok: false,
				error: `Edit ${position + 1} (${operation.kind}): ${message}`,
			};
		}
	}
	annotate(document);
	return { ok: true, html: serialize(document), affected: [...affected] };
}

/** Strip editor ids. The result is what gets saved, previewed and published. */
export function cleanHtml(html: string, parser: HtmlParser): string {
	const document = parser.parseFromString(html, "text/html");
	for (const element of document.querySelectorAll(`[${NODE_ATTRIBUTE}]`)) {
		element.removeAttribute(NODE_ATTRIBUTE);
	}
	return serialize(document);
}

function describe(element: Element): string {
	const text = element.children.length === 0 ? element.textContent?.trim() : "";
	const hint =
		text ||
		element.getAttribute("aria-label") ||
		element.getAttribute("alt") ||
		element.getAttribute("id") ||
		element.getAttribute("class")?.split(/\s+/)[0] ||
		"";
	return hint.replace(/\s+/g, " ").slice(0, 60);
}

/** A bounded, flat outline used by the layers panel and chat context. */
export function outline(document: Document, maxNodes = 400): OutlineNode[] {
	const result: OutlineNode[] = [];
	const walk = (element: Element, depth: number, parentId: string | null) => {
		if (result.length >= maxNodes) {
			return;
		}
		const id = element.getAttribute(NODE_ATTRIBUTE);
		if (!id) {
			return;
		}
		const children = editableChildren(element);
		result.push({
			id,
			parentId,
			depth,
			tag: element.tagName.toLowerCase(),
			label: describe(element),
			childCount: children.length,
		});
		for (const child of children) {
			walk(child, depth + 1, id);
		}
	};
	walk(document.body, 0, null);
	return result;
}

/** Choose before/inside/after from the pointer's offset within a node's box. */
export function dropPositionFor(
	offsetY: number,
	height: number,
	container: boolean
): DropPosition {
	const ratio = height > 0 ? offsetY / height : 0.5;
	if (container) {
		if (ratio < 0.25) {
			return "before";
		}
		return ratio > 0.75 ? "after" : "inside";
	}
	return ratio < 0.5 ? "before" : "after";
}

/**
 * Resolve where a drop lands, or `null` when it is not allowed (self-drop,
 * dropping into a descendant, into a non-container, or beside the page body).
 * `draggedId` is `null` for a new block from the palette.
 */
export function resolveDrop(
	document: Document,
	draggedId: string | null,
	overId: string,
	position: DropPosition
): DropTarget | null {
	const over = findNode(document, overId);
	if (!over) {
		return null;
	}
	const dragged = draggedId ? findNode(document, draggedId) : null;
	if (draggedId && (!dragged || draggedId === ROOT_NODE_ID)) {
		return null;
	}
	if (dragged && (dragged === over || dragged.contains(over))) {
		return null;
	}
	const siblingsOf = (parent: Element) =>
		editableChildren(parent).filter((child) => child !== dragged);
	if (position === "inside" || overId === ROOT_NODE_ID) {
		if (!canContainChildren(over.tagName)) {
			return null;
		}
		return { parentId: overId, index: siblingsOf(over).length };
	}
	const parent = over.parentElement;
	const parentId = parent?.getAttribute(NODE_ATTRIBUTE);
	if (!(parent && parentId)) {
		return null;
	}
	const at = siblingsOf(parent).indexOf(over);
	return { parentId, index: position === "before" ? at : at + 1 };
}

/** Where a node sits among its editable siblings, for keyboard reordering. */
export function siblingPosition(
	document: Document,
	id: string
): { count: number; index: number; parentId: string } | null {
	const node = findNode(document, id);
	const parent = node?.parentElement;
	const parentId = parent?.getAttribute(NODE_ATTRIBUTE);
	if (!(node && parent && parentId) || id === ROOT_NODE_ID) {
		return null;
	}
	const siblings = editableChildren(parent);
	return { parentId, index: siblings.indexOf(node), count: siblings.length };
}
