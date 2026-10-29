/** Page-derived context shared by browser-hosted Ryu assistant surfaces. */
export interface BrowserPageContext {
	selection: string | null;
	text: string;
	title: string;
	url: string;
}

/**
 * Marks assistant-owned DOM, including popups portaled to `<body>`. Marked
 * subtrees are excluded from page capture and cannot replace the page selection.
 */
export const ASSISTANT_WIDGET_SELECTOR = "[data-ryu-assistant-widget]";

const EXCLUDED_SELECTORS = [
	"script",
	"style",
	"noscript",
	"template",
	"[hidden]",
	"[inert]",
	'[aria-hidden="true"]',
	ASSISTANT_WIDGET_SELECTOR,
	"#ryu-extension-root",
	"#ryu-copilot-root",
].join(",");

const BLOCK_TAGS = new Set([
	"ADDRESS",
	"ARTICLE",
	"ASIDE",
	"BLOCKQUOTE",
	"BR",
	"DD",
	"DIV",
	"DL",
	"DT",
	"FIELDSET",
	"FIGCAPTION",
	"FIGURE",
	"FOOTER",
	"FORM",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"HEADER",
	"HR",
	"LI",
	"MAIN",
	"NAV",
	"OL",
	"P",
	"SECTION",
	"TABLE",
	"TR",
	"UL",
]);

const INTERACTIVE_SELECTOR =
	'a,button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="menuitem"]';

