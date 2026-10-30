import {
	Comment01Icon,
	ComputerIcon,
	Package01Icon,
	PlugSocketIcon,
} from "@hugeicons/core-free-icons";
import ResizableSettingsLayout from "@ryu/blocks/desktop/resizable-settings-layout.tsx";
import { SettingsIconTile } from "@ryu/blocks/desktop/settings-nav.tsx";
import { useI18n } from "@ryu/i18n/react";
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
import { useEffect, useMemo, useRef, useState } from "react";
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
import { toTarget } from "@/src/lib/api/client.ts";
import { requestSettingReveal } from "@/src/lib/settings-focus.ts";
import type { SettingsEntry } from "@/src/lib/settings-index.ts";
import { openFeedbackWidget } from "@/src/lib/userjot.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import { EntitySettings } from "./EntitySettings.tsx";
import { SettingsSearchResults } from "./SettingsSearchResults.tsx";
import {
	KEYBOARD_SHORTCUT_CONTEXT,
	NAV_GROUPS,
	type NavGroup,
	normalizeDefaultSection,
	type SectionValue,
} from "./settings-dialog-nav.tsx";
import {
	KeyboardShortcutsLink,
	SectionContent,
	SettingsContentPane,
} from "./settings-dialog-sections.tsx";

const queryClient = new QueryClient();

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
			// One stand-in glyph per dynamic header: a manifest contributes a
			// settings tab, not a glyph, so the icon says "contributed" rather than
			// pretending to identify the app.
			...buildEntityNavGroups(appEntities, pluginEntities).map((group) => ({
				title: group.title,
				items: group.items.map((item) => ({
					...item,
					icon: group.title === "Apps" ? Package01Icon : PlugSocketIcon,
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
		? KEYBOARD_SHORTCUT_CONTEXT.get(activeSection)
		: undefined;
	// Opened with the pointer (or programmatically), focus lands on the pane
	// title, which shows no ring; opened from the keyboard, it lands on the search
	// so typing filters at once and the focus ring is the expected affordance.
	const titleRef = useRef<HTMLHeadingElement>(null);
	const isKeyboard = activeSection === "keyboard";

	return (
		<QueryClientProvider client={queryClient}>
			<Dialog onOpenChange={onOpenChange} open={open}>
				{/* 85% of the viewport reads as a dialog on a desktop and as a cramped
				    box with no room for both panes on a phone, so below `md` — the same
				    768px line `useIsMobile` stacks the panes at — it goes
				    edge-to-edge, full dynamic viewport height. */}
				<DialogContent
					appearance="gateway-settings"
					initialFocus={(openType) =>
						openType === "keyboard" ? true : titleRef.current
					}
				>
					<ResizableSettingsLayout
						content={
							<SettingsContentPane
								className={
									isKeyboard
										? "flex h-full min-h-0 flex-col px-6 pt-5 pb-8"
										: "px-6 pt-5 pb-8"
								}
								section={activeSection}
							>
								<h2
									className="mb-6 flex h-8 shrink-0 items-center font-semibold text-lg tracking-tight outline-none"
									ref={titleRef}
									tabIndex={-1}
								>
									{activeLabel}
								</h2>
								{activeEntity ? (
									<div className="max-w-2xl">
										<EntitySettings entity={activeEntity} target={target} />
									</div>
								) : (
									<div
										className={
											isKeyboard ? "min-h-0 max-w-2xl flex-1" : "max-w-2xl"
										}
									>
										<SectionContent value={activeSection} />
										{keyboardShortcutDescription ? (
											<KeyboardShortcutsLink
												description={keyboardShortcutDescription}
												onOpen={() => setActiveSection("keyboard")}
											/>
										) : null}
									</div>
								)}
							</SettingsContentPane>
						}
						contentScrollable={!isKeyboard}
						sidebar={
							<>
								<SidebarGroup spacing="compact">
									<Input
										aria-label={t("settings.search.label")}
										onChange={(e) => setSearch(e.target.value)}
										placeholder={t("settings.search.placeholder")}
										size="settings-search"
										value={search}
									/>
								</SidebarGroup>
								{query ? (
									<>
										{matchedSections.length > 0 ? (
											<SidebarGroup spacing="compact">
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
																	<SettingsIconTile icon={item.icon} />
																) : null}
																<span className="truncate" title={item.label}>
																	{item.label}
																</span>
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
											// static nav groups with no stable key
											<SidebarGroup key={group.title ?? gi} spacing="compact">
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
																	<SettingsIconTile icon={item.icon} />
																) : null}
																<span className="truncate" title={item.label}>
																	{item.label}
																</span>
															</SidebarMenuButton>
														</SidebarMenuItem>
													))}
												</SidebarMenu>
											</SidebarGroup>
										))}
								{/* The way out to the node's own settings and the feedback
								    widget: two plain rows at the foot of the nav, no label. */}
								<SidebarGroup className="mt-auto" spacing="compact">
									<SidebarMenu>
										<SidebarMenuItem>
											<SidebarMenuButton onClick={handleOpenGateway}>
												<SettingsIconTile icon={ComputerIcon} />
												<span className="truncate">
													{simpleInterface
														? t("settings.search.device_settings")
														: t("settings.search.gateway_settings")}
												</span>
											</SidebarMenuButton>
										</SidebarMenuItem>
										<SidebarMenuItem>
											<SidebarMenuButton onClick={handleSendFeedback}>
												<SettingsIconTile icon={Comment01Icon} />
												<span className="truncate">
													{t("settings.feedback.send")}
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
