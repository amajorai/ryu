// Context-chip previews are portaled to <body>, outside the widget root. These
// DOM tests keep that portal from clearing or replacing the opted-in selection.
// Base UI reads DOM globals when it loads, so the package runs `bun test
// --isolate`; this file registers happy-dom before importing the chips.
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

const registeredHere = !GlobalRegistrator.isRegistered;
if (registeredHere) {
	GlobalRegistrator.register({ url: "https://docs.example/install" });
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { PageContextChips } = await import("./page-context.tsx");
const { isAssistantSelectionChange, readBrowserPageSelection } = await import(
	"./browser-context.ts"
);

const PAGE_SELECTION = "Selected words on the page";
const noop = () => undefined;
const composerClick = mock(() => undefined);

/** Mirrors the widget's `selectionchange` handling around the real chips. */
function Harness() {
	const [selection, setSelection] = useState<string | null>(null);
	useEffect(() => {
		const refreshSelection = () => {
			if (isAssistantSelectionChange(document)) {
				return;
			}
			setSelection(readBrowserPageSelection(document));
		};
		document.addEventListener("selectionchange", refreshSelection);
		return () =>
			document.removeEventListener("selectionchange", refreshSelection);
	}, []);
	return (
		<div data-ryu-assistant-widget="true">
			<output data-testid="stored-selection">{selection ?? ""}</output>
			{/* Stands in for the composer card, which focuses its textarea on click. */}
			<div data-testid="composer-card" onClick={composerClick}>
				<PageContextChips
					context={{
						selection,
						text: "Readable page text",
						title: "Install Ryu",
						url: "https://docs.example/install",
					}}
					includePage
					includeSelection
					onIncludePageChange={noop}
					onIncludeSelectionChange={noop}
				/>
			</div>
		</div>
	);
}

let page: HTMLElement;
let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	composerClick.mockClear();
	page = document.createElement("main");
	const paragraph = document.createElement("p");
	paragraph.id = "page-paragraph";
	paragraph.textContent = PAGE_SELECTION;
	page.append(paragraph);
	container = document.createElement("div");
	document.body.append(page, container);
	root = createRoot(container);
	await act(async () => root.render(<Harness />));
});

afterEach(async () => {
	await act(async () => {
		root.unmount();
		document.getSelection()?.removeAllRanges();
	});
	page.remove();
	container.remove();
});

afterAll(() => {
	if (registeredHere) {
		GlobalRegistrator.unregister();
	}
});

/** Changes the selection, then reports it the way browsers do. */
async function changeSelection(update: () => void) {
	await act(async () => {
		update();
		document.dispatchEvent(new Event("selectionchange"));
	});
}

function storedSelection() {
	return (
		container.querySelector('[data-testid="stored-selection"]')?.textContent ??
		""
	);
}

async function selectPageText() {
	const paragraph = document.getElementById("page-paragraph");
	if (!paragraph) {
		throw new Error("The page paragraph is missing.");
	}
	await changeSelection(() => {
		document.getSelection()?.selectAllChildren(paragraph);
	});
}

async function openSelectionPreview() {
	const trigger = container.querySelector<HTMLButtonElement>(
		'button[aria-label="Review selected text"]'
	);
	if (!trigger) {
		throw new Error("The Selected text chip is missing.");
	}
	await act(async () => trigger.click());
	const textarea = document.querySelector<HTMLTextAreaElement>(
		'textarea[aria-label="Selected page text available as context"]'
	);
	const popup = textarea?.closest<HTMLElement>('[data-slot="popover-content"]');
	if (!(textarea && popup)) {
		throw new Error("The selected-text preview did not open.");
	}
	return { popup, textarea };
}

test("a page selection is stored and shown as the Selected text chip", async () => {
	await selectPageText();

	expect(storedSelection()).toBe(PAGE_SELECTION);
	expect(
		container.querySelector('button[aria-label="Review selected text"]')
	).not.toBeNull();
});

test("the portaled preview is marked as assistant DOM and focuses the dialog, not its text", async () => {
	await selectPageText();
	const { popup, textarea } = await openSelectionPreview();

	expect(container.contains(popup)).toBe(false);
	expect(popup.getAttribute("data-ryu-assistant-widget")).toBe("true");
	expect(textarea.value).toBe(PAGE_SELECTION);
	expect(document.activeElement).toBe(popup);
});

test("focusing the preview text keeps the stored selection and its chip", async () => {
	await selectPageText();
	const { textarea } = await openSelectionPreview();

	// Chromium and WebKit move the document caret into a focused text control.
	await changeSelection(() => {
		textarea.focus();
		const textareaParent = textarea.parentElement;
		if (textareaParent) {
			document.getSelection()?.collapse(textareaParent, 0);
		}
	});

	expect(storedSelection()).toBe(PAGE_SELECTION);
	expect(
		container.querySelector('button[aria-label="Review selected text"]')
	).not.toBeNull();
	expect(document.contains(textarea)).toBe(true);
});

test("selecting part of the preview text does not replace the page selection", async () => {
	await selectPageText();
	const { textarea } = await openSelectionPreview();

	// Firefox keeps text-control selection apart from the document selection.
	await changeSelection(() => {
		textarea.focus();
		document.getSelection()?.removeAllRanges();
		textarea.setSelectionRange(0, "Selected".length);
	});

	expect(storedSelection()).toBe(PAGE_SELECTION);
});

test("clicking static preview content does not reach the composer card", async () => {
	await selectPageText();
	const { popup } = await openSelectionPreview();
	// The chip trigger is a button, which the composer card already ignores.
	composerClick.mockClear();
	const title = popup.querySelector<HTMLElement>('[data-slot="popover-title"]');
	if (!title) {
		throw new Error("The preview title is missing.");
	}

	await act(async () => title.click());

	expect(composerClick).not.toHaveBeenCalled();
	expect(document.contains(popup)).toBe(true);
});

test("a new page selection still replaces the stored one", async () => {
	await selectPageText();
	const extra = document.createElement("p");
	extra.textContent = "A different passage";
	page.append(extra);

	await changeSelection(() => {
		document.getSelection()?.selectAllChildren(extra);
	});

	expect(storedSelection()).toBe("A different passage");
});
