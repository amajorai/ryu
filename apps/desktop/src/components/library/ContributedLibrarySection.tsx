import { pluginSidebarSpec } from "@/src/lib/api/plugin-contribution-specs.ts";
// apps/desktop/src/components/library/ContributedLibrarySection.tsx
//
// An app-registered collection rendered inside the Library, from the SAME
// `contributes.sidebar_sections` declaration the sidebar reads.
//
// Why the sidebar contribution and not a new `library_sections` family: an app
// that declares "here is my collection, here is where its rows live, here is the
// route a row opens" has already said everything the Library needs. Asking it to
// say it a second time in a second vocabulary would mean an app could ship a
// sidebar section and a Library tab that disagree — and the sidebar list is the
// one that keeps growing, which is exactly the pile-up the Library exists to
// absorb. One declaration, two surfaces.
//
// Rows come from `spec.source` (a Core `/api/` path fetched through the
// authenticated node seam, mapped by `sourceItemsFromResponse`) and a click opens
// `spec.itemTarget`, the same `{{item.<key>}}` route template the sidebar honours.
// Nothing here is per-app.

import { Package01Icon } from "@hugeicons/core-free-icons";
import {
	isKnownLibraryViewKind,
	renderTemplate,
	type SourceItem,
} from "@ryu/app-host/views";
import {
	LibraryCard,
	LibraryEmpty,
	LibraryGrid,
	LibraryLoading,
} from "@ryu/blocks/desktop/library.tsx";
import type { ViewMode } from "@ryu/blocks/desktop/view-toggle.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Icon } from "@ryu/ui/components/icon.tsx";
import { useMemo } from "react";
import LibraryView from "@/src/components/views/LibraryView.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { parseContributedTarget } from "@/src/contributions/contributed-target.ts";
import type { SidebarSectionSourceData } from "@/src/hooks/useSidebarSectionSource.ts";
import type { PluginSidebarSection } from "@/src/lib/api/plugins.ts";

export default function ContributedLibrarySection({
	section,
	sourceData,
	query,
	view,
}: {
	query: string;
	section: PluginSidebarSection;
	sourceData: SidebarSectionSourceData;
	view: ViewMode;
}) {
	const tl = useLiteralMessages();
	const openTab = useTabSelector((state) => state.openTab);
	const spec = useMemo(() => pluginSidebarSpec(section), [section]);
	const rows: SourceItem[] = sourceData.rows;

	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) {
			return rows;
		}
		return rows.filter((row) =>
			[row.item.title, row.item.subtitle, row.item.accessory]
				.filter(Boolean)
				.join(" ")
				.toLowerCase()
				.includes(q)
		);
	}, [rows, query]);

	const open = (row: SourceItem) => {
		if (!spec?.itemTarget) {
			return;
		}
		const { path: route, options } = parseContributedTarget(
			renderTemplate(spec.itemTarget, { item: row.raw }, { uriEncode: true })
		);
		openTab(route, { ...options, title: row.item.title });
	};

	if (sourceData.isLoading && rows.length === 0) {
		if (isKnownLibraryViewKind(spec?.view)) {
			return (
				<LibraryView
					error={sourceData.error}
					isLoading={sourceData.isLoading}
					onOpen={open}
					rows={visible}
					section={section}
					view={view}
				/>
			);
		}
		return <LibraryLoading />;
	}

	if (isKnownLibraryViewKind(spec?.view)) {
		return (
			<LibraryView
				error={sourceData.error}
				isLoading={sourceData.isLoading}
				onOpen={open}
				rows={visible}
				section={section}
				view={view}
			/>
		);
	}

	if (visible.length === 0) {
		return (
			<LibraryEmpty
				description={
					query
						? "Nothing matches your search."
						: (spec?.emptyState?.description ??
							tl("{title} has nothing in it yet.", {
								title: section.title,
							}))
				}
				icon={Package01Icon}
				title={
					query ? "No results" : (spec?.emptyState?.title ?? "Nothing yet")
				}
			/>
		);
	}

	return (
		<LibraryGrid columns={2} view={view}>
			{visible.map((row) => (
				<LibraryCard
					item={{
						key: row.item.id,
						icon: Package01Icon,
						iconNode: section.icon ? (
							<Icon className="size-4 shrink-0" icon={section.icon} size={16} />
						) : undefined,
						name: row.item.title,
						subtitle: row.item.subtitle ?? null,
						badge: row.item.accessory ?? null,
						// Favouriting is keyed by `{type,id}` over the Library's own item
						// types; a contributed row has no such type, so the star is
						// deliberately absent rather than a control that saves nowhere.
						favorited: false,
					}}
					key={row.item.id}
					onOpen={() => open(row)}
					view={view}
				/>
			))}
		</LibraryGrid>
	);
}
