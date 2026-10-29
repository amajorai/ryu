import type { ReactNode } from "react";

export interface ComposerMentionItem {
	accentColor?: string;
	icon?: ReactNode;
	id?: string;
	kind: string;
	label: string;
	ownerId?: string;
	visualIcon?: ReactNode;
}

interface ExternalMentionTarget {
	filePath?: string;
	kind?: string;
	resourceId?: string;
}

const MARKDOWN_LINK =
	/(!?)\[((?:\\.|[^\]\n])+?)\]\((?:<([^>\n]+)>|((?:\\.|[^)\s])+))(?:\s+(?:"[^"]*"|'[^']*'))?\)/g;
const NON_MENTION_SCHEMES = new Set([
	"data",
	"ftp",
	"http",
	"https",
	"javascript",
	"mailto",
	"tel",
]);
const KIND_BY_SCHEME = new Map(
	Object.entries({
		"app-item": "app-item",
		app: "app",
		application: "app",
		agent: "agent",
		chat: "chat",
		"chatgpt-conversation": "chat",
		connector: "integration",
		folder: "folder",
		group: "team",
		integration: "integration",
		mcp: "mcp",
		page: "page",
		person: "user",
		plugin: "plugin",
		project: "app-item",
		"sites-project": "app-item",
		skill: "skill",
		space: "space",
		team: "team",
		"output-style": "output-style",
		user: "user",
		workflow: "workflow",
	})
);
const SCHEME_BY_KIND = new Map(
	Object.entries({
		"app-item": "app-item",
		app: "app",
		agent: "agent",
		chat: "chatgpt-conversation",
		folder: "folder",
		integration: "app",
		mcp: "mcp",
		page: "page",
		plugin: "plugin",
		skill: "skill",
		space: "space",
		team: "team",
		"output-style": "output-style",
		user: "user",
		workflow: "workflow",
	})
);
const WORKSPACE_ROOT =
	/^(?:apps|packages|crates|docs|plugins-store|src|tests|tools)\//i;

function unescapeMarkdown(value: string): string {
	return value.replace(/\\([\\`*_{}[\]()#+\-.!>])/g, "$1");
}

function normalizedName(value: string): string {
	return unescapeMarkdown(value)
		.replaceAll("**", "")
		.replaceAll("__", "")
		.trim()
		.replace(/^[$@]/, "")
		.trim()
		.replace(/\s+/g, " ")
		.toLocaleLowerCase();
}

function decodeUriPart(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function parseTarget(destination: string): ExternalMentionTarget | null {
	const target = destination.trim();
	if (!target || /^(?:[a-z]:[\\/]|\\\\)/i.test(target)) {
		return { filePath: target };
	}

	const schemeMatch = /^([a-z][a-z\d+.-]*):/i.exec(target);
	if (schemeMatch) {
		const scheme = schemeMatch[1]?.toLocaleLowerCase();
		if (!scheme || NON_MENTION_SCHEMES.has(scheme)) {
			return null;
		}
		if (scheme === "file") {
			const path = target.replace(/^file:\/\/(?:localhost)?/i, "");
			return { filePath: decodeUriPart(path.replace(/^\//, "")) };
		}
		const separator = target.indexOf("://");
		if (separator < 0) {
			return null;
		}
		let resourceId = decodeUriPart(
			target.slice(separator + 3).split(/[?#]/, 1)[0] ?? ""
		);
		if (scheme === "plugin") {
			resourceId = resourceId.split("@", 1)[0] ?? resourceId;
		}
		const kind =
			scheme === "app" && resourceId.startsWith("connector_")
				? "integration"
				: KIND_BY_SCHEME.get(scheme);
		return { kind, resourceId };
	}

	const decoded = decodeUriPart(target).replaceAll("\\", "/");
	if (WORKSPACE_ROOT.test(decoded) && /\.[a-z\d]{1,12}$/i.test(decoded)) {
		return { filePath: decoded };
	}
	return null;
}

function skillNameFromPath(path: string): string | null {
	const parts = decodeUriPart(path).replaceAll("\\", "/").split("/");
	if (parts.at(-1)?.toLocaleLowerCase() !== "skill.md") {
		return null;
	}
	const skillsIndex = parts.findIndex(
		(part) => part.toLocaleLowerCase() === "skills"
	);
	return skillsIndex >= 0 ? (parts[skillsIndex + 1] ?? null) : null;
}

function itemForTarget(
	label: string,
	target: ExternalMentionTarget,
	items: readonly ComposerMentionItem[]
): ComposerMentionItem | undefined {
	const wantedName = normalizedName(label);
	const hintedItems = target.kind
		? items.filter((item) => item.kind === target.kind)
		: [...items];
	const targetId = target.resourceId?.toLocaleLowerCase();
	const matchingId = hintedItems.find((item) => {
		const id = item.id?.toLocaleLowerCase();
		const normalizedTargetId =
			target.kind === "integration"
				? targetId?.replace(/^connector_(?:openai_)?/, "")
				: targetId;
		return Boolean(
			id &&
				(targetId === id ||
					targetId?.endsWith(`:${id}`) ||
					normalizedTargetId === id)
		);
	});
	if (matchingId) {
		return matchingId;
	}
	const matchingName = hintedItems.find(
		(item) => normalizedName(item.label) === wantedName
	);
	if (matchingName || target.kind) {
		return matchingName;
	}
	const matchingNameAcrossKinds = items.find(
		(item) => normalizedName(item.label) === wantedName
	);
	if (matchingNameAcrossKinds) {
		return matchingNameAcrossKinds;
	}
	return items.find((item) => {
		const id = item.id?.toLocaleLowerCase();
		return Boolean(
			id && targetId && (id === targetId || id.endsWith(`:${targetId}`))
		);
	});
}

function hasIncompatibleMentionKind(
	label: string,
	kind: string,
	items: readonly ComposerMentionItem[]
): boolean {
	const wantedName = normalizedName(label);
	return items.some(
		(item) =>
			item.kind !== kind &&
			[item.label, item.id ?? ""].some(
				(value) => normalizedName(value) === wantedName
			)
	);
}

function fileMention(
	path: string,
	items: readonly ComposerMentionItem[]
): string {
	const skillName = skillNameFromPath(path);
	if (skillName) {
		const item = itemForTarget(skillName, { kind: "skill" }, items);
		return `@${item?.label ?? skillName}`;
	}
	const normalizedPath = decodeUriPart(path).replaceAll("\\", "/");
	return `@<${normalizedPath}>`;
}

/** Convert ChatGPT-style custom Markdown links into Ryu's composer mention text. */
export function importMentionMarkdown(
	markdown: string,
	items: readonly ComposerMentionItem[]
): string {
	return markdown.replace(
		MARKDOWN_LINK,
		(
			match,
			imageMarker: string,
			rawLabel: string,
			angleTarget: string | undefined,
			plainTarget: string | undefined
		) => {
			if (imageMarker) {
				return match;
			}
			const target = parseTarget(angleTarget ?? plainTarget ?? "");
			if (!target) {
				return match;
			}
			if (target.filePath !== undefined) {
				return fileMention(target.filePath, items);
			}
			const label = normalizedName(rawLabel);
			if (!label) {
				return match;
			}
			const item = itemForTarget(label, target, items);
			if (
				!item &&
				target.kind &&
				hasIncompatibleMentionKind(label, target.kind, items)
			) {
				return match;
			}
			return `@${item?.label ?? labelFromMarkdown(rawLabel)}`;
		}
	);
}

function labelFromMarkdown(value: string): string {
	return unescapeMarkdown(value)
		.replaceAll("**", "")
		.replaceAll("__", "")
		.trim()
		.replace(/^[$@]/, "")
		.trim();
}

function externalTarget(item: ComposerMentionItem): string {
	const itemId = item.id ?? item.label;
	const id = encodeURIComponent(
		item.kind === "integration" && !itemId.startsWith("connector_")
			? `connector_${itemId}`
			: itemId
	);
	const scheme =
		item.kind === "app-item" &&
		item.ownerId?.toLocaleLowerCase().includes("sites")
			? "sites-project"
			: (SCHEME_BY_KIND.get(item.kind) ?? `ryu-${item.kind}`);
	return `${scheme}://${id}`;
}

function externalLabel(item: ComposerMentionItem): string {
	const label = item.label.replace(/^[$@]/, "");
	if (
		item.kind === "chat" ||
		(item.kind === "app-item" &&
			item.ownerId?.toLocaleLowerCase().includes("sites"))
	) {
		return label;
	}
	return `${item.kind === "app" || item.kind === "integration" || item.kind === "skill" ? "$" : "@"}${label}`;
}

function markdownDestination(path: string): string {
	return /[\s<>]/.test(path) ? `<${path.replaceAll(">", "%3E")}>` : path;
}

function escapeMarkdownLabel(label: string): string {
	return label.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
}

/** Format selected composer text so copied mentions remain typed Markdown links. */
export function exportMentionMarkdown(
	text: string,
	items: readonly ComposerMentionItem[]
): string {
	const pathMentions = text.replace(/@<([^>\n]+)>/g, (_match, path: string) => {
		const basename = path.replaceAll("\\", "/").split("/").at(-1) ?? path;
		return `[${escapeMarkdownLabel(basename)}](${markdownDestination(path)})`;
	});
	const candidates = items
		.filter((item) => item.label.trim())
		.map((item) => ({ item, token: `@${item.label.replace(/^@/, "")}` }))
		.sort((left, right) => right.token.length - left.token.length);
	if (candidates.length === 0) {
		return pathMentions;
	}

	let output = "";
	let cursor = 0;
	while (cursor < pathMentions.length) {
		let match:
			| { end: number; item: ComposerMentionItem; start: number }
			| undefined;
		for (let index = cursor; index < pathMentions.length; index += 1) {
			if (index > 0 && !/[\s([{]/.test(pathMentions[index - 1] ?? "")) {
				continue;
			}
			const candidate = candidates.find(({ token }) =>
				pathMentions.startsWith(token, index)
			);
			if (!candidate) {
				continue;
			}
			const end = index + candidate.token.length;
			const next = pathMentions[end];
			if (next && !/[\s.,;:!?)}\]]/.test(next)) {
				continue;
			}
			match = { end, item: candidate.item, start: index };
			break;
		}
		if (!match) {
			output += pathMentions.slice(cursor);
			break;
		}
		output += pathMentions.slice(cursor, match.start);
		output += `[${escapeMarkdownLabel(externalLabel(match.item))}](${externalTarget(match.item)})`;
		cursor = match.end;
	}
	return output;
}
