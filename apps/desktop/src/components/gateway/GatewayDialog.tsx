import "./gateway-dialog.css";
import { Settings01Icon } from "@hugeicons/core-free-icons";
import ResizableSettingsLayout from "@ryu/blocks/desktop/resizable-settings-layout.tsx";
import { SettingsIconTile } from "@ryu/blocks/desktop/settings-nav.tsx";
import { Dialog, DialogContent } from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@ryu/ui/components/sidebar.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useEffect, useMemo, useState } from "react";
import { InlineErrorRow } from "@/src/components/chat/InlineErrorRow.tsx";
import { GatewayNodeScopePicker } from "@/src/components/gateway/GatewayNodeScopePicker.tsx";
import { SettingsSearchResults } from "@/src/components/settings/SettingsSearchResults.tsx";
import { NodeScopeProvider } from "@/src/contexts/NodeScopeContext.tsx";
import {
	useActiveNode,
	useActiveNodeGetter,
} from "@/src/hooks/useActiveNode.ts";
import {
	useCanManagePermission,
	useGatewayConfigurable,
} from "@/src/hooks/useGatewayConfigurable.ts";
import { useGatewayStatus } from "@/src/hooks/useGatewayStatus.ts";
import {
	APP_SECTION_PREFIX,
	buildEntityNavGroups,
	isEntitySection,
	PLUGIN_SECTION_PREFIX,
	type ScopedNavEntity,
	useScopedSettingsNav,
} from "@/src/hooks/useScopedSettingsNav.ts";
import { useSettingReveal } from "@/src/hooks/useSettingReveal.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { requestSettingReveal } from "@/src/lib/settings-focus.ts";
import type { SettingsEntry } from "@/src/lib/settings-index.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";
import { GATEWAY_SECTIONS } from "./gateway-dialog/gateway-sections.ts";
import { GatewaySectionBody } from "./gateway-dialog/section-body.tsx";
import { useGatewayDialogConfig } from "./gateway-dialog/use-gateway-dialog-config.ts";
import { useGatewayNavGroups } from "./gateway-dialog/use-gateway-nav-groups.ts";

export { BudgetsCard } from "./gateway-dialog/budgets-card.tsx";
export { RoutingCard } from "./gateway-dialog/routing-card.tsx";
export { SmartRoutingCard } from "./gateway-dialog/smart-routing-card.tsx";

/**
 * `access` is the legacy deep link for the Connections hub. It renders the same
 * pane, so it resolves to `connections` and its nav row lights up.
 */
function canonicalSection(section: string): string {
	return section === "access" ? "connections" : section;
}

interface GatewayDialogProps {
	defaultSection?: string;
	onOpenChange: (open: boolean) => void;
	open: boolean;
}

/**
 * Gateway settings rendered as a dialog with the same inset-sidebar design and
 * layout as the main {@link SettingsDialog}. Self-contained: it loads its own
 * gateway status and renders every gateway section in the content pane.
 *
 * The "Settings for <computer>" picker scopes the dialog, not the app: this
 * shell holds the chosen computer and provides it to every section through
 * {@link NodeScopeProvider}, so `useActiveNode()` below resolves to it while
 * chats keep using the app-wide active computer. Each opening starts on the
 * app-wide computer, and a scoped computer that is removed falls back to it.
 */
export function GatewayDialog(props: GatewayDialogProps) {
	const [scopeName, setScopeName] = useState<string | undefined>();
	const [wasOpen, setWasOpen] = useState(props.open);
	if (props.open !== wasOpen) {
		setWasOpen(props.open);
		if (props.open) {
			setScopeName(undefined);
		}
	}
	const scopeExists = useNodeStore((s) =>
		s.nodes.some((n) => n.name === scopeName)
	);
	useEffect(() => {
		if (scopeName !== undefined && !scopeExists) {
			setScopeName(undefined);
		}
	}, [scopeName, scopeExists]);
	const scope = scopeExists ? scopeName : undefined;
	return (
		<NodeScopeProvider nodeName={scope}>
			<GatewayDialogContent
				{...props}
				onScopeChange={setScopeName}
				scope={scope}
			/>
		</NodeScopeProvider>
	);
}

