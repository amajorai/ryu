import {
	CloudIcon,
	Coins01Icon,
	ColorsIcon,
	ComputerIcon,
	CreditCardIcon,
	GiftIcon,
	KeyboardIcon,
	Mic01Icon,
	Package01Icon,
	PlugSocketIcon,
	Refresh01Icon,
	SecurityCheckIcon,
	Settings01Icon,
	SourceCodeIcon,
	UserCircleIcon,
	UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import {
	SettingsIconTile,
	type SettingsTint,
} from "@ryu/blocks/desktop/settings-nav.tsx";
import { useI18n, useLocalizedText } from "@ryu/i18n/react";
import { OAuthAppsTab, ReferralsTab } from "@ryu/settings";
import { Button } from "@ryu/ui/components/button.tsx";
import { Dialog, DialogContent } from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@ryu/ui/components/sidebar.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useSession } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import ResizableSettingsLayout from "@/src/components/ResizableSettingsLayout.tsx";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import {
	APP_SECTION_PREFIX,
	buildEntityNavGroups,
	isEntitySection,
	PLUGIN_SECTION_PREFIX,
	type ScopedNavEntity,
	useScopedSettingsNav,
} from "@/src/hooks/useScopedSettingsNav.ts";
import { useSettingReveal } from "@/src/hooks/useSettingReveal.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { requestSettingReveal } from "@/src/lib/settings-focus.ts";
import type { SettingsEntry } from "@/src/lib/settings-index.ts";
import { openFeedbackWidget } from "@/src/lib/userjot.ts";
import CreditsTab from "@/src/pages/CreditsPage.tsx";
import UsageTab from "@/src/pages/UsagePage.tsx";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import type { SettingsSectionValue } from "@/src/store/useSettingsDialog.ts";
import { AccountTab } from "./AccountTab.tsx";
import { AppearanceTab } from "./AppearanceTab.tsx";
import { AppUpdatesSettings } from "./AppUpdatesSettings.tsx";
import { AudioDevicesSettings } from "./AudioDevicesSettings.tsx";
import { BillingTab } from "./BillingTab.tsx";
import { DeveloperTab } from "./DeveloperTab.tsx";
import { EntitySettings } from "./EntitySettings.tsx";
import { GeneralTab } from "./GeneralTab.tsx";
import { KeyboardShortcutsTab } from "./KeyboardShortcutsTab.tsx";
import { RyuAppsTab } from "./RyuAppsTab.tsx";
import { ServicesOrgSwitcher } from "./ServicesOrgSwitcher.tsx";
import { SessionsTab } from "./SessionsTab.tsx";
import { SettingsSearchResults } from "./SettingsSearchResults.tsx";
import { SettingsSyncTab } from "./SettingsSyncTab.tsx";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";
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

const KEYBOARD_SHORTCUT_CONTEXT: Partial<Record<SectionValue, string>> = {
	general: "Customize shortcuts for app controls, tabs, and navigation.",
	voice: "Customize shortcuts for voice mode and other voice actions.",
};

interface NavItem {
	desktopOnly?: boolean;
	/**
	 * The tinted tile left of the label, the way iOS/macOS Settings marks a row.
	 * Optional because the dynamic Apps/Plugins items are built elsewhere and a
	 * manifest declares a settings tab, not a glyph — the label always carries the
	 * meaning, the tile only makes the list scannable.
	 */
	icon?: IconSvgElement;
	label: string;
	tint?: SettingsTint;
	value: string;
}

interface NavGroup {
	/**
	 * Renders between the group label and its first item. Exists for exactly one
	 * case — the workspace switcher above Billing — because every item in the
	 * Services group is org-scoped and the group needed one control saying WHICH
	 * org, rather than four tabs each repeating (and potentially disagreeing
	 * about) the answer.
	 */
	header?: ReactNode;
	items: NavItem[];
	title?: string;
}

