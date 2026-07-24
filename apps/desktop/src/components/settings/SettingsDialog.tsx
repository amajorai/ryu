import { AuthorizedAppsTab, ReferralsTab } from "@ryu/settings";
import { Dialog, DialogContent } from "@ryu/ui/components/dialog";
import {
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@ryu/ui/components/sidebar";
import { toast } from "@ryu/ui/components/sileo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useState } from "react";
import { openExternal } from "@/lib/tauri-bridge.ts";
import ResizableSettingsLayout from "@/src/components/ResizableSettingsLayout.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	APP_SECTION_PREFIX,
	buildEntityNavGroups,
	isEntitySection,
	PLUGIN_SECTION_PREFIX,
	type ScopedNavEntity,
	useScopedSettingsNav,
} from "@/src/hooks/useScopedSettingsNav.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { openFeedbackWidget } from "@/src/lib/userjot.ts";
import CreditsTab from "@/src/pages/CreditsPage.tsx";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import type { SettingsSectionValue } from "@/src/store/useSettingsDialog.ts";
import { AccountTab } from "./AccountTab.tsx";
import { AppearanceTab } from "./AppearanceTab.tsx";
import { AudioDevicesSettings } from "./AudioDevicesSettings.tsx";
import { BillingTab } from "./BillingTab.tsx";
import { EntitySettings } from "./EntitySettings.tsx";
import { ExperimentalSettings } from "./ExperimentalSettings.tsx";
import { GeneralTab } from "./GeneralTab.tsx";
import { IslandSettings } from "./IslandSettings.tsx";
import { KeyboardShortcutsTab } from "./KeyboardShortcutsTab.tsx";
import { SessionsTab } from "./SessionsTab.tsx";
import { ShadowSettings } from "./ShadowSettings.tsx";
import { TeamsBillingTab } from "./TeamsBillingTab.tsx";
import { TtsEngineSettings } from "./TtsEngineSettings.tsx";
import { VoiceInputSettings } from "./VoiceInputSettings.tsx";
import { VoiceModeDisplaySettings } from "./VoiceModeDisplaySettings.tsx";
import { VoiceReadbackSettings } from "./VoiceReadbackSettings.tsx";

const queryClient = new QueryClient();

// Static (built-in) sections defined in the store so external openers (the Gateway
// dialog cross-link, the command palette) can request one without importing this
// component. Per-app/plugin tabs are dynamic (`app:<id>` / `plugin:<id>`) and are
// NOT part of this union — they are matched by prefix at render time.
type SectionValue = SettingsSectionValue;

interface NavItem {
	label: string;
	value: string;
}

interface NavGroup {
	items: NavItem[];
	title?: string;
}

// Desktop-client + user-account sections only. Everything node/gateway-level
// (meetings, memory, privacy, storage, updates, email/alerts, connections, health,
// predictive typing, tasks, the Danger Zone, and node-scoped app/plugin settings)
// now lives in the Gateway dialog — those affect the whole node, not this per-user
// desktop client, and belong next to the other node settings.
const NAV_GROUPS: NavGroup[] = [
	{
		items: [
			{ value: "general", label: "General" },
			{ value: "appearance", label: "Appearance" },
			{ value: "keyboard", label: "Keyboard shortcuts" },
			{ value: "island", label: "Island" },
			{ value: "shadow", label: "Shadow" },
			{ value: "voice", label: "Voice" },
			{ value: "experimental", label: "Experimental" },
		],
	},
	{
		title: "Account",
		items: [
			{ value: "account", label: "Account" },
			{ value: "sessions", label: "Sessions" },
			{ value: "authorized-apps", label: "Authorized Apps" },
		],
	},
	{
		title: "Services",
		items: [
			{ value: "billing", label: "Billing" },
			{ value: "referrals", label: "Referrals" },
			{ value: "teams", label: "Teams" },
			{ value: "credits", label: "Credits" },
		],
	},
];

function SectionContent({ value }: { value: SectionValue }) {
	switch (value) {
		case "general":
			return <GeneralTab />;
		case "account":
			return <AccountTab />;
		case "sessions":
			return <SessionsTab />;
		case "authorized-apps":
			return <AuthorizedAppsTab />;
		case "appearance":
			return <AppearanceTab />;
		case "keyboard":
			return <KeyboardShortcutsTab />;
		case "island":
			return <IslandSettings />;
		case "shadow":
			return <ShadowSettings />;
		case "billing":
			return <BillingTab />;
		case "referrals":
			return <ReferralsTab onOpenExternal={openExternal} />;
		case "teams":
			return <TeamsBillingTab />;
		case "credits":
			return <CreditsTab />;
		case "experimental":
			return <ExperimentalSettings />;
		case "voice":
			return (
				<div className="space-y-4">
					<AudioDevicesSettings />
					<VoiceModeDisplaySettings />
					<VoiceInputSettings />
					<VoiceReadbackSettings />
					<TtsEngineSettings />
				</div>
			);
		default:
			return null;
	}
}

