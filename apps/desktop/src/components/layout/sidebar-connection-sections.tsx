import {
	ArrowUpRight01Icon,
	ConnectIcon,
	Tv01Icon,
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
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { useMemo } from "react";
import { AddChannelDialog } from "@/src/components/channels/AddChannelDialog.tsx";
import { OpenInNewWindowContextMenuItem } from "@/src/components/layout/OpenInNewWindowMenuItem.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useChannels } from "@/src/hooks/useChannels.ts";
import {
	useComposioConnections,
	useComposioStatus,
	useComposioToolkits,
} from "@/src/hooks/useComposioCatalog.ts";
import { useTeams } from "@/src/hooks/useTeams.ts";
import { CHANNEL_LABELS } from "@/src/lib/api/channels.ts";
import { openEntityInNewWindow } from "@/src/lib/window-routing.ts";
import { useChannelSetupDialog } from "@/src/store/useChannelSetupDialog.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
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

/** Channels list in the sidebar — each row is a Telegram/Slack/WhatsApp/Discord
 *  bot. Rows open the channel manage page; "+" opens create. Hidden by default
 *  (opt-in feature). This is the picker; the manage tab is create/edit only. */
export function ChannelsSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const tl = useLiteralMessages();
	const { channels, loading, authed, create, refresh } = useChannels();
	const { agents } = useAgents();
	const { teams } = useTeams();
	const openTab = useTabSelector((state) => state.openTab);
	const {
		open: addDialogOpen,
		request: channelSetupRequest,
		setOpen: setAddDialogOpen,
	} = useChannelSetupDialog();
	const paged = usePaged(
		sortItems(channels, sort, NAMED_SORT_ACCESSORS),
		pageSize
	);

	const openChannel = (id: string, name: string, forceNew = false) =>
		openTab(`/channels/${id}`, { title: name, forceNew });

	let emptyMessage = "No channels yet";
	if (loading) {
		emptyMessage = "Loading…";
	} else if (!authed) {
		emptyMessage = "Sign in to add channels";
	}

	const renderChannelRows = (list: typeof channels) =>
		list.map((channel) => (
			<SidebarMenuItem key={channel.id}>
				<ContextMenu>
					<ContextMenuTrigger>
						{/* sidebar row combines nested controls with drag/middle-click */}
						<div
							className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
							data-prefetch-path={`/channels/${channel.id}`}
							onAuxClick={(e) => {
								if (e.button === 1) {
									e.preventDefault();
									openChannel(channel.id, channel.name, true);
								}
							}}
							onClick={() => openChannel(channel.id, channel.name)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									openChannel(channel.id, channel.name);
								}
							}}
							role="button"
							tabIndex={0}
						>
							<HugeiconsIcon
								className="size-4 shrink-0 text-muted-foreground"
								icon={Tv01Icon}
							/>
							<OverflowTooltip
								className="min-w-0 flex-1 truncate text-sm"
								text={channel.name}
							/>
							<span className="shrink-0 text-muted-foreground/70 text-xs">
								{CHANNEL_LABELS[channel.channelType]}
							</span>
							{channel.agentId &&
							!agents.some((agent) => agent.id === channel.agentId) ? (
								<span
									aria-label="This channel was reverted to the default agent"
									className="font-medium text-status-warning text-xs"
									title="This channel was reverted to the default agent because its original agent was deleted"
								>
									!
								</span>
							) : null}
							{/* A dim dot marks a disabled bot; enabled bots show none. */}
							{!channel.enabled && (
								<span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
							)}
						</div>
					</ContextMenuTrigger>
					<ContextMenuContent>
						<ContextMenuItem
							onClick={() => openChannel(channel.id, channel.name, true)}
						>
							<HugeiconsIcon
								className="mr-2 size-4"
								icon={ArrowUpRight01Icon}
							/>
							Open in new tab
						</ContextMenuItem>
						<OpenInNewWindowContextMenuItem
							onClick={() =>
								void openEntityInNewWindow({
									path: `/channels/${channel.id}`,
									title: channel.name,
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
					title="Add channel"
				/>
			}
			collapsed={collapsed}
			dnd={dnd}
			label="Channels"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="channels"
			sort={sort}
		>
			{channels.length === 0 ? (
				<p className="px-2 py-2 text-muted-foreground text-xs">
					{emptyMessage}
				</p>
			) : (
				<>
					<SidebarMenu>{renderChannelRows(paged.visible)}</SidebarMenu>
					<SectionPagingControls
						overflow={{
							getSearchText: (channel) => channel.name ?? "",
							items: paged.items,
							label: "channels",
							renderList: (list) => (
								<SidebarMenu>{renderChannelRows(list)}</SidebarMenu>
							),
						}}
						paged={paged}
					/>
				</>
			)}
			<AddChannelDialog
				agents={agents.map((a) => ({ id: a.id, name: a.name }))}
				initialAgentId={channelSetupRequest?.agentId}
				initialAgentName={channelSetupRequest?.agentName}
				initialChannelType={channelSetupRequest?.channelType}
				onCreate={async (input) => {
					try {
						await create(input);
						toast.success({
							title: tl('Channel "{name}" created', { name: input.name }),
						});
						return true;
					} catch (e) {
						toast.error({
							title:
								e instanceof Error ? e.message : "Could not create channel",
						});
						return false;
					}
				}}
				onNodeCreated={async (name) => {
					// The managed-bot path has the NODE write the config, so `create`
					// never ran and this list still shows the old set.
					await refresh();
					toast.success({ title: tl('Channel "{name}" created', { name }) });
				}}
				onOpenChange={setAddDialogOpen}
				open={addDialogOpen}
				teams={teams.map((t) => ({ id: t.id, name: t.name }))}
			/>
		</SidebarSection>
	);
}

/** A single Composio integration row's glyph: the toolkit's remote logo, or a
 *  fallback icon when it has none. */
function IntegrationLogo({
	logo,
	name,
}: {
	logo: string | null | undefined;
	name: string;
}) {
	const tl = useLiteralMessages();
	const safeLogo = safeMediaUrl(logo);
	if (!safeLogo) {
		return (
			<HugeiconsIcon
				className="size-4 shrink-0 text-muted-foreground"
				icon={ConnectIcon}
			/>
		);
	}
	return (
		// Tauri/Vite app, no next/image; logo is a remote Composio URL
		// sized via the `size-4` class, dimensions are fixed
		<img
			alt={tl("{name} logo", { name })}
			className="size-4 shrink-0 rounded-sm bg-background object-contain"
			draggable={false}
			src={safeLogo}
		/>
	);
}

/** Integrations list in the sidebar — the user's connected Composio accounts
 *  (Gmail, GitHub, Slack, …), each with its toolkit logo. Rows and the "+" open
 *  App Settings → Integrations. Hidden by default (opt-in feature). */
export function IntegrationsSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	// Integrations moved into the Gateway dialog (a keys/BYOK + registry surface),
	// so the section's "manage" affordance opens Gateway → Integrations.
	const openGateway = useGatewayDialog((s) => s.openGateway);
	// Only query connections once a Composio key is configured on the node.
	// Without a key, /connections returns an error — treat that as "not set up
	// yet" (an actionable empty state) rather than a load failure that a Retry
	// can never fix.
	const statusQuery = useComposioStatus();
	const configured = statusQuery.data?.configured ?? false;
	const connectionsQuery = useComposioConnections("", configured);
	const connections = useMemo(
		() => connectionsQuery.data ?? [],
		[connectionsQuery.data]
	);
	// Only fetch the (large) toolkit catalog once there are connections to label.
	const toolkitsQuery = useComposioToolkits(connections.length > 0);
	const toolkitBySlug = useMemo(
		() => new Map((toolkitsQuery.data ?? []).map((t) => [t.slug, t])),
		[toolkitsQuery.data]
	);

	// Enrich each connection with its toolkit's display name + logo so the shared
	// name-sorter can order them and rows can render a logo.
	const rows = useMemo(
		() =>
			connections.map((conn) => {
				const toolkit = toolkitBySlug.get(conn.toolkit);
				return {
					id: conn.id,
					name: toolkit?.name ?? conn.toolkit,
					logo: toolkit?.logo ?? null,
					active: conn.active,
				};
			}),
		[connections, toolkitBySlug]
	);
	const paged = usePaged(sortItems(rows, sort, NAMED_SORT_ACCESSORS), pageSize);

	const openIntegrations = () => openGateway("integrations");

	const isLoading = statusQuery.isLoading || connectionsQuery.isLoading;
	let emptyMessage: string;
	if (isLoading) {
		emptyMessage = "Loading…";
	} else if (configured) {
		emptyMessage = "No integrations connected";
	} else {
		emptyMessage = "No integrations set up yet";
	}

	const renderIntegrationRows = (list: typeof rows) =>
		list.map((row) => (
			<SidebarMenuItem key={row.id}>
				{/* sidebar row combines nested controls with drag/middle-click */}
				<div
					className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
					onClick={openIntegrations}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							openIntegrations();
						}
					}}
					role="button"
					tabIndex={0}
				>
					<IntegrationLogo logo={row.logo} name={row.name} />
					<OverflowTooltip
						className="min-w-0 flex-1 truncate text-sm"
						text={row.name}
					/>
					{/* A dim dot marks an inactive connection; active shows none. */}
					{!row.active && (
						<span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
					)}
				</div>
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={
				<SectionAddButton onClick={openIntegrations} title="Add integration" />
			}
			collapsed={collapsed}
			dnd={dnd}
			label="Integrations"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="integrations"
			sort={sort}
		>
			{configured && connectionsQuery.isError && connections.length === 0 && (
				<SectionLoadError
					message="Couldn't load your integrations."
					onRetry={() => {
						connectionsQuery.refetch().catch(() => undefined);
					}}
				/>
			)}
			{!(configured && connectionsQuery.isError) &&
				connections.length === 0 && (
					<p className="px-2 py-2 text-muted-foreground text-xs">
						{emptyMessage}
					</p>
				)}
			{connections.length > 0 && (
				<>
					<SidebarMenu>{renderIntegrationRows(paged.visible)}</SidebarMenu>
					<SectionPagingControls
						overflow={{
							getSearchText: (row) => row.name ?? "",
							items: paged.items,
							label: "integrations",
							renderList: (list) => (
								<SidebarMenu>{renderIntegrationRows(list)}</SidebarMenu>
							),
						}}
						paged={paged}
					/>
				</>
			)}
		</SidebarSection>
	);
}
