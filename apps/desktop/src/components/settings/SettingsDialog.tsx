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
import { useApps } from "@/src/hooks/useApps.ts";
import { PREDICT_PLUGIN_ID } from "@/src/lib/api/predict.ts";
import { openFeedbackWidget } from "@/src/lib/userjot.ts";
import CreditsTab from "@/src/pages/CreditsPage.tsx";
import { PreflightPage } from "@/src/pages/PreflightPage.tsx";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import type { SettingsSectionValue } from "@/src/store/useSettingsDialog.ts";
import { AccountTab } from "./AccountTab.tsx";
import { AppearanceTab } from "./AppearanceTab.tsx";
import { AudioDevicesSettings } from "./AudioDevicesSettings.tsx";
import { BillingTab } from "./BillingTab.tsx";
import { ConnectionsTab } from "./ConnectionsTab.tsx";
import { DangerZoneSettings } from "./DangerZoneSettings.tsx";
import { EmailAlertsSettings } from "./EmailAlertsSettings.tsx";
import { ExperimentalSettings } from "./ExperimentalSettings.tsx";
import { GeneralTab } from "./GeneralTab.tsx";
import { IslandSettings } from "./IslandSettings.tsx";
import { KeyboardShortcutsTab } from "./KeyboardShortcutsTab.tsx";
import { MeetingsSettings } from "./MeetingsSettings.tsx";
import { MemoryTab } from "./MemoryTab.tsx";
import { PluginsSettings } from "./PluginsSettings.tsx";
import { PredictSettings } from "./PredictSettings.tsx";
import { PrivacySettings } from "./PrivacySettings.tsx";
import { QuestsSettings } from "./QuestsSettings.tsx";
import { SessionsTab } from "./SessionsTab.tsx";
import { ShadowSettings } from "./ShadowSettings.tsx";
import { StorageSettings } from "./StorageSettings.tsx";
import { TeamsBillingTab } from "./TeamsBillingTab.tsx";
import { TtsEngineSettings } from "./TtsEngineSettings.tsx";
import { UpdatesSettings } from "./UpdatesSettings.tsx";
import { VoiceInputSettings } from "./VoiceInputSettings.tsx";
import { VoiceModeDisplaySettings } from "./VoiceModeDisplaySettings.tsx";
import { VoiceReadbackSettings } from "./VoiceReadbackSettings.tsx";

const queryClient = new QueryClient();

// Section identifiers are defined in the store so external openers (the Gateway
// dialog cross-link, the command palette) can request a section without
// importing this component.
type SectionValue = SettingsSectionValue;

interface NavItem {
	label: string;
	value: SectionValue;
}

interface NavGroup {
	items: NavItem[];
	title?: string;
}

const NAV_GROUPS: NavGroup[] = [
	{
		items: [
			{ value: "general", label: "General" },
			{ value: "appearance", label: "Appearance" },
			{ value: "keyboard", label: "Keyboard shortcuts" },
			{ value: "island", label: "Island" },
			{ value: "shadow", label: "Shadow" },
			{ value: "voice", label: "Voice" },
			{ value: "memory", label: "Memory" },
			{ value: "meetings", label: "Meetings" },
			{ value: "quests", label: "Tasks" },
			{ value: "predict", label: "Predictive typing" },
			{ value: "plugins", label: "Plugins" },
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
			{ value: "connections", label: "Connections" },
			{ value: "billing", label: "Billing" },
			{ value: "referrals", label: "Referrals" },
			{ value: "teams", label: "Teams" },
			{ value: "credits", label: "Credits" },
		],
	},
	{
		title: "System",
		items: [
			{ value: "email-alerts", label: "Email & Alerts" },
			{ value: "privacy", label: "Privacy" },
			{ value: "storage", label: "Storage" },
			{ value: "updates", label: "Updates" },
			{ value: "health", label: "Health" },
			{ value: "experimental", label: "Experimental" },
			{ value: "danger", label: "Danger Zone" },
		],
	},
];

function SectionContent({ value }: { value: SectionValue }) {
	switch (value) {
		case "general":
			return <GeneralTab />;
		case "account":
			return <AccountTab />;
		case "connections":
			return <ConnectionsTab />;
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
		case "updates":
			return <UpdatesSettings />;
		case "storage":
			return <StorageSettings />;
		case "health":
			return <PreflightPage embedded />;
		case "experimental":
			return <ExperimentalSettings />;
		case "danger":
			return <DangerZoneSettings />;
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
		case "memory":
			return <MemoryTab />;
		case "predict":
			return <PredictSettings />;
		case "meetings":
			return <MeetingsSettings />;
		case "quests":
			return <QuestsSettings />;
		case "plugins":
			return <PluginsSettings />;
		case "email-alerts":
			return <EmailAlertsSettings />;
		case "privacy":
			return <PrivacySettings />;
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
	const [activeSection, setActiveSection] = useState<SectionValue>(
		defaultSection ?? "general"
	);
	const openGateway = useGatewayDialog((s) => s.openGateway);
	const { resolvedTheme } = useTheme();

	// System-wide predictive typing is a built-in *plugin*; its settings tab only
	// exists while that plugin is enabled (the plugin is the single on/off switch —
	// there is no standalone feature to configure otherwise). Filter the nav from
	// live plugin state rather than the static NAV_GROUPS.
	const { apps } = useApps();
	const predictEnabled = useMemo(
		() => apps.some((a) => a.id === PREDICT_PLUGIN_ID && a.enabled),
		[apps]
	);
	const navGroups = useMemo(
		() =>
			NAV_GROUPS.map((g) => ({
				...g,
				items: g.items.filter((it) => it.value !== "predict" || predictEnabled),
			})),
		[predictEnabled]
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

	// If the predict plugin is disabled while sitting on its (now-hidden) tab,
	// fall back to General so the content pane never shows an orphaned section.
	useEffect(() => {
		if (!predictEnabled && activeSection === "predict") {
			setActiveSection("general");
		}
	}, [predictEnabled, activeSection]);

	const activeLabel =
		allItems.find((i) => i.value === activeSection)?.label ?? "";

	return (
		<QueryClientProvider client={queryClient}>
			<Dialog onOpenChange={onOpenChange} open={open}>
				<DialogContent className="!w-[85vw] !max-w-7xl [&>[data-slot=dialog-close]]:!top-5 [&>[data-slot=dialog-close]]:!right-5 h-[85vh] gap-0 overflow-hidden p-0">
					<ResizableSettingsLayout
						content={
							<div className="px-8 py-6">
								<h2 className="mb-6 font-semibold text-base">{activeLabel}</h2>
								<SectionContent value={activeSection} />
							</div>
						}
						sidebar={
							<>
								{navGroups.map((group, gi) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: static nav groups with no stable key
									<SidebarGroup className="py-1" key={gi}>
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