interface SettingsDialogProps {
	defaultSection?: SectionValue;
	onOpenChange: (open: boolean) => void;
	open: boolean;
}

export function SettingsDialog({
	open,
	onOpenChange,
	defaultSection,
}: SettingsDialogProps) {
	const [activeSection, setActiveSection] = useState<string>(
		defaultSection ?? "general"
	);
	const openGateway = useGatewayDialog((s) => s.openGateway);
	const { resolvedTheme } = useTheme();
	const target = toTarget(useActiveNode());

	// User-scoped app/plugin settings tabs (node-scoped ones render in the Gateway
	// dialog instead). Each becomes its own nav item under the Apps / Plugins header.
	const { apps: appEntities, plugins: pluginEntities } =
		useScopedSettingsNav("user");
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

	const navGroups = useMemo(
		() => [...NAV_GROUPS, ...buildEntityNavGroups(appEntities, pluginEntities)],
		[appEntities, pluginEntities]
	);
	const allItems = useMemo(
		() => navGroups.flatMap((g) => g.items),
		[navGroups]
	);

	// Cross-link to the node-scoped Gateway dialog. Both are 85vw/85vh modals, so
	// close this one before opening the other to avoid stacking two focus traps.
	const handleOpenGateway = () => {
		onOpenChange(false);
		openGateway();
	};

	// Open the feedback widget, matched to the current appearance. If it can't
	// be loaded, tell the user and point them at email instead of failing silently.
	const handleSendFeedback = () => {
		openFeedbackWidget(resolvedTheme === "dark" ? "dark" : "light").catch(
			() => {
				toast.error({
					title: "Couldn't open feedback",
					description: "Please try again, or email us at support@ryu.app.",
				});
			}
		);
	};

	useEffect(() => {
		if (open && defaultSection) {
			setActiveSection(defaultSection);
		}
	}, [open, defaultSection]);

	// If the selected app/plugin entity disappears (disabled/uninstalled) while its
	// now-orphaned tab is open, fall back to General so the pane never shows nothing.
	useEffect(() => {
		if (isEntitySection(activeSection) && !entityById.has(activeSection)) {
			setActiveSection("general");
		}
	}, [activeSection, entityById]);

	const activeLabel =
		allItems.find((i) => i.value === activeSection)?.label ?? "";
	const activeEntity = entityById.get(activeSection);

	return (
		<QueryClientProvider client={queryClient}>
			<Dialog onOpenChange={onOpenChange} open={open}>
				<DialogContent className="!w-[85vw] !max-w-7xl [&>[data-slot=dialog-close]]:!top-5 [&>[data-slot=dialog-close]]:!right-5 h-[85vh] gap-0 overflow-hidden p-0">
					<ResizableSettingsLayout
						content={
							<div className="px-8 py-6">
								<h2 className="mb-6 font-semibold text-base">{activeLabel}</h2>
								{activeEntity ? (
									<EntitySettings entity={activeEntity} target={target} />
								) : (
									<SectionContent value={activeSection as SectionValue} />
								)}
							</div>
						}
						sidebar={
							<>
								{navGroups.map((group, gi) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: static nav groups with no stable key
									<SidebarGroup className="py-1" key={group.title ?? gi}>
										{group.title && (
											<SidebarGroupLabel>{group.title}</SidebarGroupLabel>
										)}
										<SidebarMenu>
											{group.items.map((item) => (
												<SidebarMenuItem key={item.value}>
													<SidebarMenuButton
														isActive={activeSection === item.value}
														onClick={() => setActiveSection(item.value)}
													>
														{item.label}
													</SidebarMenuButton>
												</SidebarMenuItem>
											))}
										</SidebarMenu>
									</SidebarGroup>
								))}
								<SidebarGroup className="mt-auto py-1">
									<SidebarMenu>
										<SidebarMenuItem>
											<SidebarMenuButton onClick={handleSendFeedback}>
												Send feedback
											</SidebarMenuButton>
										</SidebarMenuItem>
									</SidebarMenu>
								</SidebarGroup>
								<SidebarGroup className="py-1">
									<SidebarGroupLabel>Node</SidebarGroupLabel>
									<SidebarMenu>
										<SidebarMenuItem>
											<SidebarMenuButton onClick={handleOpenGateway}>
												Gateway settings
											</SidebarMenuButton>
										</SidebarMenuItem>
									</SidebarMenu>
								</SidebarGroup>
							</>
						}
						storageKey="ryu.settings.sidebar-layout"
					/>
				</DialogContent>
			</Dialog>
		</QueryClientProvider>
	);
}