// Desktop-client + user-account sections only. Everything node/gateway-level
// (meetings, memory, privacy, storage, email/alerts, connections, health,
// predictive typing, tasks, the Danger Zone, and node-scoped app/plugin settings)
// now lives in the Gateway dialog — those affect the whole node, not this per-user
// desktop client, and belong next to the other node settings.
//
// Updates is the one tab that exists in both dialogs, and deliberately so: the
// Gateway one updates the node's Core/Gateway binaries, the one here updates this
// desktop client. They are separate installs that can sit at different versions.
//
// KNOWN HYBRID — `voice` is the one entry below that is NOT the shell's own
// setting: it belongs to the voice/dictation sidecar stack and could arrive
// through `contributes.settings_tabs` under the dynamic Apps/Plugins headers
// (as memory/meetings/quests/predict already do). It is kept here because it is
// a wrapper around five desktop-client sub-panels that share no single owning
// app record. `island` and `shadow` were the other two hybrids and are now
// registered: each declares a manifest `contributes.settings_tabs` view and
// renders under the dynamic Apps/Plugins headers in the Gateway dialog, so their
// tabs appear only while the owning app is enabled instead of always.
const NAV_GROUPS: NavGroup[] = [
	{
		items: [
			{
				value: "general",
				label: "General",
				icon: Settings01Icon,
				tint: "gray",
			},
			{
				value: "appearance",
				label: "Appearance",
				icon: ColorsIcon,
				tint: "purple",
			},
			{
				value: "keyboard",
				label: "Keyboard Shortcuts",
				icon: KeyboardIcon,
				tint: "indigo",
				desktopOnly: true,
			},
			{ value: "voice", label: "Voice", icon: Mic01Icon, tint: "orange" },
		],
	},
	{
		title: "Account",
		items: [
			{
				value: "account",
				label: "Account",
				icon: UserCircleIcon,
				tint: "blue",
			},
			{
				value: "sessions",
				label: "Sessions & devices",
				icon: SecurityCheckIcon,
				tint: "teal",
			},
			{
				value: "ryu-apps",
				label: "Ryu apps",
				icon: Package01Icon,
				tint: "gray",
			},
			{
				value: "authorized-apps",
				label: "OAuth apps",
				icon: UserMultiple02Icon,
				tint: "gray",
			},
		],
	},
	{
		title: "Services",
		// The scope of everything under this heading, stated once at the top of it.
		header: <ServicesOrgSwitcher />,
		items: [
			{
				value: "billing",
				label: "Billing",
				icon: CreditCardIcon,
				tint: "green",
			},
			{ value: "referrals", label: "Referrals", icon: GiftIcon, tint: "pink" },
			{
				value: "teams",
				label: "Teams",
				icon: UserMultiple02Icon,
				tint: "indigo",
			},
			{ value: "credits", label: "Credits", icon: Coins01Icon, tint: "green" },
			// Next to Credits on purpose: the balance and what drew it down are the
			// same question asked twice, and splitting them across groups is how a
			// customer ends up asking support what a charge was.
			{ value: "usage", label: "Usage", icon: Coins01Icon, tint: "green" },
		],
	},
	{
		// The three tabs nobody opens in a normal week: the client updater, the
		// developer tools, and cross-machine settings sync. Grouping them demotes
		// them out of the first block, which is now only the settings a user
		// actually tunes. Labels must stay byte-identical to
		// SETTINGS_SECTION_LABELS (lib/settings-index.ts) or the sidebar and the
		// search-result breadcrumb disagree about the same tab.
		title: "Advanced",
		items: [
			{
				value: "updates",
				label: "Updates",
				icon: Refresh01Icon,
				tint: "teal",
				desktopOnly: true,
			},
			{
				value: "developer",
				label: "Developer",
				icon: SourceCodeIcon,
				tint: "gray",
			},
			{
				value: "sync",
				label: "Settings Sync",
				icon: CloudIcon,
				tint: "blue",
			},
		],
	},
];

/**
 * The Referrals tab, with the two things `ReferralsTab` cannot resolve itself:
 * whose name goes on the invite pass, and which metal ring to paint on it.
 *
 * Its own component rather than inline in `SectionContent`, because both facts
 * come from hooks (`useSession`, `useTheme`) and `SectionContent` is a switch —
 * calling hooks in one arm of it would be a conditional hook.
 */
