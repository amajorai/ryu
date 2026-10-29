import { renderTemplate, type SourceItem } from "@ryu/app-host/views";
import { parseContributedTarget } from "@/src/contributions/contributed-target.ts";
import type { OutputStyleSummary } from "@/src/lib/api/output-styles.ts";
import { pluginSidebarSpec } from "@/src/lib/api/plugin-contribution-specs.ts";
import type { PluginSidebarSection } from "@/src/lib/api/plugins.ts";
import type { Space, SpaceDocument } from "@/src/lib/api/spaces.ts";
import type {
	MentionSourceItem,
	MentionSources,
} from "@/src/lib/mentions/types.ts";

/** The rows a contributed section already fetched for the sidebar/Library seam. */
export interface ContributedMentionSectionData {
	contribution: PluginSidebarSection;
	rows: readonly SourceItem[];
}

/** Convert an app's existing sidebar-section rows into chat mention sources. */
export function buildContributedMentionSources(
	sections: readonly ContributedMentionSectionData[]
): MentionSources["appItems"] {
	const items: MentionSources["appItems"] = [];

	for (const { contribution, rows } of sections) {
		const itemTarget = pluginSidebarSpec(contribution)?.itemTarget;
		if (!itemTarget) {
			continue;
		}

		for (const row of rows) {
			const renderedTarget = renderTemplate(
				itemTarget,
				{ item: row.raw },
				{ uriEncode: true }
			);
			const target = parseContributedTarget(renderedTarget);
			if (!target.path) {
				continue;
			}

			const detail = row.item.subtitle ?? row.item.detail ?? row.item.accessory;
			items.push({
				description: [contribution.title, detail]
					.filter((value): value is string => Boolean(value?.trim()))
					.join(" · "),
				id: `${contribution.plugin}:${contribution.id}:${row.item.id}`,
				name: row.item.title,
				ownerId: contribution.plugin,
				target,
			});
		}
	}

	return items;
}

function documentSegment(kind: SpaceDocument["kind"]): string {
	if (kind === "database") {
		return "db";
	}
	if (kind === "whiteboard") {
		return "wb";
	}
	return "doc";
}

function documentKindLabel(kind: SpaceDocument["kind"]): string {
	if (kind === "database") {
		return "Database";
	}
	if (kind === "whiteboard") {
		return "Whiteboard";
	}
	return "Page";
}

/** Build navigable mentions for documents already listed in each Space. */
export function buildSpacePageMentionSources(
	spaces: readonly Space[],
	documentsBySpace: readonly (readonly SpaceDocument[])[]
): MentionSources["pages"] {
	const pages: MentionSources["pages"] = [];

	for (const [index, space] of spaces.entries()) {
		for (const document of documentsBySpace[index] ?? []) {
			const title = document.title.trim() || "Untitled";
			pages.push({
				description: `${space.name} · ${documentKindLabel(document.kind)}`,
				id: `${space.id}:${document.id}`,
				name: title,
				target: {
					path: `/spaces/${encodeURIComponent(space.id)}/${documentSegment(document.kind)}/${encodeURIComponent(document.id)}`,
				},
			});
		}
	}

	return pages;
}

/** Convert the node's available personality profiles into navigable references. */
export function buildOutputStyleMentionSources(
	styles: readonly OutputStyleSummary[]
): MentionSources["outputStyles"] {
	return styles.map((style): MentionSourceItem => {
		const description = style.description?.trim();
		return {
			description: description || undefined,
			id: style.id,
			name: style.name,
			target: { path: "/library/agent" },
		};
	});
}
