import {
	ArrowUpRight01Icon,
	FingerPrintIcon,
	PotionIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { SidebarMenu, SidebarMenuItem } from "@ryu/ui/components/sidebar.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AddIdentityDialog } from "@/src/components/identities/AddIdentityDialog.tsx";
import { OpenInNewWindowContextMenuItem } from "@/src/components/layout/OpenInNewWindowMenuItem.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useIdentities } from "@/src/hooks/useIdentities.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { listSkills } from "@/src/lib/api/skills.ts";
import { openEntityInNewWindow } from "@/src/lib/window-routing.ts";
import { OverflowTooltip } from "./overflow-tooltip.tsx";
import { SectionLoadError } from "./sidebar-agents-section.tsx";
import {
	SectionAddButton,
	type SectionProps,
	SidebarSection,
} from "./sidebar-section.tsx";
import { SectionPagingControls } from "./sidebar-section-overflow.tsx";
import {
	NAMED_SORT_ACCESSORS,
	sortItems,
	usePaged,
} from "./sidebar-sort-paging.ts";

/** Identities list in the sidebar — saved login profiles agents reuse. Each row
 *  is a profile (a named grouping of per-domain connections). Rows open the
 *  identities manage page focused on that profile; "+" opens create. Hidden by
 *  default. This is the picker; the manage tab is create/edit only. */
export function IdentitiesSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const tl = useLiteralMessages();
	const { profiles, loading, error, refetch, create } = useIdentities();
	const openTab = useTabSelector((state) => state.openTab);
	const [addDialogOpen, setAddDialogOpen] = useState(false);
	const rows = useMemo(
		() =>
			profiles.map((profile) => ({
				id: profile.profile_id,
				name: profile.profile_id,
				count: profile.connections.length,
			})),
		[profiles]
	);
	const paged = usePaged(sortItems(rows, sort, NAMED_SORT_ACCESSORS), pageSize);

	const openIdentity = (profileId: string, forceNew = false) =>
		openTab(`/identities/profile/${encodeURIComponent(profileId)}`, {
			title: profileId,
			forceNew,
		});

	const emptyMessage = loading ? "Loading…" : "No identities yet";

	const renderIdentityRows = (list: typeof rows) =>
		list.map((row) => (
			<SidebarMenuItem key={row.id}>
				<ContextMenu>
					<ContextMenuTrigger>
						{/* sidebar row combines nested controls with drag/middle-click */}
						<div
							className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
							onAuxClick={(e) => {
								if (e.button === 1) {
									e.preventDefault();
									openIdentity(row.id, true);
								}
							}}
							onClick={() => openIdentity(row.id)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									openIdentity(row.id);
								}
							}}
							role="button"
							tabIndex={0}
						>
							<HugeiconsIcon
								className="size-4 shrink-0 text-muted-foreground"
								icon={FingerPrintIcon}
							/>
							<OverflowTooltip
								className="min-w-0 flex-1 truncate text-sm"
								text={row.name}
							/>
							<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
								{formatCount(row.count) ?? "—"}
							</span>
						</div>
					</ContextMenuTrigger>
					<ContextMenuContent>
						<ContextMenuItem onClick={() => openIdentity(row.id, true)}>
							<HugeiconsIcon
								className="mr-2 size-4"
								icon={ArrowUpRight01Icon}
							/>
							Open in new tab
						</ContextMenuItem>
						<OpenInNewWindowContextMenuItem
							onClick={() =>
								void openEntityInNewWindow({
									path: `/identities/profile/${encodeURIComponent(row.id)}`,
									title: row.name,
								})
							}
						/>
					</ContextMenuContent>
				</ContextMenu>
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={
				<SectionAddButton
					onClick={() => setAddDialogOpen(true)}
					title="Add identity"
				/>
			}
			collapsed={collapsed}
			dnd={dnd}
			label="Identities"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="identities"
			sort={sort}
		>
			{error && profiles.length === 0 && (
				<SectionLoadError
					message="Couldn't load your identities."
					onRetry={refetch}
				/>
			)}
			{!error && profiles.length === 0 && (
				<p className="px-2 py-2 text-muted-foreground text-xs">
					{emptyMessage}
				</p>
			)}
			{profiles.length > 0 && (
				<>
					<SidebarMenu>{renderIdentityRows(paged.visible)}</SidebarMenu>
					<SectionPagingControls
						overflow={{
							getSearchText: (row) => row.name ?? "",
							items: paged.items,
							label: "identities",
							renderList: (list) => (
								<SidebarMenu>{renderIdentityRows(list)}</SidebarMenu>
							),
						}}
						paged={paged}
					/>
				</>
			)}
			<AddIdentityDialog
				existingProfileIds={profiles.map((p) => p.profile_id)}
				onCreate={async (input) => {
					try {
						await create(input);
						toast.success({
							title: tl("Connection for {domain} created", {
								domain: input.domain,
							}),
						});
					} catch (e) {
						toast.error({
							title:
								e instanceof Error ? e.message : "Could not create connection",
						});
					}
				}}
				onOpenChange={setAddDialogOpen}
				open={addDialogOpen}
			/>
		</SidebarSection>
	);
}