function ReferralsSection() {
	const { data: session } = useSession();
	const { resolvedTheme } = useTheme();
	return (
		<ReferralsTab
			holderName={session?.user?.name ?? null}
			// The app's RESOLVED theme, not the OS's: this shell has a manual toggle
			// that can disagree with `prefers-color-scheme`, and a ring following the
			// OS would be the one part of the card lit for the wrong scheme.
			metalTheme={resolvedTheme === "dark" ? "dark" : "light"}
			onOpenExternal={openExternal}
		/>
	);
}

function KeyboardShortcutsLink({
	description,
	onOpen,
}: {
	description: string;
	onOpen: () => void;
}) {
	const { t } = useI18n();
	const localizedDescription = useLocalizedText(description);
	return (
		<SettingsSection title={t("settings.keyboard.title")}>
			<SettingsCard className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
				<p className="text-muted-foreground text-sm">{localizedDescription}</p>
				<Button
					className="shrink-0"
					onClick={onOpen}
					size="sm"
					variant="secondary"
				>
					{t("settings.keyboard.open")}
				</Button>
			</SettingsCard>
		</SettingsSection>
	);
}

function SectionContent({ value }: { value: SectionValue }) {
	switch (value) {
		case "general":
			return <GeneralTab />;
		case "account":
			return <AccountTab />;
		case "sessions":
			return <SessionsTab />;
		case "ryu-apps":
			return <RyuAppsTab />;
		case "authorized-apps":
			return <OAuthAppsTab />;
		case "appearance":
			return <AppearanceTab />;
		case "keyboard":
			return <KeyboardShortcutsTab />;
		case "sync":
			return <SettingsSyncTab />;
		case "updates":
			return <AppUpdatesSettings />;
		case "billing":
			return <BillingTab />;
		case "referrals":
			return <ReferralsSection />;
		case "teams":
			return <TeamsBillingTab />;
		case "credits":
			return <CreditsTab />;
		case "usage":
			return <UsageTab />;
		case "developer":
			return <DeveloperTab />;
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

function normalizeDefaultSection(
	defaultSection: SectionValue | (string & {}) | undefined,
	isDesktop: boolean
): string {
	return !isDesktop && defaultSection === "keyboard"
		? "general"
		: (defaultSection ?? "general");
}

interface SettingsDialogProps {
	/** A static {@link SectionValue}, or a dynamic `app:<id>` / `plugin:<id>` entity
	 *  value (matched by prefix at render time, like the Gateway dialog's). */
	defaultSection?: SectionValue | (string & {});
	onOpenChange: (open: boolean) => void;
	open: boolean;
}

export function SettingsDialog({
	open,
	onOpenChange,
	defaultSection,
}: SettingsDialogProps) {
	const { isDesktop } = useAppSurface();
	const { t } = useI18n();
	const [activeSection, setActiveSection] = useState<string>(
		normalizeDefaultSection(defaultSection, isDesktop)
	);
	// The sidebar filter. Non-empty swaps the nav for search results — individual
	// SETTINGS, not just tabs — from the shared index.
	const [search, setSearch] = useState("");
	const contentRef = useSettingReveal(activeSection);
	const openGateway = useGatewayDialog((s) => s.openGateway);
	const { resolvedTheme } = useTheme();
	const target = toTarget(useActiveNode());
	const simpleInterface = useInterfaceLevel() === "simple";

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

	// Annotated as `NavGroup[]` rather than inferred: the dynamic Apps/Plugins
	// groups come back as `EntityNavGroup`, which is structurally a `NavGroup`
	// without the optional `header`. Left to inference the array widens to a
	// union, and reading `group.header` off it is an error even though every
	// member legitimately lacks the field.
	const navGroups = useMemo<NavGroup[]>(
		() => [
			...NAV_GROUPS.map((group) => ({
				...group,
				title: group.title
					? t(`settings.group.${group.title.toLowerCase()}`, {}, group.title)
					: group.title,
				items: group.items
					.filter((item) => isDesktop || !item.desktopOnly)
					.map((item) => ({
						...item,
						label: t(`settings.nav.${item.value}`, {}, item.label),
					})),
			})).filter((group) => group.items.length > 0),
			// One stand-in tile per dynamic header, in grey: a manifest contributes a
			// settings tab, not a glyph, so the tile says "contributed" rather than
			// pretending to identify the app.
			...buildEntityNavGroups(appEntities, pluginEntities).map((group) => ({
				title: group.title,
				items: group.items.map((item) => ({
					...item,
					icon: group.title === "Apps" ? Package01Icon : PlugSocketIcon,
					tint: "gray" as SettingsTint,
				})),
			})),
		],
		[appEntities, isDesktop, pluginEntities, t]
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

	// A search result may name a setting that lives in the OTHER dialog. Same
	// rule as the manual cross-link above: close this modal before opening that
	// one, so two focus traps never stack. The reveal request survives the swap —
	// it is module state, not component state.
	const handleSelectResult = (entry: SettingsEntry) => {
		requestSettingReveal(entry);
		setSearch("");
		if (entry.dialog === "gateway") {
			onOpenChange(false);
			openGateway(entry.section);
			return;
		}
		setActiveSection(entry.section);
	};

	// Tab-level matches, kept alongside the row-level results: typing "billing"
	// should still offer the Billing tab even though no single row is called that.
	const query = search.trim().toLowerCase();
	const matchedSections = query
		? navGroups
				.flatMap((g) => g.items)
				.filter((item) => item.label.toLowerCase().includes(query))
		: [];

	// Open the feedback widget, matched to the current appearance. If it can't
	// be loaded, tell the user and point them at email instead of failing silently.
	const handleSendFeedback = () => {
		openFeedbackWidget(resolvedTheme === "dark" ? "dark" : "light").catch(
			() => {
				toast.error({
					title: t("settings.feedback.error"),
					description: t("settings.feedback.error_description"),
				});
			}
		);
	};

	useEffect(() => {
		if (open && defaultSection) {
			setActiveSection(normalizeDefaultSection(defaultSection, isDesktop));
		}
	}, [open, defaultSection, isDesktop]);

	// If the selected app/plugin entity disappears (disabled/uninstalled) while its
	// now-orphaned tab is open, fall back to General so the pane never shows nothing.
	useEffect(() => {
		if (isEntitySection(activeSection) && !entityById.has(activeSection)) {
			setActiveSection("general");
		}
	}, [activeSection, entityById]);

	useEffect(() => {
		if (
			!(
				isEntitySection(activeSection) ||
				allItems.some((item) => item.value === activeSection)
			)
		) {
			setActiveSection("general");
		}
	}, [activeSection, allItems]);

	const activeLabel =
		allItems.find((i) => i.value === activeSection)?.label ?? "";
	const activeEntity = entityById.get(activeSection);
	const keyboardShortcutDescription = isDesktop
		? KEYBOARD_SHORTCUT_CONTEXT[activeSection as SectionValue]
		: undefined;

	return (
		<QueryClientProvider client={queryClient}>
			<Dialog onOpenChange={onOpenChange} open={open}>
				{/* 85% of the viewport reads as a dialog on a desktop and as a cramped
				    box with no room for both panes on a phone, so below `md` — the same
				    768px line `useIsMobile` stacks the panes at — it goes
				    edge-to-edge, full dynamic viewport height. */}
				<DialogContent className="!w-[85vw] !max-w-7xl max-md:!w-screen max-md:!max-w-none [&>[data-slot=dialog-close]]:!top-5 [&>[data-slot=dialog-close]]:!right-5 h-[85vh] gap-0 overflow-hidden p-0 max-md:h-[100dvh] max-md:rounded-none">
					<ResizableSettingsLayout
						content={
							<div
								className={
									activeSection === "keyboard"
										? "flex h-full min-h-0 flex-col px-4 py-4 md:px-8 md:py-6"
										: "px-4 py-4 md:px-8 md:py-6"
								}
								ref={contentRef}
							>
								<h2 className="mb-6 shrink-0 font-semibold text-base">
									{activeLabel}
								</h2>
								{activeEntity ? (
									<EntitySettings entity={activeEntity} target={target} />
								) : (
									<div
										className={
											activeSection === "keyboard"
												? "min-h-0 flex-1"
												: "space-y-6"
										}
									>
										<SectionContent value={activeSection as SectionValue} />
										{keyboardShortcutDescription ? (
											<KeyboardShortcutsLink
												description={keyboardShortcutDescription}
												onOpen={() => setActiveSection("keyboard")}
											/>
										) : null}
									</div>
								)}
							</div>
						}
						contentScrollable={activeSection !== "keyboard"}
						sidebar={
							<>
								<SidebarGroup className="py-1">
									<Input
										aria-label={t("settings.search.label")}
										className="h-8 text-sm"
										onChange={(e) => setSearch(e.target.value)}
										placeholder={t("settings.search.placeholder")}
										value={search}
									/>
								</SidebarGroup>
								{query ? (
									<>
										{matchedSections.length > 0 ? (
											<SidebarGroup className="py-1">
												<SidebarGroupLabel>
													{t("settings.search.sections")}
												</SidebarGroupLabel>
												<SidebarMenu>
													{matchedSections.map((item) => (
														<SidebarMenuItem key={item.value}>
															<SidebarMenuButton
																isActive={activeSection === item.value}
																onClick={() => {
																	setActiveSection(item.value);
																	setSearch("");
																}}
															>
																{item.icon ? (
																	<SettingsIconTile
																		icon={item.icon}
																		size="sm"
																		tint={item.tint}
																	/>
																) : null}
																<span className="truncate">{item.label}</span>
															</SidebarMenuButton>
														</SidebarMenuItem>
													))}
												</SidebarMenu>
											</SidebarGroup>
										) : null}
										<SettingsSearchResults
											currentDialog="app"
											onSelect={handleSelectResult}
											query={search}
											showEmptyState={matchedSections.length === 0}
										/>
									</>
								) : null}
								{query
									? null
									: navGroups.map((group, gi) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: static nav groups with no stable key
											<SidebarGroup className="py-1" key={group.title ?? gi}>
												{group.title && (
													<SidebarGroupLabel>{group.title}</SidebarGroupLabel>
												)}
												{group.header}
												<SidebarMenu>
													{group.items.map((item) => (
														<SidebarMenuItem key={item.value}>
															<SidebarMenuButton
																isActive={activeSection === item.value}
																onClick={() => setActiveSection(item.value)}
															>
																{item.icon ? (
																	<SettingsIconTile
																		icon={item.icon}
																		size="sm"
																		tint={item.tint}
																	/>
																) : null}
																<span className="truncate">{item.label}</span>
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
												{t("settings.feedback.send")}
											</SidebarMenuButton>
										</SidebarMenuItem>
									</SidebarMenu>
								</SidebarGroup>
								<SidebarGroup className="py-1">
									<SidebarGroupLabel>
										{simpleInterface
											? t("settings.search.device")
											: t("settings.search.node")}
									</SidebarGroupLabel>
									<SidebarMenu>
										<SidebarMenuItem>
											<SidebarMenuButton onClick={handleOpenGateway}>
												<SettingsIconTile
													icon={ComputerIcon}
													size="sm"
													tint="gray"
												/>
												<span className="truncate">
													{simpleInterface
														? t("settings.search.device_settings")
														: t("settings.search.gateway_settings")}
												</span>
											</SidebarMenuButton>
										</SidebarMenuItem>
									</SidebarMenu>
								</SidebarGroup>
							</>
						}
						// v2: the persisted divider position wins over
						// DEFAULT_SIDEBAR_SIZE, so widening the default only reaches
						// people who have never dragged it unless the key changes with it.
						storageKey="ryu.settings.sidebar-layout.v2"
					/>
				</DialogContent>
			</Dialog>
		</QueryClientProvider>
	);
}
