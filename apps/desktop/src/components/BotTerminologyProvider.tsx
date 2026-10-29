import { useOptionalI18n } from "@ryu/i18n/react";
import { useBotTerminology } from "@ryu/ui/hooks/use-bot-terminology.ts";
import { type ReactNode, useLayoutEffect, useMemo } from "react";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import {
	createBotTerminologyRenderer,
	rendersEnglishOutput,
} from "./bot-terminology-render.ts";
import { NativeCopyLocalizer } from "./NativeCopyLocalizer.tsx";

type Render = (source: string) => string;

const TEXT_ATTRIBUTES = [
	"alt",
	"aria-label",
	"aria-description",
	"aria-valuetext",
	"placeholder",
	"title",
] as const;

// User-authored text and executable/code-like surfaces keep their source text.
const TEXT_IGNORE_SELECTOR = [
	"script",
	"style",
	"noscript",
	"template",
	"textarea",
	"input",
	"pre",
	"code",
	'[contenteditable="true"]',
	'[data-ryu-bot-terminology="ignore"]',
	// User data (entity names, titles) the DOM localizer also skips.
	'[data-ryu-i18n="off"]',
	'[data-slot="message-content"]',
	'[data-slot="user-message-editor"]',
].join(",");

// UI labels, accessible names, and descriptions still follow the selected
// vocabulary, including placeholders on inputs and textareas. Message bodies,
// code, and explicitly opted-out surfaces keep their attributes unchanged too.
const ATTRIBUTE_IGNORE_SELECTOR = [
	"script",
	"style",
	"noscript",
	"template",
	"pre",
	"code",
	'[data-ryu-bot-terminology="ignore"]',
	// User data (entity names, titles) the DOM localizer also skips.
	'[data-ryu-i18n="off"]',
	'[data-slot="message-content"]',
].join(",");

function isTextIgnored(element: Element | null): boolean {
	return element?.closest(TEXT_IGNORE_SELECTOR) != null;
}

function areAttributesIgnored(element: Element | null): boolean {
	return element?.closest(ATTRIBUTE_IGNORE_SELECTOR) != null;
}

function isTextNode(value: Node): value is Text {
	return value.nodeType === Node.TEXT_NODE;
}

function restoreTextNodes(
	textNodes: Set<Text>,
	originals: WeakMap<Text, string>,
	render: Render
): void {
	for (const node of textNodes) {
		const original = originals.get(node);
		if (original !== undefined && node.data === render(original)) {
			node.data = original;
		}
	}
}

function restoreAttributes(
	elements: Set<Element>,
	originals: WeakMap<Element, Map<string, string>>,
	render: Render
): void {
	for (const element of elements) {
		const original = originals.get(element);
		if (!original) {
			continue;
		}
		for (const [attribute, value] of original) {
			if (element.getAttribute(attribute) === render(value)) {
				element.setAttribute(attribute, value);
			}
		}
	}
}

function BotTerminologyDomSync({
	enabled,
	render,
}: {
	enabled: boolean;
	render: Render;
}) {
	useLayoutEffect(() => {
		if (!enabled || globalThis.document === undefined || !document.body) {
			return;
		}

		const textOriginals = new WeakMap<Text, string>();
		const touchedTextNodes = new Set<Text>();
		const attributeOriginals = new WeakMap<Element, Map<string, string>>();
		const touchedElements = new Set<Element>();

		const transformText = (node: Text) => {
			if (isTextIgnored(node.parentElement)) {
				return;
			}
			const previous = textOriginals.get(node);
			const previousRendered = previous ? render(previous) : null;
			const source =
				previous && node.data === previousRendered ? previous : node.data;
			const rendered = render(source);
			if (rendered === source) {
				return;
			}
			textOriginals.set(node, source);
			touchedTextNodes.add(node);
			if (node.data !== rendered) {
				node.data = rendered;
			}
		};

		const transformAttribute = (element: Element, attribute: string) => {
			if (areAttributesIgnored(element)) {
				return;
			}
			const current = element.getAttribute(attribute);
			if (current === null) {
				return;
			}
			const original = attributeOriginals.get(element);
			const previous = original?.get(attribute);
			const previousRendered = previous ? render(previous) : null;
			const source =
				previous && current === previousRendered ? previous : current;
			const rendered = render(source);
			if (rendered === source) {
				return;
			}
			const values = original ?? new Map<string, string>();
			values.set(attribute, source);
			attributeOriginals.set(element, values);
			touchedElements.add(element);
			if (current !== rendered) {
				element.setAttribute(attribute, rendered);
			}
		};

		const transformElement = (element: Element) => {
			for (const attribute of TEXT_ATTRIBUTES) {
				transformAttribute(element, attribute);
			}
			const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
			let current = walker.nextNode();
			while (current) {
				if (isTextNode(current)) {
					transformText(current);
				}
				current = walker.nextNode();
			}
			for (const child of element.querySelectorAll("*")) {
				for (const attribute of TEXT_ATTRIBUTES) {
					transformAttribute(child, attribute);
				}
			}
		};

		const transformNode = (node: Node) => {
			if (isTextNode(node)) {
				transformText(node);
			} else if (node instanceof Element) {
				transformElement(node);
			}
		};

		transformElement(document.body);
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				if (record.type === "characterData" && isTextNode(record.target)) {
					transformText(record.target);
				}
				if (record.type === "attributes" && record.target instanceof Element) {
					const attribute = record.attributeName;
					if (
						attribute &&
						TEXT_ATTRIBUTES.some((value) => value === attribute)
					) {
						transformAttribute(record.target, attribute);
					}
				}
				for (const node of record.addedNodes) {
					transformNode(node);
				}
			}
		});
		observer.observe(document.body, {
			attributeFilter: [...TEXT_ATTRIBUTES],
			attributes: true,
			characterData: true,
			subtree: true,
			childList: true,
		});

		return () => {
			observer.disconnect();
			restoreTextNodes(touchedTextNodes, textOriginals, render);
			restoreAttributes(touchedElements, attributeOriginals, render);
		};
	}, [enabled, render]);

	return null;
}

/**
 * Applies the selected vocabulary to the rendered desktop UI. Translation
 * comes first: the swap runs only on English output (see
 * `rendersEnglishOutput`), and English flavor-pack copy is resolved before
 * the swap so the "agent" source stays the lookup key.
 */
export function BotTerminologyProvider({ children }: { children: ReactNode }) {
	const interfaceLevel = useInterfaceLevel();
	const [botTerminology] = useBotTerminology();
	const i18n = useOptionalI18n();
	const locale = i18n?.locale ?? "en";
	const selectedPack = i18n?.selectedPack ?? null;
	const forcedBySimple = interfaceLevel === "simple";
	const englishOutput = rendersEnglishOutput(locale, selectedPack !== null);
	const enabled = (forcedBySimple || botTerminology) && englishOutput;
	const packMessages = selectedPack?.messages ?? null;
	const render = useMemo(
		() => createBotTerminologyRenderer(packMessages),
		[packMessages]
	);

	return (
		<>
			<BotTerminologyDomSync enabled={enabled} render={render} />
			<NativeCopyLocalizer botTerminology={enabled} />
			{children}
		</>
	);
}
