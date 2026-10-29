import { z } from "zod";
import type { McpTool } from "@/src/lib/api/mcp.ts";
import {
	type pluginDocumentSchema,
	pluginRecord,
} from "../api/plugin-wire-values.ts";
import type { MentionSourceItem } from "./types.ts";

// These are the mention extension's consumed metadata and resource-link fields,
// not a replacement for the complete MCP tool or call-result transport contract.
const mentionVisibilitySchema = z.array(z.unknown());
const mentionItemsSchema = z.object({ items: z.array(z.unknown()) });
const mentionResourceLinkSchema = z.object({
	type: z.literal("resource_link"),
	uri: z.string().refine((uri) => uri.trim().length > 0),
	name: z.string().refine((name) => name.trim().length > 0),
	description: z.union([z.string(), z.undefined()]).catch(undefined),
});
type MentionResultInput = Parameters<typeof pluginDocumentSchema.parse>[0];

export function isMcpMentionTool(tool: McpTool): boolean {
	const meta = pluginRecord(tool.meta);
	const extensions = pluginRecord(meta?.["openai/extensions"]);
	const ui = pluginRecord(meta?.ui);
	if (!(extensions && "mentions/search" in extensions && ui)) {
		return false;
	}
	const visibility = mentionVisibilitySchema.safeParse(ui.visibility);
	return visibility.success && visibility.data.includes("app");
}

export function mcpMentionSources(
	tool: McpTool,
	result: MentionResultInput
): MentionSourceItem[] {
	const document = pluginRecord(result);
	if (!document) {
		return [];
	}
	const structured =
		"structuredContent" in document ? document.structuredContent : document;
	const parsed = mentionItemsSchema.safeParse(structured);
	if (!parsed.success) {
		return [];
	}
	const sources: MentionSourceItem[] = [];
	for (const value of parsed.data.items.slice(0, 100)) {
		const item = mentionResourceLinkSchema.safeParse(value);
		if (!item.success) {
			continue;
		}
		sources.push({
			id: `${tool.id}:${item.data.uri}`,
			name: item.data.name,
			ownerId: tool.server,
			description: item.data.description ?? tool.server,
			resourceUri: item.data.uri,
		});
	}
	return sources;
}

export function mentionSearchQuery(draft: string): string | null {
	return /(?:^|\s)@([^@\n[\]():]{0,128})$/.exec(draft)?.[1]?.trim() ?? null;
}

export function mentionedMcpResources(
	text: string,
	sources: readonly MentionSourceItem[]
): string[] {
	const references: string[] = [];
	for (const source of sources) {
		if (!source.resourceUri) {
			continue;
		}
		const tokens = [`@${source.id}`, `@${source.name}`];
		if (
			!tokens.some((token) => {
				const index = text.indexOf(token);
				if (index < 0 || (index > 0 && !/\s/.test(text[index - 1] ?? ""))) {
					return false;
				}
				const next = text[index + token.length];
				return next === undefined || /[\s.,;:!?()[\]{}]/.test(next);
			})
		) {
			continue;
		}
		references.push(`${source.name}: ${source.resourceUri}`);
	}
	return references;
}
