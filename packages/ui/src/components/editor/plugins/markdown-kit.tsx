import {
	BaseFootnoteDefinitionPlugin,
	BaseFootnoteReferencePlugin,
} from "@platejs/footnote";
import { MarkdownPlugin, remarkMdx, remarkMention } from "@platejs/markdown";
import { KEYS } from "platejs";
import remarkEmoji from "remark-emoji";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

// Regex for raw Obsidian wiki syntax in plain text (`[[Title]]` / `[[Title|Alias]]`).
const WIKILINK_TEXT_RE = /\[\[([^\][|]+)(?:\|[^\]]*)?\]\]/g;
const WIKILINK_URL_PREFIX = "wikilink:";

interface MdastNode {
	children?: MdastNode[];
	type: string;
	url?: string;
	value?: string;
}

/** Build a `wikilink` mdast node the deserialize rule maps to a Plate node. */
function wikilinkNode(title: string): MdastNode {
	return {
		children: [{ type: "text", value: title }],
		type: "wikilink",
		value: title,
	};
}

/** Split a text node's value on `[[...]]`, yielding interleaved text + wikilinks. */
function splitWikilinkText(text: string): MdastNode[] {
	const parts: MdastNode[] = [];
	let last = 0;
	WIKILINK_TEXT_RE.lastIndex = 0;
	let match = WIKILINK_TEXT_RE.exec(text);
	while (match !== null) {
		if (match.index > last) {
			parts.push({ type: "text", value: text.slice(last, match.index) });
		}
		parts.push(wikilinkNode((match[1] ?? "").trim()));
		last = match.index + match[0].length;
		match = WIKILINK_TEXT_RE.exec(text);
	}
	if (last < text.length) {
		parts.push({ type: "text", value: text.slice(last) });
	}
	return parts.length > 0 ? parts : [{ type: "text", value: text }];
}

/**
 * Remark plugin: converts Ryu's canonical `[Title](wikilink:Title)` links AND raw
 * `[[Title]]` text into `wikilink` mdast nodes on load, so the editor renders them
 * as chips. Mirrors `remarkMention` (which handles the `@`/`mention:` forms). No
 * `unist-util-visit` dependency — walks the tree directly.
 */
function remarkWikiLink() {
	const walk = (node: MdastNode) => {
		if (!Array.isArray(node.children)) {
			return;
		}
		const next: MdastNode[] = [];
		for (const child of node.children) {
			if (
				child.type === "link" &&
				typeof child.url === "string" &&
				child.url.startsWith(WIKILINK_URL_PREFIX)
			) {
				const raw = child.url.slice(WIKILINK_URL_PREFIX.length);
				let title = raw;
				try {
					title = decodeURIComponent(raw);
				} catch {
					title = raw;
				}
				next.push(wikilinkNode(title));
				continue;
			}
			if (
				child.type === "text" &&
				typeof child.value === "string" &&
				child.value.includes("[[")
			) {
				next.push(...splitWikilinkText(child.value));
				continue;
			}
			walk(child);
			next.push(child);
		}
		node.children = next;
	};
	return (tree: MdastNode) => walk(tree);
}

export const MarkdownKit = [
	BaseFootnoteReferencePlugin,
	BaseFootnoteDefinitionPlugin,
	MarkdownPlugin.configure({
		options: {
			plainMarks: [KEYS.suggestion, KEYS.comment],
			remarkPlugins: [
				remarkMath,
				remarkGfm,
				remarkEmoji as any,
				remarkMdx,
				remarkMention,
				remarkWikiLink,
			],
			rules: {
				wikilink: {
					deserialize: (mdastNode: MdastNode) => ({
						children: [{ text: "" }],
						type: "wikilink",
						value: mdastNode.value,
					}),
					serialize: (node: { value?: unknown }) => {
						const title = String(node.value ?? "");
						return {
							children: [{ type: "text", value: title }],
							type: "link",
							url: `${WIKILINK_URL_PREFIX}${title}`,
						};
					},
				},
			},
		},
	}),
];
