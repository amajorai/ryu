import {
	DOM_ATTRIBUTE_SELECTOR,
	DOM_OBSERVED_ATTRIBUTES,
	DOM_TRANSLATABLE_ATTRIBUTES,
	type DomTranslatableAttribute,
	hasTranslatableCharacters,
	isDocumentTitle,
	isTranslatableAttribute,
	shouldSkipDomElement,
	splitDocumentTitle,
} from "./dom-localizer-attributes.ts";
import {
	type CompanionI18nApi,
	createRemoteTranslator,
	type RemoteTranslator,
} from "./dom-localizer-host.ts";
import { EN_MESSAGES } from "./en-messages.ts";
import type { MessageValuesInput } from "./format.ts";
import {
	collapseLiteralWhitespace,
	messageIdForLiteral,
} from "./literal-catalog.ts";
import { type LanguagePack, MAX_MESSAGE_LENGTH } from "./pack.ts";

/** What the localizer reads from the runtime on every lookup. */
export interface DomLocalizerState {
	availablePacks: readonly LanguagePack[];
	hasOverlayMessage(id: string): boolean;
	t(id: string, values?: MessageValuesInput, fallback?: string): string;
	/** Dynamic text through the literal catalog's templates, if it matches. */
	templateMessage?(text: string): string | undefined;
}

interface DomTranslationRecord {
	key: string;
	output: string;
	source: string;
}

/** Source/output bookkeeping, kept across restarts so a rescan can restore
 * the English source of text the localizer already rewrote. */
export interface DomLocalizerRecords {
	attributes: WeakMap<
		Element,
		Map<DomTranslatableAttribute, DomTranslationRecord>
	>;
	text: WeakMap<Text, DomTranslationRecord>;
}

export function createDomLocalizerRecords(): DomLocalizerRecords {
	return { attributes: new WeakMap(), text: new WeakMap() };
}

export interface DomLocalizerOptions {
	/** Companion host translator; when present every literal is a candidate. */
	host?: CompanionI18nApi | null;
	records?: DomLocalizerRecords;
	/** Node to scan and observe (an element, document or shadow root).
	 * Defaults to `document.documentElement`. */
	root?: Node | null | undefined;
	state: () => DomLocalizerState;
	/** Changes whenever the runtime's translations may have changed. */
	translationKey: () => string;
}

type Apply = (output: string) => void;

function resolveRoot(root: Node | null | undefined): Node | null {
	if (root === undefined) {
		return globalThis.document?.documentElement ?? null;
	}
	if (root !== null && root.nodeType === 9) {
		// SAFETY: nodeType 9 is DOCUMENT_NODE.
		return (root as Document).documentElement;
	}
	return root;
}

function queryElements(scanRoot: Node): Element[] {
	if (!("querySelectorAll" in scanRoot)) {
		return [];
	}
	// SAFETY: Element, Document and DocumentFragment (ShadowRoot) are ParentNodes.
	const parent = scanRoot as ParentNode;
	const queried = Array.from(parent.querySelectorAll(DOM_ATTRIBUTE_SELECTOR));
	if (scanRoot.nodeType !== 1) {
		return queried;
	}
	// SAFETY: nodeType 1 is ELEMENT_NODE.
	const element = scanRoot as Element;
	return element.matches(DOM_ATTRIBUTE_SELECTOR)
		? [element, ...queried]
		: queried;
}

/**
 * Translate catalog literals under `root` and keep translating as it changes.
 * Named messages and published literal ids resolve synchronously, as does
 * dynamic text matching a catalog template; inside a
 * Companion frame, text the frame cannot translate is asked of the host,
 * which owns the official catalog. Unknown text is applied unchanged and is
 * never ICU-formatted. Returns a disposer.
 */
