import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useAutoHideTitleBar } from "@/src/hooks/useAutoHideTitleBar.ts";
import { useFloatingTabs } from "@/src/hooks/useFloatingTabs.ts";
import {
	setNodeTabOverride,
	useNodeTabOverride,
} from "@/src/hooks/useNodeDisplayMode.ts";
import { usePersistedNumber } from "@/src/hooks/usePersistedNumber.ts";
import { useShowBottomPanelToggle } from "@/src/hooks/useShowBottomPanelToggle.ts";
import {
	setTabLayout,
	TAB_LAYOUT_OPTIONS,
	type TabLayout,
	useTabLayout,
} from "@/src/hooks/useTabLayout.ts";
import {
	setTabOpenBehavior,
	useTabOpenBehavior,
} from "@/src/hooks/useTabOpenBehavior.ts";
import { setTabSizing, useTabSizing } from "@/src/hooks/useTabSizing.ts";
import {
	setTabSwitchBehavior,
	type TabSwitchBehavior,
	useTabSwitchBehavior,
} from "@/src/hooks/useTabSwitchBehavior.ts";
import {
	DEFAULT_TAB_UNLOAD_MINUTES,
	TAB_UNLOAD_MINUTES_KEY,
} from "@/src/lib/tab-memory-policy.ts";
import {
	TAB_SWITCH_OPTIONS,
	TAB_UNLOAD_OPTIONS,
} from "./GeneralTab-options.ts";
import { SplitPresetSettings } from "./SplitPresetSettings.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/** General → Tabs & panes. */
export function GeneralTabTabsPage() {
	const tabOverrideEnabled = useNodeTabOverride();
	const tabLayout = useTabLayout();
	const tabSizing = useTabSizing();
	const [floatingTabs, setFloatingTabs] = useFloatingTabs();
	const [autoHideTitleBar, setAutoHideTitleBar] = useAutoHideTitleBar();
	const tabOpenBehavior = useTabOpenBehavior();
	const tabSwitchBehavior = useTabSwitchBehavior();
	const [tabUnloadMinutes, setTabUnloadMinutes] = usePersistedNumber(
		TAB_UNLOAD_MINUTES_KEY,
		DEFAULT_TAB_UNLOAD_MINUTES
	);
	const [showBottomPanelToggle, setShowBottomPanelToggle] =
		useShowBottomPanelToggle();

	return (
		<>
			<SettingsSection title="Tabs">
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={tabOpenBehavior === "current"}
								id="open-in-current-tab-toggle"
								onCheckedChange={(checked) =>
									setTabOpenBehavior(checked ? "current" : "new")
								}
							/>
						}
						description="Sidebar and palette links reuse this tab. Pinned and split tabs are never replaced."
						title="Open links in the current tab"
					/>
					<SettingsItem
						actions={
							<Select<TabSwitchBehavior>
								items={TAB_SWITCH_OPTIONS}
								onValueChange={(v) => setTabSwitchBehavior(v)}
								value={tabSwitchBehavior}
							>
								<SelectTrigger
									className="w-auto max-w-64 shrink-0"
									id="tab-switch-behavior-select"
									size="sm"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{TAB_SWITCH_OPTIONS.map((opt) => (
										<SelectItem key={opt.value} value={opt.value}>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						title="Switch tabs with Ctrl/Cmd+Tab"
					/>
					<SettingsItem
						actions={
							<Select<TabLayout>
								items={TAB_LAYOUT_OPTIONS}
								onValueChange={(value) => setTabLayout(value)}
								value={tabLayout}
							>
								<SelectTrigger
									className="w-auto max-w-64 shrink-0"
									id="tab-layout-select"
									size="sm"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{TAB_LAYOUT_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						title="Tab layout"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={floatingTabs}
								id="floating-tabs-toggle"
								onCheckedChange={setFloatingTabs}
							/>
						}
						title="Floating tabs"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={autoHideTitleBar}
								id="auto-hide-titlebar-toggle"
								onCheckedChange={setAutoHideTitleBar}
							/>
						}
						description="Hide the title bar and tabs until the cursor nears the top of the window."
						title="Auto-hide title bar"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={tabSizing === "fit"}
								disabled={tabLayout === "vertical"}
								id="fit-tabs-toggle"
								onCheckedChange={(checked) =>
									setTabSizing(checked ? "fit" : "fixed")
								}
							/>
						}
						title="Fit tabs to width"
					/>
					<SettingsItem
						actions={
							<Select
								items={TAB_UNLOAD_OPTIONS}
								onValueChange={(v) => setTabUnloadMinutes(Number(v))}
								value={String(tabUnloadMinutes)}
							>
								<SelectTrigger
									className="w-auto max-w-64 shrink-0"
									id="tab-unload-select"
									size="sm"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{TAB_UNLOAD_OPTIONS.map((opt) => (
										<SelectItem key={opt.value} value={opt.value}>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Frees memory. Pinned, active and running tabs are never unloaded."
						title="Unload inactive tabs"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={tabOverrideEnabled}
								id="tab-override-toggle"
								onCheckedChange={setNodeTabOverride}
							/>
						}
						title="Per-tab node override"
					/>
				</SettingsGroup>
			</SettingsSection>
			<SettingsSection title="Interface">
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={showBottomPanelToggle}
								id="show-bottom-panel-toggle"
								onCheckedChange={setShowBottomPanelToggle}
							/>
						}
						description="Show the bottom-panel control in the chat header."
						settingsId="general.interface.bottom-panel"
						title="Bottom panel"
					/>
				</SettingsGroup>
			</SettingsSection>

			{/* Split-view layout presets: captured from the split's own context
			    menu, renamed or deleted here. */}
			<SplitPresetSettings />
		</>
	);
}
