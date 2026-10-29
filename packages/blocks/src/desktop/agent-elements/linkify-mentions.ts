const CODE_FENCE_SPLIT_RE = /(```[\s\S]*?```)/g;
const MARKDOWN_LINK_OR_CODE_RE = /(`[^`\n]+`|!?\[[^\]\n]*\]\([^)\n]+\))/g;
const BRACKETED_REFERENCE_RE = /@<([^>\n]+)>/g;
const AT_TOKEN_RE = /(^|[\s([{"'])@([^\s<>()[\]{}"']+)/g;
const WEB_URL_RE = /^https?:\/\//i;
const FILEISH_RE = /(?:^|\/)[^/]+\.[A-Za-z0-9_-]{1,12}(?::\d+(?::\d+)?)?$/;
const TRAILING_PUNCTUATION_RE = /[.,;:!?]+$/;
const GENERATED_FILE_HREF_RE = /#ryu-file-path-([^\s)]+)/g;
const MARKDOWN_LABEL_SPECIAL_RE = /([\\[\]_*`])/g;

function mentionLabel(value: string): string {
	return `@${value.replace(MARKDOWN_LABEL_SPECIAL_RE, "\\$1")}`;
}

function fileHref(path: string): string {
	return `#ryu-file-path-${encodeURIComponent(path)}`;
}

function webHref(url: string): string {
	return `#ryu-web-url-${encodeURIComponent(url)}`;
}

function linkAtReferencesInPlainText(text: string): string {
	const linkedTokens = text.replace(
		AT_TOKEN_RE,
		(match, prefix: string, raw: string) => {
			const punctuation = raw.match(TRAILING_PUNCTUATION_RE)?.[0] ?? "";
			const value = punctuation ? raw.slice(0, -punctuation.length) : raw;
			if (WEB_URL_RE.test(value)) {
				return `${prefix}[${mentionLabel(value)}](${webHref(value)})${punctuation}`;
			}
			if (FILEISH_RE.test(value)) {
				return `${prefix}[${mentionLabel(value)}](${fileHref(value)})${punctuation}`;
			}
			return match;
		}
	);
	// Bracketed references are expanded last so their generated @ labels are not
	// parsed a second time into nested Markdown links.
	return linkedTokens.replace(BRACKETED_REFERENCE_RE, (match, raw: string) => {
		const value = raw.trim();
		if (WEB_URL_RE.test(value)) {
			return `[${mentionLabel(value)}](${webHref(value)})`;
		}
		if (FILEISH_RE.test(value)) {
			return `[${mentionLabel(value)}](${fileHref(value)})`;
		}
		return match;
	});
}

/** Turn agent-authored `@path/file.ts` and `@https://…` mentions into links. */
export function linkifyAtMentions(markdown: string): string {
	return markdown
		.split(CODE_FENCE_SPLIT_RE)
		.map((fenced) => {
			if (fenced.startsWith("```")) {
				return fenced;
			}
			return fenced
				.split(MARKDOWN_LINK_OR_CODE_RE)
				.map((part) =>
					part.startsWith("`") || /^!?\[/.test(part)
						? part
						: linkAtReferencesInPlainText(part)
				)
				.join("");
		})
		.join("");
}

export function decodeMentionHref(href: string, prefix: string): string | null {
	if (!href.startsWith(prefix)) {
		return null;
	}
	try {
		return decodeURIComponent(href.slice(prefix.length));
	} catch {
		return null;
	}
}

/** Collect the workspace file references that the Markdown renderer will link. */
export function extractAtFileMentions(markdown: string): string[] {
	const mentions = new Set<string>();
	for (const match of linkifyAtMentions(markdown).matchAll(
		GENERATED_FILE_HREF_RE
	)) {
		const value = decodeMentionHref(
			`#ryu-file-path-${match[1]}`,
			"#ryu-file-path-"
		);
		if (value) {
			mentions.add(value);
		}
	}
	return [...mentions];
}