/** Skills list in the sidebar — the user's installed agent skills. Rows and the
 *  "+" open the Skills store page. Hidden by default (opt-in feature). Queries
 *  the installed set directly (not `useSkillsCatalog`, which also fetches the
 *  remote directory) so mounting the section stays cheap. */
export function SkillsSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const openTab = useTabSelector((state) => state.openTab);
	const node = useActiveNode();
	const target: ApiTarget = {
		url: node.url,
		token: node.token ?? null,
		userJwt: node.userJwt ?? null,
	};
	const skillsQuery = useQuery({
		queryKey: ["skills", "installed", target.url],
		queryFn: () => listSkills(target),
	});
	const skills = skillsQuery.data ?? [];
	const paged = usePaged(
		sortItems(skills, sort, NAMED_SORT_ACCESSORS),
		pageSize
	);

	const openSkills = (forceNew = false) =>
		openTab("/skills", { title: "Skills", forceNew });

	const emptyMessage = skillsQuery.isLoading
		? "Loading…"
		: "No skills installed";

	const renderSkillRows = (list: typeof skills) =>
		list.map((skill) => (
			<SidebarMenuItem key={skill.id}>
				<ContextMenu>
					<ContextMenuTrigger>
						{/* sidebar row combines nested controls with drag/middle-click */}
						<div
							className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
							onAuxClick={(e) => {
								if (e.button === 1) {
									e.preventDefault();
									openSkills(true);
								}
							}}
							onClick={() => openSkills()}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									openSkills();
								}
							}}
							role="button"
							tabIndex={0}
						>
							<HugeiconsIcon
								className="size-4 shrink-0 text-muted-foreground"
								icon={PotionIcon}
							/>
							<OverflowTooltip
								className="min-w-0 flex-1 truncate text-sm"
								text={skill.name}
							/>
							{!skill.enabled && (
								<span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
							)}
						</div>
					</ContextMenuTrigger>
					<ContextMenuContent>
						<ContextMenuItem onClick={() => openSkills(true)}>
							<HugeiconsIcon
								className="mr-2 size-4"
								icon={ArrowUpRight01Icon}
							/>
							Open in new tab
						</ContextMenuItem>
						<OpenInNewWindowContextMenuItem
							onClick={() =>
								void openEntityInNewWindow({ path: "/skills", title: "Skills" })
							}
						/>
					</ContextMenuContent>
				</ContextMenu>
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={
				<SectionAddButton onClick={() => openSkills()} title="Add skill" />
			}
			collapsed={collapsed}
			dnd={dnd}
			label="Skills"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="skills"
			sort={sort}
		>
			{skillsQuery.isError && skills.length === 0 && (
				<SectionLoadError
					message="Couldn't load your skills."
					onRetry={() => {
						skillsQuery.refetch().catch(() => undefined);
					}}
				/>
			)}
			{!skillsQuery.isError && skills.length === 0 && (
				<p className="px-2 py-2 text-muted-foreground text-xs">
					{emptyMessage}
				</p>
			)}
			{skills.length > 0 && (
				<>
					<SidebarMenu>{renderSkillRows(paged.visible)}</SidebarMenu>
					<SectionPagingControls
						overflow={{
							getSearchText: (skill) => skill.name ?? "",
							items: paged.items,
							label: "skills",
							renderList: (list) => (
								<SidebarMenu>{renderSkillRows(list)}</SidebarMenu>
							),
						}}
						paged={paged}
					/>
				</>
			)}
		</SidebarSection>
	);
}