function normalizeText(text: string): string {
	return text
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function referencedText(element: Element, attribute: string): string {
	const ids = element.getAttribute(attribute)?.trim().split(/\s+/) ?? [];
	return ids
		.map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

function associatedLabel(element: Element): string {
	const view = element.ownerDocument.defaultView ?? globalThis;
	const labels =
		element instanceof view.HTMLInputElement ||
		element instanceof view.HTMLSelectElement ||
		element instanceof view.HTMLTextAreaElement ||
		element instanceof view.HTMLButtonElement ||
		element instanceof view.HTMLMeterElement ||
		element instanceof view.HTMLOutputElement ||
		element instanceof view.HTMLProgressElement
			? element.labels
			: null;
	return labels
		? Array.from(labels)
				.map((label) => label.textContent ?? "")
				.join(" ")
				.replace(/\s+/g, " ")
				.trim()
		: "";
}

function explicitAccessibleName(element: Element): string {
	return (
		referencedText(element, "aria-labelledby") ||
		element.getAttribute("aria-label")?.trim() ||
		associatedLabel(element) ||
		(element.tagName === "IMG" ? element.getAttribute("alt")?.trim() : "") ||
		""
	);
}

function accessibleDescription(element: Element): string {
	return referencedText(element, "aria-describedby");
}

function isHidden(element: Element): boolean {
	if (element.matches(EXCLUDED_SELECTORS)) {
		return true;
	}
	const style = element.ownerDocument.defaultView?.getComputedStyle(element);
	return (
		style?.display === "none" ||
		style?.visibility === "hidden" ||
		style?.contentVisibility === "hidden"
	);
}

function visibleAccessibleText(
	root: Element,
	excludedRoot?: Element | null
): string {
	const parts: string[] = [];

	const visit = (node: Node): void => {
		if (node.nodeType === 3) {
			parts.push(node.textContent ?? "");
			return;
		}
		const view = node.ownerDocument?.defaultView ?? globalThis;
		if (!(node instanceof view.Element)) {
			return;
		}

		const element = node;
		if (
			element === excludedRoot ||
			(excludedRoot?.contains(element) ?? false) ||
			isHidden(element)
		) {
			return;
		}

		const tag = element.tagName;
		if (element instanceof view.HTMLDialogElement && !element.open) {
			return;
		}

		if (element instanceof view.HTMLDetailsElement && !element.open) {
			const summary = Array.from(element.children).find(
				(child) => child.tagName === "SUMMARY"
			);
			if (summary) {
				visit(summary);
			}
			return;
		}

		if (element.matches(INTERACTIVE_SELECTOR)) {
			const name =
				explicitAccessibleName(element) ||
				element.getAttribute("placeholder")?.trim() ||
				element.getAttribute("title")?.trim() ||
				(tag === "IMG" ? element.getAttribute("alt")?.trim() : "") ||
				"";
			const description = accessibleDescription(element);
			const content =
				name &&
				(element.getAttribute("aria-label") ||
					element.hasAttribute("aria-labelledby"))
					? name
					: Array.from(element.childNodes)
							.map((child) => {
								const start = parts.length;
								visit(child);
								return parts.splice(start).join("");
							})
							.join("");
			if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
				parts.push(name);
			} else {
				parts.push(content || name);
			}
			parts.push(description);
			if (BLOCK_TAGS.has(tag)) {
				parts.push("\n");
			}
			return;
		}

		if (tag === "IMG") {
			parts.push(element.getAttribute("alt")?.trim() ?? "");
			return;
		}

		const name = explicitAccessibleName(element);
		if (name) {
			parts.push(name);
			parts.push(" ");
		}
		for (const child of element.childNodes) {
			visit(child);
		}
		if (BLOCK_TAGS.has(tag)) {
			parts.push("\n");
		}
	};

	visit(root);
	return normalizeText(parts.join(""));
}

/**
 * Read a page selection, including selected input text when the browser
 * exposes it. Text selected inside assistant-owned DOM (the composer, the
 * transcript, or a portaled context preview) is never page selection.
 */
export function readBrowserPageSelection(
	documentRef: Document = document
): string | null {
	const active = documentRef.activeElement;
	const view = documentRef.defaultView ?? globalThis;
	if (
		(active instanceof view.HTMLInputElement ||
			active instanceof view.HTMLTextAreaElement) &&
		!isInsideAssistantWidget(active)
	) {
		const input = active;
		const supportsTextSelection =
			active instanceof view.HTMLTextAreaElement ||
			["text", "search", "tel", "url"].includes(active.type);
		if (
			supportsTextSelection &&
			input.selectionStart !== null &&
			input.selectionEnd !== null &&
			input.selectionEnd > input.selectionStart
		) {
			return (
				input.value.slice(input.selectionStart, input.selectionEnd).trim() ||
				null
			);
		}
	}
	const selection = documentRef.getSelection?.();
	if (
		isInsideAssistantWidget(selection?.anchorNode) ||
		isInsideAssistantWidget(selection?.focusNode)
	) {
		return null;
	}
	return selection?.toString().trim() || null;
}

/** Whether a node sits inside assistant-owned DOM, including portaled popups. */
export function isInsideAssistantWidget(
	node: Node | null | undefined
): boolean {
	if (!node) {
		return false;
	}
	const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
	return Boolean(element?.closest(ASSISTANT_WIDGET_SELECTOR));
}

function isTextControl(element: Element | null): boolean {
	return element?.tagName === "TEXTAREA" || element?.tagName === "INPUT";
}

/**
 * Whether the current selection change came from the assistant itself (its
 * composer, chips, or a portaled context preview) rather than the page. Such
 * changes must keep the stored page selection: focusing a preview places a
 * caret in it, and its text is not something the visitor selected on the page.
 */
export function isAssistantSelectionChange(
	documentRef: Document = document
): boolean {
	const selection = documentRef.getSelection?.();
	if (
		isInsideAssistantWidget(selection?.anchorNode) ||
		isInsideAssistantWidget(selection?.focusNode)
	) {
		return true;
	}
	const active = documentRef.activeElement;
	if (!isInsideAssistantWidget(active)) {
		return false;
	}
	return isTextControl(active) || !readBrowserPageSelection(documentRef);
}

/**
 * Capture readable page text and selection. The caller may pass a stored
 * selection because focusing an assistant composer collapses the page range.
 */
export function captureBrowserPageContext(
	documentRef: Document = document,
	excludedRoot?: Element | null,
	selection?: string | null
): BrowserPageContext {
	const root =
		documentRef.querySelector("main") ??
		documentRef.querySelector("article") ??
		documentRef.body;
	const title = documentRef.title || documentRef.location?.href || "";
	const url = documentRef.location?.href ?? "";
	return {
		selection:
			selection === undefined
				? readBrowserPageSelection(documentRef)
				: selection?.trim() || null,
		text: root ? visibleAccessibleText(root, excludedRoot) : "",
		title,
		url,
	};
}
