import { translate as tl } from "@ryu/i18n/lite";

// @pierre/diffs and @pierre/trees draw a few fixed English strings inside open
// shadow roots. The document's DOM localizer never enters a shadow root, and
// it skips `<pre>`, which holds the diff body, so these are translated here.
// Only the library's own chrome is touched: code lines and file names are
// never rewritten, even when they read like UI copy.

type CopyKey = "text" | CopyAttribute;
type CopyAttribute = "aria-label" | "placeholder" | "title";

interface CopyRecord {
	output: string;
	source: string;
}

/** Elements whose whole text is library copy. */
const TEXT_TARGETS = [
	"[data-unmodified-lines]",
	"[data-expand-all-button]",
	"[data-no-newline] > span",
	"[data-matches]",
].join(",");

/** Elements whose attributes are library copy, and which attributes. */
const ATTRIBUTE_TARGETS: readonly {
	attributes: readonly CopyAttribute[];
	selector: string;
}[] = [
	// The rich editor's search panel buttons.
	{ attributes: ["title", "aria-label"], selector: "[data-search-icon]" },
	// The editor's Search/Replace fields and the Files tree search field.
	{ attributes: ["placeholder"], selector: "input[placeholder]" },
	// The Files tree rename field.
	{
		attributes: ["aria-label"],
		selector: "input[data-item-rename-input][aria-label]",
	},
	// The Files tree row actions button. Rows are also
	// `button[aria-haspopup="menu"]`, labelled with the file name, so the
	// trigger is picked by its data-type and file names are never rewritten.
	{
		attributes: ["aria-label"],
		selector: 'button[data-type="context-menu-trigger"][aria-label]',
	},
];

const ALL_TARGETS = [
	TEXT_TARGETS,
	...ATTRIBUTE_TARGETS.map((target) => target.selector),
].join(",");

const OBSERVED_ATTRIBUTES: CopyAttribute[] = [
	"aria-label",
	"placeholder",
	"title",
];

/** The localized form of one fixed library string, or undefined. */
function fixedCopy(english: string): string | undefined {
	switch (english) {
		case "Close":
			return tl("Close");
		case "Expand all":
			return tl("Expand all");
		case "Match Case":
			return tl("Match Case");
		case "More unchanged context may be available":
			return tl("More unchanged context may be available");
		case "Next":
			return tl("Next");
		case "No newline at end of file":
			return tl("No newline at end of file");
		case "No results":
			return tl("No results");
		case "Options":
			return tl("Options");
		case "Previous":
			return tl("Previous");
		case "Regexp":
			return tl("Regexp");
		case "Replace":
			return tl("Replace");
		case "Replace All":
			return tl("Replace All");
		case "Search":
			return tl("Search");
		case "Search…":
			return tl("Search…");
		case "Whole Word":
			return tl("Whole Word");
		default:
			return;
	}
}

const UNMODIFIED_LINES = /^(\d+) unmodified lines?$/u;
const RESULT_COUNT = /^(\d+) results$/u;
const MATCH_POSITION = /^(\d+) of (\d+)$/u;
const RENAME = /^Rename ([\s\S]+)$/u;

/** The localized form of one counted or named library string, or undefined. */
function patternCopy(english: string): string | undefined {
	const unmodified = UNMODIFIED_LINES.exec(english);
	if (unmodified) {
		return tl(
			"{count, plural, one {# unmodified line} other {# unmodified lines}}",
			{ count: Number(unmodified[1]) }
		);
	}
	const results = RESULT_COUNT.exec(english);
	if (results) {
		return tl("{count, plural, one {# result} other {# results}}", {
			count: Number(results[1]),
		});
	}
	const position = MATCH_POSITION.exec(english);
	if (position) {
		return tl("{current} of {total}", {
			current: Number(position[1]),
			total: Number(position[2]),
		});
	}
	const rename = RENAME.exec(english);
	if (rename) {
		return tl("Rename {name}", { name: rename[1] ?? "" });
	}
	return;
}

/** Localize one English library string; unknown text comes back unchanged. */
export function localizePierreCopy(english: string): string {
	return fixedCopy(english) ?? patternCopy(english) ?? english;
}

export interface PierreShadowLocalizer {
	dispose(): void;
	/** Translate every target again, after the UI language changed. */
	refresh(): void;
}

/**
 * Translate the library copy in one @pierre shadow root and keep translating
 * it as the library re-renders. The English source of each rewritten value is
 * kept, so a later language change starts from English again.
 */
export function localizePierreShadowRoot(
	root: ShadowRoot
): PierreShadowLocalizer {
	const records = new WeakMap<Element, Map<CopyKey, CopyRecord>>();

	const localizeValue = (
		element: Element,
		key: CopyKey,
		current: string,
		write: (value: string) => void
	) => {
		const byKey = records.get(element) ?? new Map<CopyKey, CopyRecord>();
		records.set(element, byKey);
		const record = byKey.get(key);
		const source =
			record && record.output === current ? record.source : current;
		const output = localizePierreCopy(source);
		byKey.set(key, { output, source });
		if (current !== output) {
			write(output);
		}
	};

	const localizeElement = (element: Element) => {
		if (element.matches(TEXT_TARGETS) && element.childElementCount === 0) {
			localizeValue(element, "text", element.textContent ?? "", (value) => {
				element.textContent = value;
			});
		}
		for (const target of ATTRIBUTE_TARGETS) {
			if (!element.matches(target.selector)) {
				continue;
			}
			for (const attribute of target.attributes) {
				const value = element.getAttribute(attribute);
				if (value !== null) {
					localizeValue(element, attribute, value, (next) =>
						element.setAttribute(attribute, next)
					);
				}
			}
		}
	};

	const localizeTree = (node: ParentNode) => {
		if (node instanceof Element && node.matches(ALL_TARGETS)) {
			localizeElement(node);
		}
		for (const element of node.querySelectorAll(ALL_TARGETS)) {
			localizeElement(element);
		}
	};

	const handleMutations = (mutations: MutationRecord[]) => {
		// A changed element is checked itself; an added subtree is searched.
		const changed = new Set<Element>();
		const added = new Set<Element>();
		for (const mutation of mutations) {
			const target =
				mutation.target instanceof Element
					? mutation.target
					: mutation.target.parentElement;
			if (target) {
				changed.add(target);
			}
			for (const node of mutation.addedNodes) {
				if (node instanceof Element) {
					added.add(node);
				}
			}
		}
		for (const element of changed) {
			if (element.isConnected && element.matches(ALL_TARGETS)) {
				localizeElement(element);
			}
		}
		for (const element of added) {
			if (element.isConnected) {
				localizeTree(element);
			}
		}
	};

	localizeTree(root);
	const observer =
		globalThis.MutationObserver === undefined
			? null
			: new MutationObserver(handleMutations);
	observer?.observe(root, {
		attributeFilter: OBSERVED_ATTRIBUTES,
		attributes: true,
		characterData: true,
		childList: true,
		subtree: true,
	});
	return {
		dispose: () => observer?.disconnect(),
		refresh: () => localizeTree(root),
	};
}
