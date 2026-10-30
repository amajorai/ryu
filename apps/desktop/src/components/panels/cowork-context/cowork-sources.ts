import {
	ComputerTerminal01Icon,
	File01Icon,
	FolderOpenIcon,
	Globe02Icon,
	Image02Icon,
	Link01Icon,
	Search01Icon,
	SourceCodeIcon,
} from "@hugeicons/core-free-icons";
import { extractCitations } from "@ryu/blocks/desktop/agent-elements/utils/citations.ts";
import {
	firstString,
	PATH_KEYS,
	toolNameOf,
} from "@/src/lib/mission-control/turn-groups.ts";
import {
	CHAT_ATTACHMENTS_SOURCE,
	FILE_TOOLS,
	FIRST_LINE_RE,
	MAX_ITEM_CHARS,
	nonEmptyString,
	parseSourceTool,
	prettyOperationLabel,
	SEARCH_TOOLS,
	SHELL_TOOLS,
	TOOL_ARGUMENT_KEYS,
	WEB_TOOLS,
} from "./cowork-source-tools.ts";
import {
	type DerivedSource,
	isToolPart,
	readToolPayload,
	type SourceItem,
	type StreamMessage,
	type StreamPart,
} from "./cowork-types.ts";

function baseName(path: string): string {
	const segments = path.split(/[\\/]/).filter(Boolean);
	return segments.at(-1) ?? path;
}

function clampItem(text: string): string {
	const oneLine = text.replace(FIRST_LINE_RE, "").trim();
	return oneLine.length > MAX_ITEM_CHARS
		? `${oneLine.slice(0, MAX_ITEM_CHARS - 1).trimEnd()}…`
		: oneLine;
}

/** A file the user supplied with a chat turn, read from the same wire shapes the transcript renders. */
function attachmentItem<TValue>(
	value: TValue,
	id: string,
	fallbackNumber: number,
	legacy = false
): SourceItem | null {
	const part = readToolPayload(value);
	if (!part) {
		return null;
	}
	if (
		!legacy &&
		part.type !== "file" &&
		part.type !== "image" &&
		part.type !== "data-image"
	) {
		return null;
	}
	const mediaType =
		nonEmptyString(part.mediaType) ?? nonEmptyString(part.mimeType);
	const filename =
		nonEmptyString(part.filename) ??
		nonEmptyString(part.name) ??
		nonEmptyString(part.fileName);
	const contentType = nonEmptyString(part.contentType);
	const resolvedMediaType =
		mediaType ??
		contentType ??
		(part.type === "image" || part.type === "data-image"
			? "image/*"
			: undefined);
	if (!(resolvedMediaType || filename || nonEmptyString(part.url))) {
		return null;
	}
	const isImage = resolvedMediaType?.startsWith("image/") ?? false;
	return {
		id,
		label: filename ?? `${isImage ? "Image" : "Attachment"} ${fallbackNumber}`,
		detail: resolvedMediaType,
		filePath: filename,
		icon: isImage ? Image02Icon : File01Icon,
	};
}

/**
 * Map a tool NAME to the connector/source it represents. Returns null for tools
 * that aren't a recognisable external source (so a run that only thinks/writes
 * shows just "Local files", not noise). Qualified MCP, app, and integration
 * names are all normalized here so the pinned and workspace projections cannot
 * disagree about which tool plane a call belongs to.
 */
function sourceForTool(tool: string): Omit<DerivedSource, "items"> | null {
	if (WEB_TOOLS.has(tool)) {
		return { id: "web", label: "Web search", icon: Globe02Icon };
	}
	if (tool === "cloning") {
		return { id: "github", label: "GitHub", icon: SourceCodeIcon };
	}
	if (FILE_TOOLS.has(tool) || SEARCH_TOOLS.has(tool) || SHELL_TOOLS.has(tool)) {
		return { id: "local", label: "Local files", icon: FolderOpenIcon };
	}
	return parseSourceTool(tool)?.source ?? null;
}

function firstToolArgument<TInput>(input: TInput): string | undefined {
	const direct = firstString(input, TOOL_ARGUMENT_KEYS);
	if (direct) {
		return direct;
	}
	const record = readToolPayload(input);
	if (!record) {
		return undefined;
	}
	for (const key of ["arguments", "args", "params", "payload"]) {
		const nested = firstString(record[key], TOOL_ARGUMENT_KEYS);
		if (nested) {
			return nested;
		}
	}
	return undefined;
}

/**
 * The concrete thing one tool call touched, read out of its input. Every field
 * is best-effort: a call whose input hasn't streamed in yet (or whose bridge
 * names things differently) contributes no item rather than an empty row.
 */
