// The rows of an app-registered sidebar section: the single-line or
// avatar-led "messaging" row, its hover preview, and its context menu. Shared by
// the flat list and each date bucket so both render the identical row.

import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	renderTemplate,
	type SourceItem,
	type ViewActionHttp,
	type ViewSourceRow,
} from "@ryu/app-host/views";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { asGlyphValue } from "@ryu/ui/components/glyph.ts";
import { GlyphDisplay } from "@ryu/ui/components/glyph-display.tsx";
import { Icon } from "@ryu/ui/components/icon.tsx";
import { SidebarMenu, SidebarMenuItem } from "@ryu/ui/components/sidebar.tsx";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { OpenInNewWindowContextMenuItem } from "@/src/components/layout/OpenInNewWindowMenuItem.tsx";
import type { pluginSidebarSpec } from "@/src/lib/api/plugin-contribution-specs.ts";
import type { PluginSidebarSection } from "@/src/lib/api/plugins.ts";
import {
	SidebarItemPreview,
	SidebarPreviewMeta,
	SidebarPreviewTitle,
} from "./sidebar-item-preview.tsx";
import {
	EntityRowGlyph,
	type useContributedRowsFor,
} from "./tab-entity-menu.tsx";

type SidebarSpec = NonNullable<ReturnType<typeof pluginSidebarSpec>>;

export interface ContributedRowsContext {
	contribution: PluginSidebarSection;
	entityRowsFor: ReturnType<typeof useContributedRowsFor>;
	itemActions: NonNullable<SidebarSpec["itemActions"]>;
	messagingRows: boolean;
	openTarget: (item: ViewSourceRow, title: string, forceNew?: boolean) => void;
	openTargetInNewWindow: (item: ViewSourceRow, title: string) => void;
	runAction: (http: ViewActionHttp, item: ViewSourceRow) => Promise<void>;
	spec: ReturnType<typeof pluginSidebarSpec>;
}

export function renderContributedSectionRows(
	list: SourceItem[],
	{
		contribution,
		entityRowsFor,
		itemActions,
		messagingRows,
		openTarget,
		openTargetInNewWindow,
		runAction,
		spec,
	}: ContributedRowsContext
) {
	return (
		<SidebarMenu>
			{list.map((row) => {
				const title = row.item.title;
				// Every row is one 32px line; supporting text (its project, say)
				// moves to the hover preview.
				const subtitle = row.item.subtitle;
				const open = (forceNew = false) => openTarget(row.raw, title, forceNew);
				const entityRows = spec?.entity ? entityRowsFor(row.item.id) : [];
				return (
					<SidebarMenuItem key={row.item.id}>
						<ContextMenu>
							<ContextMenuTrigger>
								{/* sidebar row combines nested controls with drag/middle-click */}
								<div
									className={
										"group/row flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm transition-colors duration-150 hover:bg-sidebar-accent/60 hover:duration-0"
									}
									onAuxClick={(e) => {
										if (e.button === 1) {
											e.preventDefault();
											open(true);
										}
									}}
									onClick={() => open()}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											open();
										}
									}}
									role="button"
									tabIndex={0}
								>
									{(() => {
										// `row.item.icon` is the MAPPED glyph, which defaults to the
										// raw row's `icon` key — the field this read directly before
										// the map could name it. Unmapped feeds are unaffected.
										const glyph = asGlyphValue(row.item.icon) ?? null;
										const sectionGlyph = contribution.icon ? (
											<Icon
												className={messagingRows ? "size-4" : "size-4 shrink-0"}
												icon={contribution.icon}
												size={16}
												tone="muted"
											/>
										) : null;
										if (!messagingRows) {
											return (
												<GlyphDisplay
													className="size-4 shrink-0"
													fallback={sectionGlyph}
													size={16}
													tone="muted"
													value={glyph}
												/>
											);
										}
										// The avatar-led lead: the row's own picture when the feed
										// has one, else the same glyph in the circle the picture
										// would have filled, so the column stays aligned.
										const safeAvatar = safeMediaUrl(row.item.avatar);
										return safeAvatar ? (
											<img
												alt=""
												className="size-5 shrink-0 rounded-full bg-muted object-cover"
												src={safeAvatar}
											/>
										) : (
											<span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted">
												<GlyphDisplay
													className="size-3.5"
													fallback={sectionGlyph}
													size={14}
													tone="muted"
													value={glyph}
												/>
											</span>
										);
									})()}
									<SidebarItemPreview
										content={
											<SidebarPreviewTitle
												title={
													spec?.itemPreview?.title
														? renderTemplate(
																spec.itemPreview.title,
																{ item: row.raw },
																{}
															)
														: title
												}
											>
												{subtitle ? (
													<p className="text-muted-foreground text-xs">
														{subtitle}
													</p>
												) : null}
												{spec?.itemPreview?.description ? (
													<p className="line-clamp-4 text-muted-foreground text-xs leading-relaxed">
														{renderTemplate(
															spec.itemPreview.description,
															{ item: row.raw },
															{}
														)}
													</p>
												) : null}
												{spec?.itemPreview?.meta?.map((meta) => (
													<SidebarPreviewMeta
														key={meta.label}
														label={meta.label}
														value={renderTemplate(
															meta.value,
															{ item: row.raw },
															{}
														)}
													/>
												))}
											</SidebarPreviewTitle>
										}
									>
										<span className="flex min-w-0 flex-1 items-center gap-2">
											<span className="min-w-0 flex-1 truncate">{title}</span>
											{/* The mapped `accessory` is the stamp on a messaging row —
											    the slot the shell's agent row gives the time of the
											    last message. */}
											{messagingRows && row.item.accessory ? (
												<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
													{row.item.accessory}
												</span>
											) : null}
										</span>
									</SidebarItemPreview>
								</div>
							</ContextMenuTrigger>
							<ContextMenuContent>
								{spec?.itemTarget ? (
									<>
										<ContextMenuItem onClick={() => open(true)}>
											<HugeiconsIcon
												className="size-4"
												icon={ArrowUpRight01Icon}
											/>
											Open in new tab
										</ContextMenuItem>
										<OpenInNewWindowContextMenuItem
											onClick={() => openTargetInNewWindow(row.raw, title)}
										/>
									</>
								) : null}
								{itemActions.map((action) =>
									action.http ? (
										<ContextMenuItem
											key={action.id}
											onClick={() => {
												if (action.http) {
													void runAction(action.http, row.raw);
												}
											}}
											variant={
												action.style === "danger" ? "destructive" : undefined
											}
										>
											{action.icon ? (
												<Icon className="size-4" icon={action.icon} size={16} />
											) : null}
											{action.label}
										</ContextMenuItem>
									) : null
								)}
								{entityRows.map((entityRow) => (
									<ContextMenuItem
										key={entityRow.id}
										onClick={entityRow.onSelect}
									>
										<span className="inline-flex">
											<EntityRowGlyph row={entityRow} />
										</span>
										{entityRow.label}
									</ContextMenuItem>
								))}
							</ContextMenuContent>
						</ContextMenu>
					</SidebarMenuItem>
				);
			})}
		</SidebarMenu>
	);
}
