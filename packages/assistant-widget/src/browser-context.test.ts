import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	captureBrowserPageContext,
	isAssistantSelectionChange,
	isInsideAssistantWidget,
	readBrowserPageSelection,
} from "./browser-context.ts";

let registeredHere = false;
beforeEach(() => {
	if (!GlobalRegistrator.isRegistered) {
		GlobalRegistrator.register({ url: "https://example.test/article" });
		registeredHere = true;
	}
});
afterEach(() => {
	if (registeredHere) {
		GlobalRegistrator.unregister();
	}
	registeredHere = false;
});
interface ElementOptions {
	active?: boolean;
	attributes?: Record<string, string>;
	display?: string;
	selectionEnd?: number;
	selectionStart?: number;
	value?: string;
}
function makeDocument() {
	const doc = document;
	doc.title = "Accessible article";
	doc.body.replaceChildren();
	const element = (
		tag: string,
		props: ElementOptions = {},
		nested: (Element | Text)[] = []
	) => {
		const node = doc.createElement(tag);
		for (const [name, value] of Object.entries(props.attributes ?? {})) {
			node.setAttribute(name, value);
		}
		if (props.display) {
			node.style.display = props.display;
		}
		node.append(...nested);
		if (
			node instanceof HTMLInputElement ||
			node instanceof HTMLTextAreaElement
		) {
			if (props.value !== undefined) {
				node.value = props.value;
			}
			if (
				props.selectionStart !== undefined &&
				props.selectionEnd !== undefined
			) {
				node.setSelectionRange(props.selectionStart, props.selectionEnd);
			}
		}
		if (props.active) {
			doc.body.append(node);
			node.focus();
		}
		return node;
	};
	const setMain = (children: (Element | Text)[]) =>
		doc.body.replaceChildren(element("main", {}, children));
	setMain([]);
	return { document: doc, element, setMain };
}
function text(value: string): Text {
	return document.createTextNode(value);
}

describe("browser page context", () => {
	test("reads visible page text and accessible names while skipping hidden and injected UI", () => {
		const { document, element, setMain } = makeDocument();
		setMain([
			element("h1", {}, [text("Article heading")]),
			element("button", { attributes: { "aria-label": "Share article" } }, [
				text("decorative icon"),
			]),
			element(
				"input",
				{
					attributes: { "aria-label": "Email address", type: "email" },
					value: "reader@example.test",
				},
				[]
			),
			element("input", {
				attributes: { "aria-label": "Password", type: "password" },
				value: "never include this",
			}),
			element("p", { attributes: { "aria-hidden": "true" } }, [
				text("hidden decoration"),
			]),
			element("p", { display: "none" }, [text("display none")]),
			element("div", { attributes: { "data-ryu-assistant-widget": "" } }, [
				text("assistant interface"),
			]),
			element("img", { attributes: { alt: "A chart of monthly totals" } }),
		]);

		const context = captureBrowserPageContext(document);
		expect(context).toMatchObject({
			title: "Accessible article",
			url: "https://example.test/article",
			selection: null,
		});
		expect(context.text).toContain("Article heading");
		expect(context.text).toContain("Share article");
		expect(context.text).toContain("Email address");
		expect(context.text).toContain("A chart of monthly totals");
		expect(context.text).not.toContain("decorative icon");
		expect(context.text).not.toContain("reader@example.test");
		expect(context.text).not.toContain("never include this");
		expect(context.text).not.toContain("hidden decoration");
		expect(context.text).not.toContain("display none");
		expect(context.text).not.toContain("assistant interface");
	});

	test("reads selected text from a text field without reading password selections", () => {
		const { document, element } = makeDocument();
		element(
			"textarea",
			{ active: true, selectionEnd: 7, selectionStart: 4, value: "one two" },
			[]
		);
		expect(readBrowserPageSelection(document)).toBe("two");

		const inputDocument = makeDocument();
		inputDocument.element(
			"input",
			{
				active: true,
				attributes: { type: "text" },
				selectionEnd: 7,
				selectionStart: 4,
				value: "one two",
			},
			[]
		);
		expect(readBrowserPageSelection(inputDocument.document)).toBe("two");

		const passwordDocument = makeDocument();
		passwordDocument.element(
			"input",
			{
				active: true,
				attributes: { type: "password" },
				selectionEnd: 7,
				selectionStart: 0,
				value: "secret",
			},
			[]
		);
		expect(readBrowserPageSelection(passwordDocument.document)).toBeNull();
	});

	test("treats selection changes inside marked assistant DOM, including portaled popups, as the assistant's own", () => {
		const { document, element, setMain } = makeDocument();
		const pageText = text("Page passage");
		const paragraph = element("p", {}, [pageText]);
		setMain([paragraph]);
		const popupText = text("Selected text");
		const popup = element(
			"div",
			{ attributes: { "data-ryu-assistant-widget": "true" } },
			[element("h2", {}, [popupText])]
		);
		document.body.append(popup);

		expect(isInsideAssistantWidget(popupText)).toBe(true);
		expect(isInsideAssistantWidget(pageText)).toBe(false);
		expect(isInsideAssistantWidget(null)).toBe(false);

		const selection = document.getSelection();
		selection?.selectAllChildren(paragraph);
		expect(isAssistantSelectionChange(document)).toBe(false);

		// Clicking static popup text collapses the document caret into the popup.
		selection?.collapse(popupText, 3);
		expect(isAssistantSelectionChange(document)).toBe(true);

		// A focused assistant text control never supplies the page selection.
		selection?.removeAllRanges();
		const preview = element("textarea", {
			selectionEnd: 8,
			selectionStart: 0,
			value: "Selected text",
		});
		popup.append(preview);
		preview.focus();
		expect(isAssistantSelectionChange(document)).toBe(true);
	});

	test("never reads text selected inside assistant DOM as the page selection", () => {
		const { document, element, setMain } = makeDocument();
		const pageText = text("Page passage");
		const paragraph = element("p", {}, [pageText]);
		setMain([paragraph]);
		const transcriptText = text("Earlier assistant answer");
		const widget = element(
			"div",
			{ attributes: { "data-ryu-assistant-widget": "true" } },
			[element("p", {}, [transcriptText])]
		);
		document.body.append(widget);
		const selection = document.getSelection();

		// A selection in the transcript or a portaled preview is not page text.
		selection?.selectAllChildren(widget);
		expect(readBrowserPageSelection(document)).toBeNull();

		// Nor is text the visitor selects in the composer before sending.
		selection?.removeAllRanges();
		const composer = element("textarea", {
			selectionEnd: 2,
			selectionStart: 0,
			value: "my question",
		});
		widget.append(composer);
		composer.focus();
		expect(document.activeElement).toBe(composer);
		expect(
			composer instanceof HTMLTextAreaElement ? composer.selectionEnd : null
		).toBe(2);
		expect(readBrowserPageSelection(document)).toBeNull();

		// The page selection still reads while an assistant control has focus.
		selection?.selectAllChildren(paragraph);
		expect(readBrowserPageSelection(document)).toBe("Page passage");
	});
});