function itemForTool(tool: string, part: StreamPart): SourceItem | null {
	if (FILE_TOOLS.has(tool)) {
		const path = firstString(part.input, PATH_KEYS);
		return path
			? {
					id: `file:${path}`,
					label: baseName(path),
					detail: path,
					filePath: path,
					icon: File01Icon,
				}
			: null;
	}
	if (SEARCH_TOOLS.has(tool)) {
		const pattern = firstString(part.input, ["pattern", "query", "glob"]);
		if (!pattern) {
			return null;
		}
		const where = firstString(part.input, PATH_KEYS);
		return {
			id: `search:${pattern}:${where ?? ""}`,
			label: clampItem(pattern),
			detail: where,
			icon: Search01Icon,
		};
	}
	if (SHELL_TOOLS.has(tool)) {
		const command = firstString(part.input, ["command", "cmd"]);
		return command
			? {
					id: `cmd:${command}`,
					label: clampItem(command),
					detail: firstString(part.input, ["description"]),
					icon: ComputerTerminal01Icon,
				}
			: null;
	}
	const parsed = parseSourceTool(tool);
	if (parsed) {
		const argument = firstToolArgument(part.input);
		return {
			id: `${parsed.kind}:${parsed.source.id}:${parsed.operation}:${argument ?? ""}`,
			label:
				parsed.kind === "mcp"
					? parsed.operation.replace(/[._-]/g, " ")
					: prettyOperationLabel(parsed.operation),
			detail: argument ? clampItem(argument) : undefined,
			icon: parsed.source.icon,
		};
	}
	const url = firstString(part.input, ["url", "link", "uri"]);
	if (url) {
		return { id: `url:${url}`, label: url, url, icon: Link01Icon };
	}
	if (WEB_TOOLS.has(tool)) {
		const query = firstString(part.input, ["query", "q", "prompt"]);
		return query
			? {
					id: `query:${query}`,
					label: clampItem(query),
					detail: "Search query",
					icon: Search01Icon,
				}
			: null;
	}
	return null;
}

/**
 * Append an item to its group, keeping first-seen order. A repeat of the same id
 * is dropped — EXCEPT when the newcomer carries a real title for a link the
 * input-derived row could only name by its URL, which upgrades the row in place
 * (the fetch's own `<title>` beats `https://…` as a label).
 */
function pushItem(source: DerivedSource, item: SourceItem | null) {
	if (!item) {
		return;
	}
	const at = source.items.findIndex((existing) => existing.id === item.id);
	if (at === -1) {
		source.items.push(item);
		return;
	}
	const existing = source.items[at];
	if (existing.label === existing.url && item.label !== item.url) {
		source.items[at] = item;
	}
}

function sourceFrom(
	byId: Map<string, DerivedSource>,
	meta: Omit<DerivedSource, "items">
): DerivedSource {
	const existing = byId.get(meta.id);
	if (existing) {
		return existing;
	}
	const source = { ...meta, items: [] };
	byId.set(source.id, source);
	return source;
}

/**
 * Distinct sources used across the whole conversation, first-seen order, each
 * carrying the attachments / files / links / commands it was used on. User
 * attachments come from the same message parts the transcript renders. Web
 * results come from `extractCitations` (the same derivation the transcript's
 * citation chips use), so a search's result links show up, not just the query
 * that found them.
 */
export function extractSources(messages: StreamMessage[]): DerivedSource[] {
	const byId = new Map<string, DerivedSource>();
	const allParts: StreamPart[] = [];
	for (const [messageIndex, message] of messages.entries()) {
		for (const [partIndex, part] of (message.parts ?? []).entries()) {
			allParts.push(part);
			if (message.role === "user") {
				const item = attachmentItem(
					part,
					`attachment:${messageIndex}:${partIndex}`,
					partIndex + 1
				);
				if (item) {
					pushItem(sourceFrom(byId, CHAT_ATTACHMENTS_SOURCE), item);
				}
			}
			if (!isToolPart(part)) {
				continue;
			}
			const tool = toolNameOf(part);
			const meta = sourceForTool(tool);
			if (meta) {
				pushItem(sourceFrom(byId, meta), itemForTool(tool, part));
			}
		}
		if (message.role === "user" && message.experimental_attachments) {
			for (const [
				attachmentIndex,
				attachment,
			] of message.experimental_attachments.entries()) {
				const item = attachmentItem(
					attachment,
					`legacy-attachment:${messageIndex}:${attachmentIndex}`,
					attachmentIndex + 1,
					true
				);
				if (!item) {
					continue;
				}
				pushItem(sourceFrom(byId, CHAT_ATTACHMENTS_SOURCE), item);
			}
		}
	}

	const web = byId.get("web");
	if (web) {
		for (const citation of extractCitations(allParts)) {
			pushItem(web, {
				id: `url:${citation.url}`,
				label: citation.title,
				detail: citation.url,
				url: citation.url,
				icon: Link01Icon,
			});
		}
	}
	return [...byId.values()];
}