function GatewayDialogContent({
	open,
	onOpenChange,
	defaultSection = "overview",
	scope,
	onScopeChange,
}: GatewayDialogProps & {
	onScopeChange: (name: string) => void;
	scope: string | undefined;
}) {
	const { status, loading, error, refresh } = useGatewayStatus(open);
	const canConfigure = useGatewayConfigurable();
	const canViewTraffic = useCanManagePermission("audit.view");
	const getActiveNode = useActiveNodeGetter();
	// Section is a string, not just GatewaySection: dynamic app/plugin entities use
	// `app:<id>` / `plugin:<id>` values that aren't part of the static union.
	const [section, setSectionState] = useState<string>(() =>
		canonicalSection(defaultSection)
	);
	const setSection = (next: string) => setSectionState(canonicalSection(next));
	// Twenty built-in sections plus one nav row per node-scoped app means the
	// list outgrew "just read it" — a filter is the shortest path from "I know
	// what I want" to the pane that holds it.
	const [search, setSearch] = useState("");
	const openSettings = useSettingsDialog((s) => s.openSettings);
	const contentRef = useSettingReveal(section, "gateway");

	// Node-scoped app/plugin settings tabs (user-scoped ones render in the App
	// Settings dialog instead). Each becomes its own nav item under Apps / Plugins.
	const { apps: appEntities, plugins: pluginEntities } =
		useScopedSettingsNav("node");
	const entityById = useMemo(() => {
		const map = new Map<string, ScopedNavEntity>();
		for (const e of appEntities) {
			map.set(`${APP_SECTION_PREFIX}${e.id}`, e);
		}
		for (const e of pluginEntities) {
			map.set(`${PLUGIN_SECTION_PREFIX}${e.id}`, e);
		}
		return map;
	}, [appEntities, pluginEntities]);

	// Cross-link back to the desktop App Settings dialog. Both are 85vw/85vh
	// modals, so close this one before opening the other to avoid stacking two
	// focus traps.
	const handleOpenSettings = () => {
		onOpenChange(false);
		openSettings();
	};

	// A search result may name a setting owned by the App Settings dialog. Same
	// rule as the manual cross-link above: close this modal before opening that
	// one so two focus traps never stack. The reveal request is module state, so
	// it survives the swap.
	const handleSelectResult = (entry: SettingsEntry) => {
		requestSettingReveal(entry);
		setSearch("");
		if (entry.dialog === "app") {
			onOpenChange(false);
			openSettings(entry.section);
			return;
		}
		setSection(entry.section);
	};

	useEffect(() => {
		if (open) {
			setSectionState(canonicalSection(defaultSection));
		}
	}, [open, defaultSection]);

	// If the selected app/plugin entity disappears (disabled/uninstalled) while its
	// tab is open, fall back to the overview so the pane never shows nothing.
	useEffect(() => {
		if (isEntitySection(section) && !entityById.has(section)) {
			setSectionState("overview");
		}
	}, [section, entityById]);

	// Static gateway nav (labels resolved from GATEWAY_SECTIONS) + the dynamic
	// Apps/Plugins groups for node-scoped app settings.
	// Apps/Plugins are placed before the Node group for quicker access.
	const entityGroups = useMemo(
		() => buildEntityNavGroups(appEntities, pluginEntities),
		[appEntities, pluginEntities]
	);
	const navGroups = useGatewayNavGroups(entityGroups, search);

	const node = useActiveNode();
	const target: ApiTarget = useMemo(
		() => ({
			url: node.url,
			token: node.token ?? null,
			userJwt: node.userJwt ?? null,
		}),
		[node.url, node.token, node.userJwt]
	);
	const reachable = status?.reachable ?? false;
	const {
		appliedProviderRevision,
		configProviders,
		configRevision,
		refreshWithConfig,
		webServiceSchema,
	} = useGatewayDialogConfig({
		getActiveNode,
		open,
		reachable,
		refresh,
		target,
	});
	// Managed (Ryu Cloud) node: keys are held server-side in the fleet vault, so
	// the key cards render read-only and their writers no-op (WS4). Synchronous —
	// travels on the node record from hydrateCloudNodes, no async probe needed.
	const managed = node.managed === true;

	const activeEntity = entityById.get(section);
	const activeMeta = GATEWAY_SECTIONS.find((s) => s.value === section);
	const activeLabel = activeEntity?.label ?? activeMeta?.label ?? "";
	const activeHint =
		activeEntity || !activeMeta?.showHint ? "" : activeMeta.hint;

	const body = (() => {
		if (loading && !status) {
			return <SkeletonRows spacing="spacious" />;
		}
		if (error && !status) {
			return (
				<InlineErrorRow
					details={error}
					message="Couldn't reach Core on this computer."
					onRetry={() => refreshWithConfig()}
				/>
			);
		}
		return (
			<GatewaySectionBody
				activeEntity={activeEntity}
				appliedProviderRevision={appliedProviderRevision}
				canConfigure={canConfigure}
				canViewTraffic={canViewTraffic}
				configProviders={configProviders}
				configRevision={configRevision}
				managed={managed}
				nodeUrl={node.url}
				reachable={reachable}
				refreshWithConfig={refreshWithConfig}
				section={section}
				setSection={setSection}
				status={status}
				target={target}
				webServiceSchema={webServiceSchema}
			/>
		);
	})();

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			{/* Goes edge-to-edge below `md` (the useIsMobile line), matching the
			    App Settings dialog. */}
			<DialogContent appearance="gateway-settings">
				<ResizableSettingsLayout
					content={
						<div className="max-w-2xl px-6 pt-4 pb-8" ref={contentRef}>
							<div className="mb-6 flex flex-col gap-1">
								<h2 className="text-balance font-semibold text-lg tracking-tight">
									{activeLabel}
								</h2>
								{/* One line, only where the pane name alone is ambiguous. */}
								{activeHint ? (
									<p className="text-(length:--text-detail) text-pretty text-muted-foreground leading-(--text-detail--line-height)">
										{activeHint}
									</p>
								) : null}
							</div>
							{/* Keyed by computer: sections that loaded on mount re-read the
							    newly picked computer instead of showing the last one's values. */}
							<div key={node.name}>{body}</div>
						</div>
					}
					sidebar={
						<>
							<SidebarGroup spacing="compact">
								<GatewayNodeScopePicker
									onScopeChange={onScopeChange}
									scope={scope}
								/>
								<Input
									aria-label="Search settings"
									onChange={(e) => setSearch(e.target.value)}
									placeholder="Search settings…"
									size="settings-search"
									value={search}
								/>
							</SidebarGroup>
							{navGroups.map((group) => (
								<SidebarGroup key={group.title ?? "general"} spacing="compact">
									{group.title && (
										<SidebarGroupLabel>{group.title}</SidebarGroupLabel>
									)}
									<SidebarMenu>
										{group.items.map((item) => (
											<SidebarMenuItem key={item.value}>
												<SidebarMenuButton
													isActive={section === item.value}
													onClick={() => setSection(item.value)}
												>
													{item.icon ? (
														<SettingsIconTile icon={item.icon} size="sm" />
													) : null}
													<span className="truncate">{item.label}</span>
												</SidebarMenuButton>
											</SidebarMenuItem>
										))}
									</SidebarMenu>
								</SidebarGroup>
							))}
							{/* Individual SETTINGS, from the shared index. The nav filter above
							    only ever finds tabs; this is what answers "where is the row that
							    does X", including rows that live in the App Settings dialog. */}
							{search.trim() ? (
								<SettingsSearchResults
									currentDialog="gateway"
									onSelect={handleSelectResult}
									query={search}
									showEmptyState={navGroups.length === 0}
								/>
							) : null}
							<SidebarGroup className="mt-auto" spacing="compact">
								<SidebarGroupLabel>App</SidebarGroupLabel>
								<SidebarMenu>
									<SidebarMenuItem>
										<SidebarMenuButton onClick={handleOpenSettings}>
											<SettingsIconTile icon={Settings01Icon} size="sm" />
											<span className="truncate">App settings</span>
										</SidebarMenuButton>
									</SidebarMenuItem>
								</SidebarMenu>
							</SidebarGroup>
						</>
					}
					// v2 for the same reason as the app Settings dialog: a persisted
					// divider position takes precedence over the widened default.
					storageKey="ryu.gateway.sidebar-layout.v2"
				/>
			</DialogContent>
		</Dialog>
	);
}
