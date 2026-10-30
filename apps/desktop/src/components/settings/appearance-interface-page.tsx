import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { setAgentRowStyle } from "@/src/hooks/useAgentRowStyle.ts";
import { setChromeShadows } from "@/src/hooks/useChromeShadows.ts";
import { setDialogOverlayBlur } from "@/src/hooks/useDialogOverlayBlur.ts";
import { setInvertedBackgrounds } from "@/src/hooks/useInvertedBackgrounds.ts";
import { setPointerCursor } from "@/src/hooks/usePointerCursor.ts";
import { setPopupOverlayBlur } from "@/src/hooks/usePopupOverlayBlur.ts";
import { sidebarModeSchema } from "@/src/hooks/useSidebarMode.ts";
import { NOTIFICATION_LAYOUT_STEPS } from "@/src/lib/notification-layout.ts";
import { NotificationLayoutSlider } from "./appearance-level-sliders.tsx";
import { CHAT_PICKER_PLACEMENT_OPTIONS } from "./appearance-options.tsx";
import type { AppearanceTabState } from "./appearance-tab-state.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

export function AppearanceInterfacePage({
	state,
}: {
	state: AppearanceTabState;
}) {
	const tl = useLiteralMessages();
	const {
		isDesktop,
		pointerCursorEnabled,
		chromeShadowsEnabled,
		dialogOverlayBlurEnabled,
		popupOverlayBlurEnabled,
		invertedBackgroundsEnabled,
		friendlyNames,
		setFriendlyNames,
		botTerminology,
		setBotTerminologyEnabled,
		botTerminologyForced,
		groupChatsByDate,
		setGroupChatsByDate,
		sidebarGroupedNav,
		setSidebarGroupedNav,
		sidebarTransparency,
		setSidebarTransparency,
		windowTransparency,
		setWindowTransparency,
		agentRowStyle,
		sidebarChatPreview,
		setSidebarChatPreview,
		chatPickerPlacement,
		setChatPickerPlacement,
		markdownComposer,
		setMarkdownComposer,
		contributedModes,
		sidebarMode,
		setSidebarMode,
		sidebarVariant,
		setSidebarVariant,
		sidebarOverflowPopover,
		setSidebarOverflowPopover,
		tabDropdown,
		setTabDropdown,
		tabSearchButtonVisible,
		setTabSearchButtonVisible,
		notificationLayoutStep,
		handleNotificationLayoutStep,
		nodeSelectorDetail,
		setNodeSelectorDetail,
	} = state;
	return (
		<SettingsSection>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							checked={friendlyNames}
							id="friendly-names-toggle"
							onCheckedChange={setFriendlyNames}
						/>
					}
					// The description names the two kinds of thing this now covers,
					// because they read as one setting but are not: renaming a MODEL is
					// cosmetic, while renaming an OPTION ("Graph" → "Connected search")
					// changes the word a user will look for in docs, in support, and in
					// this app's own settings. Saying so is what makes turning it off a
					// deliberate choice rather than a mystery, and the last sentence is
					// there because the setting reaches installed apps and plugins too —
					// a user who sees a plugin change wording should know why.
					description="Everyday wording instead of technical names, across the app and its apps."
					title="Friendly names"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={botTerminologyForced || botTerminology}
							disabled={botTerminologyForced}
							id="bot-terminology-toggle"
							onCheckedChange={setBotTerminologyEnabled}
						/>
					}
					description="Use the Bot vocabulary in interface copy. Ryu Work keeps this on."
					title="Use Bot terminology"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={pointerCursorEnabled}
							id="pointer-cursor-toggle"
							onCheckedChange={setPointerCursor}
						/>
					}
					title="Pointer cursor"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={chromeShadowsEnabled}
							id="chrome-shadows-toggle"
							onCheckedChange={setChromeShadows}
						/>
					}
					description="Shadows on title-bar groups and the floating sidebar."
					title="Navigation & sidebar shadows"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={dialogOverlayBlurEnabled}
							id="dialog-overlay-blur-toggle"
							onCheckedChange={setDialogOverlayBlur}
						/>
					}
					description="Dim and blur the app behind dialogs, sheets and drawers."
					title="Blur dialog backgrounds"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={popupOverlayBlurEnabled}
							id="popup-overlay-blur-toggle"
							onCheckedChange={setPopupOverlayBlur}
						/>
					}
					description="Dim and blur the app behind menus and popovers. Off by default."
					title="Blur popup backgrounds"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={invertedBackgroundsEnabled}
							id="inverted-backgrounds-toggle"
							onCheckedChange={setInvertedBackgrounds}
						/>
					}
					description="Menus, popovers and tooltips use the page background."
					title="Invert overlay backgrounds"
				/>
				{isDesktop && (
					<>
						<SettingsItem
							actions={
								<Switch
									aria-label="Transparent sidebar"
									checked={sidebarTransparency}
									id="transparent-sidebar-toggle"
									onCheckedChange={setSidebarTransparency}
								/>
							}
							description="Show the window backdrop through the sidebar with a soft blur."
							settingsId="appearance.sidebar-transparency"
							title="Transparent sidebar"
						/>
						<SettingsItem
							actions={
								<Switch
									aria-label="Transparent window"
									checked={windowTransparency}
									id="transparent-window-toggle"
									onCheckedChange={setWindowTransparency}
								/>
							}
							description="Show the window backdrop through the main canvas with a soft blur."
							settingsId="appearance.window-transparency"
							title="Transparent window"
						/>
					</>
				)}
				<SettingsItem
					actions={
						<Switch
							checked={sidebarMode === "tabbed"}
							id="sidebar-tabbed-toggle"
							onCheckedChange={(checked) =>
								setSidebarMode(checked ? "tabbed" : "sections")
							}
						/>
					}
					description="Show one sidebar section at a time, picked from a bar at the top."
					title="Tabbed sidebar"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={sidebarMode === "agent"}
							id="sidebar-agent-mode-toggle"
							onCheckedChange={(checked) =>
								setSidebarMode(checked ? "agent" : "sections")
							}
						/>
					}
					description="Threads grouped under each bot, messaging style. Ryu Work turns it on."
					title="Agents view"
				/>
				{/* App-registered modes (`contributes.sidebar_modes`). Rendered from the
					    same list the sidebar's own menu offers, so the two cannot disagree
					    about which contributed modes are real. Inert until an enabled app
					    ships one. */}
				{contributedModes.map((mode) => (
					<SettingsItem
						actions={
							<Switch
								checked={sidebarMode === mode.key}
								id={`sidebar-mode-${mode.key}`}
								onCheckedChange={(checked) =>
									setSidebarMode(
										checked ? sidebarModeSchema.parse(mode.key) : "sections"
									)
								}
							/>
						}
						description={
							mode.description ??
							tl(
								"Arrange the sidebar as {title}, offering {count} section(s) as tabs. Turn off to go back to the full section list.",
								{
									title: mode.title,
									count: String(mode.sections?.length ?? 0),
								}
							)
						}
						key={mode.key}
						title={mode.title}
					/>
				))}
				<SettingsItem
					actions={
						<Switch
							checked={groupChatsByDate}
							id="group-chats-by-date-toggle"
							onCheckedChange={setGroupChatsByDate}
						/>
					}
					description="Group timestamped sidebar lists into Today, Yesterday and older."
					title="Group lists by date"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={sidebarGroupedNav}
							id="sidebar-grouped-nav-toggle"
							onCheckedChange={setSidebarGroupedNav}
						/>
					}
					description="One picker each for Projects and Spaces instead of a row per item."
					title="Projects & Spaces as pickers"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={sidebarVariant === "inset"}
							id="sidebar-inset-toggle"
							onCheckedChange={(checked) =>
								setSidebarVariant(checked ? "inset" : "floating")
							}
						/>
					}
					description="Sidebar flush with the window, content as its own rounded card."
					title="Inset sidebar"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={agentRowStyle === "messaging"}
							id="agent-row-messaging-toggle"
							onCheckedChange={(checked) =>
								setAgentRowStyle(checked ? "messaging" : "compact")
							}
						/>
					}
					description={
						sidebarMode === "agent"
							? "Draw each agent in the sidebar the way a messaging app does: a large round avatar spanning two lines, the agent's name and the time of its last message on the first, and a preview of that message below. The Agents view draws these rows regardless; this switch is what you return to when you leave it."
							: "Draw each agent in the sidebar the way a messaging app does: a large round avatar spanning two lines, the agent's name and the time of its last message on the first, and a preview of that message below. Turn off for the compact single-line row."
					}
					title="Messaging-style agent rows"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={sidebarChatPreview}
							id="sidebar-chat-preview-toggle"
							onCheckedChange={setSidebarChatPreview}
						/>
					}
					description="Two-line chat rows with the latest message and run state."
					title="Show latest message / tool state in sidebar"
				/>
				<SettingsItem
					actions={
						<Select
							items={CHAT_PICKER_PLACEMENT_OPTIONS}
							onValueChange={(value) => {
								if (value === "composer" || value === "tab-bar") {
									setChatPickerPlacement(value);
								}
							}}
							value={chatPickerPlacement}
						>
							<SelectTrigger
								className="w-auto max-w-64 shrink-0"
								id="chat-picker-placement-select"
								size="sm"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{CHAT_PICKER_PLACEMENT_OPTIONS.map((o) => (
									<SelectItem key={o.value} value={o.value}>
										{o.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					description="Where the model and agent picker sits: composer or tab bar."
					title="Chat model & agent picker"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={markdownComposer}
							id="markdown-composer-toggle"
							onCheckedChange={setMarkdownComposer}
						/>
					}
					description="Render Markdown links and blocks inline while you type."
					title="Rich Markdown composer"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={nodeSelectorDetail}
							id="node-selector-detail-toggle"
							onCheckedChange={setNodeSelectorDetail}
						/>
					}
					description="Hardware, usage and version captions in the node picker."
					title="Detailed node picker"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={sidebarOverflowPopover}
							id="sidebar-overflow-popover-toggle"
							onCheckedChange={setSidebarOverflowPopover}
						/>
					}
					description="Open long sidebar sections in a searchable popover."
					title="Search overflow in a popover"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={tabDropdown}
							id="tab-dropdown-toggle"
							onCheckedChange={setTabDropdown}
						/>
					}
					description="One searchable dropdown instead of the full tab strip."
					title="Show tabs as a dropdown"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={tabSearchButtonVisible}
							disabled={tabDropdown}
							id="tab-search-button-toggle"
							onCheckedChange={setTabSearchButtonVisible}
						/>
					}
					description="The chevron beside + that lists every open tab."
					title="Show tab search button"
				/>
				<SettingsItem
					actions={
						<NotificationLayoutSlider
							onStepChange={handleNotificationLayoutStep}
							step={notificationLayoutStep}
						/>
					}
					description={
						NOTIFICATION_LAYOUT_STEPS[notificationLayoutStep]?.description
					}
					title="Notification layout"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}
