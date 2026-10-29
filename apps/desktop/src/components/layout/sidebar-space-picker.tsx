import {
	ArrowUpRight01Icon,
	DatabaseIcon,
	File01Icon,
	ImageAdd01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { GlyphDisplay } from "@ryu/ui/components/glyph-display.tsx";
import { SidebarMenu, SidebarMenuItem } from "@ryu/ui/components/sidebar.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { EntityIconDialog } from "@/src/components/layout/EntityIconDialog.tsx";
import { OpenInNewWindowContextMenuItem } from "@/src/components/layout/OpenInNewWindowMenuItem.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useChatDateGrouping } from "@/src/hooks/useChatDateGrouping.ts";
import type { Space, SpaceDocument } from "@/src/lib/api/spaces.ts";
import { toEpoch } from "@/src/lib/sidebar/date-buckets.ts";
import { OverflowTooltip } from "./overflow-tooltip.tsx";
import { SectionPagingControls } from "./sidebar-section-overflow.tsx";
import {
	type SortKey,
	SPACE_DOC_SORT_ACCESSORS,
	sortItems,
	spaceDocumentStamp,
	usePaged,
} from "./sidebar-sort-paging.ts";
import {
	DateGroupedRows,
	dateBucketStorageKeys,
} from "./sidebar-subsection.tsx";

/**
 * The picker's document list: every space's pages, databases and files at once, or
 * just the selected space's.
 *
 * "All spaces" is an AGGREGATE fetch — one `listDocuments` per space, in parallel —
 * because Core has no cross-space document endpoint. Three things keep that from
 * being reckless. It only mounts while the section is EXPANDED (`SidebarSection`
 * does not render collapsed children), so a collapsed section still costs nothing.
 * A per-space failure degrades to "no documents from that space" rather than
 * failing the whole list. And the result is PAGED before it renders: the Uploads
 * system space alone accumulates every chat attachment and editor paste ever made
 * on this node, so an unpaged aggregate would put thousands of rows in the sidebar.
 * That last point is also why paging wraps the date-bucketed path here, unlike the
 * Chats section — there, the bucketed set is bounded by the chat list itself.
 */
export function SpacesPickerBody({
	listDocuments,
	onOpenDoc,
	onOpenInNewWindow,
	pageSize,
	setDocumentIcon,
	sort,
	spaces,
}: {
	listDocuments: (spaceId: string) => Promise<SpaceDocument[]>;
	onOpenDoc: (doc: SpaceDocument, forceNew?: boolean) => void;
	onOpenInNewWindow?: (doc: SpaceDocument) => void;
	pageSize: number;
	setDocumentIcon: (
		spaceId: string,
		documentId: string,
		icon: GlyphValue
	) => Promise<void>;
	sort: SortKey;
	/** The spaces in scope: one, or all of them. */
	spaces: Space[];
}) {
	const [groupByDate] = useChatDateGrouping();
	const [docs, setDocs] = useState<SpaceDocument[]>([]);
	const [loading, setLoading] = useState(true);
	const listRef = useRef(listDocuments);
	listRef.current = listDocuments;
	// `useSpaces` re-runs through `useCoreRefresh`, so the `spaces` ARRAY identity
	// churns even when its contents did not. Depending on the joined ids instead
	// keeps this from re-fetching every list on every refresh tick.
	const spaceIds = spaces.map((s) => s.id).join(",");

	useEffect(() => {
		let cancelled = false;
		const ids = spaceIds ? spaceIds.split(",") : [];
		if (ids.length === 0) {
			setDocs([]);
			setLoading(false);
			return;
		}
		setLoading(true);
		Promise.all(
			ids.map((id) => listRef.current(id).catch((): SpaceDocument[] => []))
		)
			.then((lists) => {
				if (!cancelled) {
					setDocs(lists.flat());
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [spaceIds]);

	// Newest-first across the union, so a mixed list reads chronologically rather
	// than space-by-space; `sort` then re-orders it if the user picked an option.
	const ordered = useMemo(
		() => [...docs].sort((a, b) => toEpoch(b.createdAt) - toEpoch(a.createdAt)),
		[docs]
	);
	const paged = usePaged(
		sortItems(ordered, sort, SPACE_DOC_SORT_ACCESSORS),
		pageSize
	);

	const applyIcon = (docId: string, icon: GlyphValue) =>
		setDocs((prev) => prev.map((d) => (d.id === docId ? { ...d, icon } : d)));

	const renderRows = (list: SpaceDocument[]) => (
		<SpaceDocRows
			docs={list}
			onIconChanged={applyIcon}
			onOpenDoc={onOpenDoc}
			onOpenInNewWindow={onOpenInNewWindow}
			setDocumentIcon={setDocumentIcon}
		/>
	);

	if (loading) {
		return <p className="px-2 py-2 text-muted-foreground text-xs">Loading…</p>;
	}
	if (ordered.length === 0) {
		return (
			<p className="px-2 py-2 text-muted-foreground text-xs">No pages yet</p>
		);
	}

	return (
		<>
			{groupByDate ? (
				<DateGroupedRows
					className="ml-2 space-y-0.5"
					collapsedKey={
						dateBucketStorageKeys(`spaces-picker:${spaceIds}`).collapsedKey
					}
					items={paged.visible}
					// Remount when the scope changes — see the same `key` on
					// {@link SidebarChatList} for why.
					key={spaceIds}
					orderKey={dateBucketStorageKeys(`spaces-picker:${spaceIds}`).orderKey}
					renderRows={renderRows}
					stampOf={spaceDocumentStamp}
				/>
			) : (
				renderRows(paged.visible)
			)}
			<SectionPagingControls
				overflow={{
					getSearchText: (d) => d.title ?? "",
					items: paged.items,
					label: "pages",
					renderList: renderRows,
				}}
				paged={paged}
			/>
		</>
	);
}

/** Spaces list in the sidebar — mirrors Agents; rows open the Spaces tab.
 *  The "+" opens the create dialog inline (shared with the Spaces page via the
 *  SpacesProvider), so a new space appears here and in the page immediately. */
/**
 * A run of space documents as sidebar rows.
 *
 * Space-AGNOSTIC on purpose: every row routes through its own `doc.spaceId` rather
 * than a `spaceId` passed alongside, which is what lets the per-space list and the
 * picker's "All spaces" list (documents from many spaces interleaved) render the
 * identical row instead of growing a second copy that drifts.
 */
function SpaceDocRows({
	docs,
	onIconChanged,
	onOpenDoc,
	onOpenInNewWindow,
	setDocumentIcon,
}: {
	docs: SpaceDocument[];
	/** Let the owner of the list apply the new icon optimistically. */
	onIconChanged: (docId: string, icon: GlyphValue) => void;
	onOpenDoc: (doc: SpaceDocument, forceNew?: boolean) => void;
	onOpenInNewWindow?: (doc: SpaceDocument) => void;
	setDocumentIcon: (
		spaceId: string,
		documentId: string,
		icon: GlyphValue
	) => Promise<void>;
}) {
	const updateTabsIconWhere = useTabSelector(
		(state) => state.updateTabsIconWhere
	);
	const [iconTarget, setIconTarget] = useState<SpaceDocument | null>(null);
	return (
		<>
			<SidebarMenu>
				{docs.map((doc) => (
					<SidebarMenuItem key={doc.id}>
						<ContextMenu>
							<ContextMenuTrigger>
								<button
									className="flex h-7 w-full items-center gap-2 rounded-md pr-2 pl-8 text-left transition-colors hover:bg-muted"
									data-prefetch-path={spaceDocPath(doc.spaceId, doc)}
									onAuxClick={(e) => {
										if (e.button === 1) {
											e.preventDefault();
											onOpenDoc(doc, true);
										}
									}}
									onClick={() => onOpenDoc(doc)}
									type="button"
								>
									<GlyphDisplay
										className="shrink-0"
										fallback={
											<HugeiconsIcon
												className="size-3 shrink-0 text-muted-foreground"
												icon={
													doc.kind === "database" ? DatabaseIcon : File01Icon
												}
											/>
										}
										size={12}
										tone="muted"
										value={doc.icon}
									/>
									<OverflowTooltip
										className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-muted-foreground text-xs"
										fade
										text={doc.title}
									/>
								</button>
							</ContextMenuTrigger>
							<ContextMenuContent>
								<ContextMenuItem onClick={() => onOpenDoc(doc, true)}>
									<HugeiconsIcon
										className="mr-2 size-4"
										icon={ArrowUpRight01Icon}
									/>
									Open in new tab
								</ContextMenuItem>
								{onOpenInNewWindow ? (
									<OpenInNewWindowContextMenuItem
										onClick={() => onOpenInNewWindow(doc)}
									/>
								) : null}
								<ContextMenuItem onClick={() => setIconTarget(doc)}>
									<HugeiconsIcon
										className="mr-2 size-4"
										icon={ImageAdd01Icon}
									/>
									Change icon…
								</ContextMenuItem>
							</ContextMenuContent>
						</ContextMenu>
					</SidebarMenuItem>
				))}
			</SidebarMenu>
			{iconTarget ? (
				<EntityIconDialog
					description={iconTarget.title}
					onChange={(next) => {
						const docId = iconTarget.id;
						const spaceId = iconTarget.spaceId;
						onIconChanged(docId, next);
						updateTabsIconWhere(
							(t) =>
								t.path === `/spaces/${spaceId}/doc/${docId}` ||
								t.path === `/spaces/${spaceId}/db/${docId}`,
							next
						);
						void setDocumentIcon(spaceId, docId, next).catch(() => {
							toast.error("Couldn't update page icon");
						});
					}}
					onOpenChange={(open) => {
						if (!open) {
							setIconTarget(null);
						}
					}}
					open
					title="Page icon"
					value={iconTarget.icon}
				/>
			) : null}
		</>
	);
}

/** Lazily-loaded list of a space's pages & databases, shown indented under its
 *  row (mirrors SidebarSideChats). Only mounted while the row is expanded, so
 *  collapsed rows never hit Core. Each entry opens its editor tab. Date-bucketed
 *  when the user's "Group lists by date" setting is on — which is how the Uploads
 *  space, the one that accumulates every attachment, becomes scannable. */
export function SidebarSpaceDocs({
	spaceId,
	listDocuments,
	onOpenDoc,
	onOpenInNewWindow,
	setDocumentIcon,
}: {
	listDocuments: (spaceId: string) => Promise<SpaceDocument[]>;
	onOpenDoc: (doc: SpaceDocument, forceNew?: boolean) => void;
	onOpenInNewWindow?: (doc: SpaceDocument) => void;
	setDocumentIcon: (
		spaceId: string,
		documentId: string,
		icon: GlyphValue
	) => Promise<void>;
	spaceId: string;
}) {
	const [groupByDate] = useChatDateGrouping();
	const [docs, setDocs] = useState<SpaceDocument[]>([]);
	const [loading, setLoading] = useState(true);
	const listRef = useRef(listDocuments);
	listRef.current = listDocuments;

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		listRef
			.current(spaceId)
			.then((list) => {
				if (!cancelled) {
					setDocs(list);
				}
			})
			.catch(() => {
				/* treated as no documents */
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [spaceId]);

	const applyIcon = (docId: string, icon: GlyphValue) =>
		setDocs((prev) => prev.map((d) => (d.id === docId ? { ...d, icon } : d)));

	const renderRows = (list: SpaceDocument[]) => (
		<SpaceDocRows
			docs={list}
			onIconChanged={applyIcon}
			onOpenDoc={onOpenDoc}
			onOpenInNewWindow={onOpenInNewWindow}
			setDocumentIcon={setDocumentIcon}
		/>
	);

	if (loading) {
		return <p className="py-1 pl-8 text-muted-foreground text-xs">Loading…</p>;
	}
	if (docs.length === 0) {
		return (
			<p className="py-1 pl-8 text-muted-foreground text-xs">No pages yet</p>
		);
	}
	if (!groupByDate) {
		return renderRows(docs);
	}
	// `ml-6` rather than the Chats buckets' `ml-2`: these rows are already indented
	// to `pl-8` under their space, so a bucket header at the section indent would
	// float far to the left of what it introduces.
	return (
		<DateGroupedRows
			className="ml-6 space-y-0.5"
			collapsedKey={dateBucketStorageKeys(`space:${spaceId}`).collapsedKey}
			items={docs}
			orderKey={dateBucketStorageKeys(`space:${spaceId}`).orderKey}
			renderRows={renderRows}
			stampOf={spaceDocumentStamp}
		/>
	);
}

/** A single space row. Clicking the row toggles an indented list of its pages &
 *  databases (like a project folder expands to its chats); right-click opens the
 *  space page or deletes it. */
/** The tab route for a document inside a space (databases use the data-grid
 *  route, stored files their viewer, pages the markdown editor). */
export function spaceDocPath(
	spaceId: string,
	doc: Pick<SpaceDocument, "id" | "kind" | "rawKind">
): string {
	const segment =
		doc.rawKind === "file" ? "file" : doc.kind === "database" ? "db" : "doc";
	return `/spaces/${spaceId}/${segment}/${doc.id}`;
}
