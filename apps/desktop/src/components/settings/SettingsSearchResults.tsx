// The settings-search result list that replaces the sidebar nav while a query
// is typed.
//
// Both dialogs render this from the same index, so one search box answers "where
// is X" regardless of which dialog you happened to open — a result that lives in
// the other dialog says so on its row and switches dialogs when clicked. That
// cross-dialog reach is the whole point: a user does not know (or care) that
// "Safety filters" is node-scoped and "Animate streaming chat text" is
// client-scoped; they only know they typed a word.

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@ryu/ui/components/sidebar.tsx";
import { useMemo } from "react";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import { isRyuBot } from "@/src/lib/product.ts";
import { useProductModeStore } from "@/src/lib/product-mode.ts";
import {
	type SettingsDialogId,
	type SettingsEntry,
	searchSettings,
	sectionLabel,
	visibleSettingsEntries,
} from "@/src/lib/settings-index.ts";

interface SettingsSearchResultsProps {
	/** Which dialog is rendering this — a result elsewhere gets a "→" hint. */
	currentDialog: SettingsDialogId;
	/** Called with the clicked entry; the host navigates (and may switch dialogs). */
	onSelect: (entry: SettingsEntry) => void;
	/** The raw query text. Trimmed here, so callers can pass it verbatim. */
	query: string;
	/**
	 * Whether to print "no setting matches" when nothing hits. False when the
	 * host already shows matching SECTIONS above — two empty-state messages under
	 * a list that clearly has results reads as a bug.
	 */
	showEmptyState?: boolean;
}

/** Rows sharing a section, in index order, under one heading. */
interface ResultGroup {
	entries: SettingsEntry[];
	key: string;
	title: string;
}

function groupResults(
	entries: SettingsEntry[],
	currentDialog: SettingsDialogId
): ResultGroup[] {
	const groups: ResultGroup[] = [];
	const byKey = new Map<string, ResultGroup>();
	for (const entry of entries) {
		const key = `${entry.dialog}:${entry.section}`;
		let group = byKey.get(key);
		if (!group) {
			group = {
				key,
				// Results from the other dialog are labelled with where they live, so
				// clicking one is never a surprise jump into a different modal.
				title:
					entry.dialog === currentDialog
						? sectionLabel(entry)
						: `${sectionLabel(entry)} · ${entry.dialog === "gateway" ? "Node" : "App"}`,
				entries: [],
			};
			byKey.set(key, group);
			groups.push(group);
		}
		group.entries.push(entry);
	}
	return groups;
}

export function SettingsSearchResults({
	currentDialog,
	onSelect,
	query,
	showEmptyState = true,
}: SettingsSearchResultsProps) {
	const tl = useLiteralMessages();
	const { isDesktop } = useAppSurface();
	const osAccess = useProductModeStore((state) => state.osAccess);
	const workspace = osAccess && !isRyuBot();
	const groups = useMemo(
		() =>
			groupResults(
				visibleSettingsEntries(searchSettings(query), isDesktop, workspace),
				currentDialog
			),
		[query, currentDialog, isDesktop, workspace]
	);

	if (groups.length === 0) {
		if (!showEmptyState) {
			return null;
		}
		return (
			<SidebarGroup spacing="compact">
				<p className="px-2 text-muted-foreground text-xs">
					{tl("No setting matches “{query}”.", { query: query.trim() })}
				</p>
			</SidebarGroup>
		);
	}

	return (
		<>
			{groups.map((group) => (
				<SidebarGroup key={group.key} spacing="compact">
					<SidebarGroupLabel>{group.title}</SidebarGroupLabel>
					<SidebarMenu>
						{group.entries.map((entry) => (
							<SidebarMenuItem key={entry.id}>
								<SidebarMenuButton
									className="h-auto"
									onClick={() => onSelect(entry)}
									purpose="settings-search"
								>
									<span className="flex min-w-0 flex-col items-start gap-0.5">
										<span className="truncate" title={entry.label}>
											{entry.label}
										</span>
										{entry.group ? (
											<span
												className="truncate text-muted-foreground text-xs"
												title={entry.group}
											>
												{entry.group}
											</span>
										) : null}
									</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
						))}
					</SidebarMenu>
				</SidebarGroup>
			))}
		</>
	);
}
