/**
 * Build the design-canvas document. The canvas is rendered in a same-origin
 * iframe WITHOUT `allow-scripts`, so the host can attach editing listeners
 * while nothing authored in the document can run next to the host bridge.
 * Scripts are also removed from the copy, and a CSP blocks network loads.
 */
import { type HtmlParser, NODE_ATTRIBUTE, ROOT_NODE_ID } from "./core.ts";

export const CANVAS_SANDBOX = "allow-same-origin";
export const SELECTED_ATTRIBUTE = "data-ryu-selected";
export const DROP_ATTRIBUTE = "data-ryu-drop";

const CANVAS_POLICY =
	"default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

// A before/after drop eases the hovered node and its neighbour 6px apart on
// that side, opening the gap the dropped node will fill; "inside" tints the
// container instead.
const CANVAS_STYLE = `
[${NODE_ATTRIBUTE}]:not([${NODE_ATTRIBUTE}="${ROOT_NODE_ID}"]):hover { outline: 1px dashed #6366f1; outline-offset: 1px; cursor: default; }
[${SELECTED_ATTRIBUTE}] { outline: 2px solid #4f46e5 !important; outline-offset: 1px; }
[${DROP_ATTRIBUTE}="before"], [${DROP_ATTRIBUTE}="after"] + *, :has(+ [${DROP_ATTRIBUTE}="before"]), [${DROP_ATTRIBUTE}="after"] { transition: translate 180ms cubic-bezier(0.16, 1, 0.3, 1); }
[${DROP_ATTRIBUTE}="before"], [${DROP_ATTRIBUTE}="after"] + * { translate: 0 6px; }
:has(+ [${DROP_ATTRIBUTE}="before"]), [${DROP_ATTRIBUTE}="after"] { translate: 0 -6px; }
@media (prefers-reduced-motion: reduce) { [${DROP_ATTRIBUTE}], [${DROP_ATTRIBUTE}] + *, :has(+ [${DROP_ATTRIBUTE}]) { transition: none; } }
[${DROP_ATTRIBUTE}="inside"] { box-shadow: inset 0 0 0 2px #4f46e5; background-color: rgb(79 70 229 / 0.06); }
[contenteditable="true"] { outline: 2px solid #f59e0b !important; cursor: text; }
body[${NODE_ATTRIBUTE}] { min-height: 100vh; }
`;

export function canvasDocument(
	annotatedHtml: string,
	parser: HtmlParser
): string {
	const document = parser.parseFromString(annotatedHtml, "text/html");
	for (const element of document.querySelectorAll(
		"script, base, meta[http-equiv], iframe, object, embed"
	)) {
		element.remove();
	}
	for (const element of document.querySelectorAll("*")) {
		for (const attribute of Array.from(element.attributes)) {
			if (attribute.name.toLowerCase().startsWith("on")) {
				element.removeAttribute(attribute.name);
			}
		}
	}
	for (const element of document.querySelectorAll(`[${NODE_ATTRIBUTE}]`)) {
		if (element.getAttribute(NODE_ATTRIBUTE) !== ROOT_NODE_ID) {
			element.setAttribute("draggable", "true");
		}
	}
	const policy = document.createElement("meta");
	policy.setAttribute("http-equiv", "Content-Security-Policy");
	policy.setAttribute("content", CANVAS_POLICY);
	document.head.prepend(policy);
	const style = document.createElement("style");
	style.textContent = CANVAS_STYLE;
	document.head.append(style);
	return `<!doctype html>\n${document.documentElement.outerHTML}`;
}