export function observeDomLocalization(
	options: DomLocalizerOptions
): () => void {
	const root = resolveRoot(options.root);
	if (!root || globalThis.MutationObserver === undefined) {
		return () => undefined;
	}
	const observedRoot: Node = root;
	const records = options.records ?? createDomLocalizerRecords();
	const ownerDocument = root.ownerDocument ?? globalThis.document;
	let disposed = false;
	let scanQueued = false;
	const pendingRoots = new Set<Node>();
	const remote: RemoteTranslator | null = options.host
		? createRemoteTranslator(options.host, () => queueScan())
		: null;
	const translationKey = () =>
		`${options.translationKey()}\u0000${remote?.key() ?? ""}`;

	const translateValue = (
		source: string,
		apply: Apply,
		explicitLiteral: boolean
	) => {
		if (source.length > MAX_MESSAGE_LENGTH) {
			apply(source);
			return;
		}
		const key = translationKey();
		const trimmed = source.trim();
		if (!hasTranslatableCharacters(trimmed)) {
			return;
		}
		const collapsed = collapseLiteralWhitespace(trimmed);
		const id = messageIdForLiteral(collapsed);
		const current = options.state();
		const knownLiteral =
			Object.hasOwn(EN_MESSAGES, id) ||
			current.hasOverlayMessage(id) ||
			current.availablePacks.some((pack) => Object.hasOwn(pack.messages, id));
		// Dynamic sentences (`Deleted Q3 plan`) match a catalog template; the
		// captured values stay as written.
		const templated = knownLiteral
			? undefined
			: current.templateMessage?.(collapsed);
		// Runtime prose is data, even if it resembles ICU syntax. Cache its
		// unchanged output so subsequent mutations do not retry translation.
		if (
			!(knownLiteral || templated !== undefined || explicitLiteral || remote)
		) {
			apply(source);
			return;
		}
		const place = (output: string) =>
			source === trimmed ? output : source.replace(trimmed, output);
		let local = collapsed;
		try {
			if (knownLiteral) {
				local = current.t(id, {}, collapsed);
			} else if (templated !== undefined) {
				local = templated;
			}
		} catch {
			apply(source);
			return;
		}
		apply(local === collapsed ? source : place(local));
		const request = remote?.request(collapsed, id, local, (packId) =>
			current.availablePacks.some((pack) => pack.id === packId)
		);
		void request?.then((output) => {
			if (!disposed && key === translationKey() && output !== collapsed) {
				apply(place(output));
			}
		});
	};

	const translateText = (textNode: Text, parent: Element) => {
		const record = records.text.get(textNode);
		if (
			record &&
			record.output === textNode.data &&
			record.key === translationKey()
		) {
			return;
		}
		const source =
			record && record.output === textNode.data ? record.source : textNode.data;
		const apply: Apply = (output) => {
			const currentRecord = records.text.get(textNode);
			if (
				textNode.data === source ||
				(currentRecord?.source === source &&
					currentRecord.output === textNode.data)
			) {
				records.text.set(textNode, { key: translationKey(), output, source });
				if (textNode.data !== output) {
					textNode.data = output;
				}
			}
		};
		const explicit = Boolean(parent.closest('[data-ryu-i18n="on"]'));
		const title = isDocumentTitle(parent) ? splitDocumentTitle(source) : null;
		if (title) {
			// Translate the page title; keep the site suffix as written.
			translateValue(
				title.head,
				(output) => apply(`${output}${title.tail}`),
				explicit
			);
			return;
		}
		translateValue(source, apply, explicit);
	};

	const translateAttribute = (
		element: Element,
		attribute: DomTranslatableAttribute
	) => {
		const value = element.getAttribute(attribute);
		if (value === null || !isTranslatableAttribute(element, attribute)) {
			return;
		}
		const record = records.attributes.get(element)?.get(attribute);
		if (record && record.output === value && record.key === translationKey()) {
			return;
		}
		const source = record && record.output === value ? record.source : value;
		translateValue(
			source,
			(output) => {
				const currentValue = element.getAttribute(attribute);
				const currentRecord = records.attributes.get(element)?.get(attribute);
				if (
					currentValue !== source &&
					!(
						currentRecord?.source === source &&
						currentRecord.output === currentValue
					)
				) {
					return;
				}
				let byAttribute = records.attributes.get(element);
				if (!byAttribute) {
					byAttribute = new Map();
					records.attributes.set(element, byAttribute);
				}
				byAttribute.set(attribute, { key: translationKey(), output, source });
				if (currentValue !== output) {
					element.setAttribute(attribute, output);
				}
			},
			Boolean(element.closest('[data-ryu-i18n="on"]'))
		);
	};

	const scan = (scanRoot: Node) => {
		const walker = ownerDocument.createTreeWalker(scanRoot, 4);
		let node = scanRoot.nodeType === 3 ? scanRoot : walker.nextNode();
		while (node) {
			// SAFETY: scanRoot is included only at TEXT_NODE; the SHOW_TEXT walker yields only Text nodes.
			const textNode = node as Text;
			const parent = textNode.parentElement;
			if (parent && !shouldSkipDomElement(parent)) {
				translateText(textNode, parent);
			}
			node = walker.nextNode();
		}
		for (const element of queryElements(scanRoot)) {
			if (!shouldSkipDomElement(element)) {
				for (const attribute of DOM_TRANSLATABLE_ATTRIBUTES) {
					translateAttribute(element, attribute);
				}
			}
		}
	};

	function queueScan(node: Node = observedRoot) {
		if (disposed) {
			return;
		}
		pendingRoots.add(node);
		if (scanQueued) {
			return;
		}
		scanQueued = true;
		queueMicrotask(() => {
			scanQueued = false;
			const queued = new Set(pendingRoots);
			pendingRoots.clear();
			if (disposed) {
				return;
			}
			for (const candidate of queued) {
				if (!observedRoot.contains(candidate)) {
					continue;
				}
				let parent = candidate.parentNode;
				while (parent && !queued.has(parent)) {
					parent = parent.parentNode;
				}
				if (!parent) {
					scan(candidate);
				}
			}
		});
	}

	const observer = new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			if (mutation.type === "childList") {
				for (const node of Array.from(mutation.addedNodes)) {
					queueScan(node);
				}
			} else {
				queueScan(mutation.target);
			}
		}
	});
	observer.observe(root, {
		attributeFilter: [...DOM_OBSERVED_ATTRIBUTES],
		attributes: true,
		characterData: true,
		childList: true,
		subtree: true,
	});

	scan(root);
	return () => {
		disposed = true;
		pendingRoots.clear();
		observer.disconnect();
		remote?.dispose();
	};
}
