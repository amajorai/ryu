import {
	Chat01Icon,
	CommandLineIcon,
	ComputerIcon,
	FolderOpenIcon,
	LayoutTable01Icon,
	Rocket01Icon,
} from "@hugeicons/core-free-icons";
import { SettingsSubpages } from "@ryu/blocks/desktop/settings-nav.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { invoke } from "@tauri-apps/api/core";
import {
	disable as disableAutostart,
	enable as enableAutostart,
	isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listAccounts } from "@/lib/auth-client.ts";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import { TAB_UNLOAD_MINUTES_KEY } from "@/src/contexts/TabsContext.tsx";
import { useAutoHideTitleBar } from "@/src/hooks/useAutoHideTitleBar.ts";
import { useAutoImportThreads } from "@/src/hooks/useAutoImportThreads.ts";
import { useAutoSetupImportSetting } from "@/src/hooks/useAutoSetupImportSetting.ts";
import {
	type ComposerSelectionApplyMode,
	useComposerSelectionApplyMode,
} from "@/src/hooks/useComposerSelectionApplyMode.ts";
import {
	COMPOSER_SEND_SHORTCUT_OPTIONS,
	type ComposerSendShortcut,
	useComposerSendShortcut,
} from "@/src/hooks/useComposerSendShortcut.ts";
import { useFloatingTabs } from "@/src/hooks/useFloatingTabs.ts";
import {
	setNodeTabOverride,
	useNodeTabOverride,
} from "@/src/hooks/useNodeDisplayMode.ts";
import { usePersistedNumber } from "@/src/hooks/usePersistedNumber.ts";
import {
	type QueueDrainMode,
	setQueueDrainMode,
	useQueueDrainMode,
} from "@/src/hooks/useQueueDrainMode.ts";
import { usePendingSubpage } from "@/src/hooks/useSettingSubpage.ts";
import {
	type StartupBehavior,
	setStartupBehavior,
	useStartupBehavior,
} from "@/src/hooks/useStartupBehavior.ts";
import { useStartupRealm } from "@/src/hooks/useStartupRealm.ts";
import { useStartupSelection } from "@/src/hooks/useStartupSelection.ts";
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
import type { DefaultFileOpener } from "@/src/lib/default-file-opener.ts";
import {
	isStartupRealm,
	STARTUP_REALM_OPTIONS,
	type StartupRealm,
} from "@/src/lib/product-mode.ts";
import type { StartupSelectionMode } from "@/src/lib/startup-selection.ts";
import { STORAGE_KEYS } from "@/src/lib/themes/presets.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { SafeModeSettings } from "./SafeModeSettings.tsx";
import { SplitPresetSettings } from "./SplitPresetSettings.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";
import { TrainingDataNotice } from "./TrainingDataNotice.tsx";

// What the window opens on at launch — a Chrome-style "On startup" choice.
const STARTUP_OPTIONS: { value: StartupBehavior; label: string }[] = [
	{ value: "empty", label: "The launchpad (no tabs)" },
	{ value: "home", label: "The Home page" },
	{ value: "chat", label: "A new chat" },
	{ value: "restore", label: "Reopen previous tabs" },
];

const STARTUP_SELECTION_OPTIONS: {
	value: StartupSelectionMode;
	label: string;
}[] = [
	{ value: "always", label: "Always ask" },
	{ value: "defaults", label: "Use defaults" },
	{ value: "never", label: "Never show" },
];

const NO_STARTUP_DEFAULT = "__ask_at_startup__";

// How the message queue drains while an agent is still responding.
const QUEUE_DRAIN_OPTIONS: { value: QueueDrainMode; label: string }[] = [
	{ value: "off", label: "Off (send immediately)" },
	{ value: "auto", label: "Auto (Claude Code)" },
	{ value: "oldest-first", label: "Oldest first" },
	{ value: "latest-first", label: "Latest first" },
	{ value: "send-all", label: "Send all together" },
];

const COMPOSER_SELECTION_APPLY_OPTIONS: {
	value: ComposerSelectionApplyMode;
	label: string;
}[] = [
	{ value: "next-turn", label: "On the next turn" },
	{ value: "next-user-message", label: "On the next user message" },
];

// Which shell the built-in terminal and git actions run their commands through.
// "auto" lets the Rust side pick the OS default; every other value is an
// allowlisted shell name understood by the `shell_execute` command.
const TERMINAL_SHELL_OPTIONS = [
	{ value: "auto", label: "OS default" },
	{ value: "bash", label: "Bash" },
	{ value: "zsh", label: "Zsh" },
	{ value: "sh", label: "sh" },
	{ value: "fish", label: "Fish" },
	{ value: "powershell", label: "PowerShell" },
	{ value: "pwsh", label: "pwsh" },
	{ value: "cmd", label: "cmd" },
];

const FILE_MANAGER_NAME = navigator.userAgent.includes("Mac")
	? "Finder"
	: navigator.userAgent.includes("Windows")
		? "Explorer"
		: "Files";

const DEFAULT_FILE_OPENER_OPTIONS: {
	value: DefaultFileOpener;
	label: string;
}[] = [
	{ value: "system", label: `OS default (${FILE_MANAGER_NAME})` },
	{ value: "vscode", label: "VS Code" },
	{ value: "cursor", label: "Cursor" },
	{ value: "zed", label: "Zed" },
];

// Minute thresholds offered for auto-unloading inactive tabs. 0 disables it.
const TAB_UNLOAD_OPTIONS = [
	{ value: "0", label: "Never" },
	{ value: "5", label: "After 5 minutes" },
	{ value: "10", label: "After 10 minutes" },
	{ value: "15", label: "After 15 minutes" },
	{ value: "30", label: "After 30 minutes" },
	{ value: "60", label: "After 1 hour" },
];

// Ctrl/Cmd+Tab cycle order — sequential strip order (default) or MRU.
const TAB_SWITCH_OPTIONS: { value: TabSwitchBehavior; label: string }[] = [
	{ value: "sequential", label: "In order (left to right)" },
	{ value: "recent", label: "Most recently used" },
];

export function GeneralTab() {
	const { canManageDesktopLifecycle, canUseNativeShell, isDesktop } =
		useAppSurface();
	// Which sub-page a settings-search hit lives on, so the reveal has something
	// to find — a row on a closed page is not in the DOM.
	const pendingSubpage = usePendingSubpage("general");
	const navigate = useNavigate();
	const tabOverrideEnabled = useNodeTabOverride();
	const tabLayout = useTabLayout();
	const tabSizing = useTabSizing();
	const [floatingTabs, setFloatingTabs] = useFloatingTabs();
	const [autoHideTitleBar, setAutoHideTitleBar] = useAutoHideTitleBar();
	const tabOpenBehavior = useTabOpenBehavior();
	const tabSwitchBehavior = useTabSwitchBehavior();
	const startupBehavior = useStartupBehavior();
	const { realm: startupRealm, setRealm: setStartupRealmPreference } =
		useStartupRealm();
	const {
		preferences: startupSelection,
		setDefaultAccountId,
		setDefaultNodeName,
		setMode: setStartupSelectionMode,
	} = useStartupSelection();
	const startupAccounts = listAccounts();
	const startupNodes = useNodeStore((state) => state.nodes);
	const setDefaultNode = useNodeStore((state) => state.setDefault);
	const startupDefaultAccountValue = startupAccounts.some(
		(account) => account.userId === startupSelection.defaultAccountId
	)
		? (startupSelection.defaultAccountId ?? NO_STARTUP_DEFAULT)
		: NO_STARTUP_DEFAULT;
	const startupDefaultNodeValue = startupNodes.some(
		(node) => node.name === startupSelection.defaultNodeName
	)
		? (startupSelection.defaultNodeName ?? NO_STARTUP_DEFAULT)
		: NO_STARTUP_DEFAULT;
	const queueDrainMode = useQueueDrainMode();
	const [composerSendShortcut, setComposerSendShortcut] =
		useComposerSendShortcut();
	const [composerSelectionApplyMode, setComposerSelectionApplyModeSetting] =
		useComposerSelectionApplyMode();
	const terminalShell = useWorkspaceStore((s) => s.terminalShell);
	const setTerminalShell = useWorkspaceStore((s) => s.setTerminalShell);
	const defaultFileOpener = useWorkspaceStore((s) => s.defaultFileOpener);
	const setDefaultFileOpener = useWorkspaceStore((s) => s.setDefaultFileOpener);
	const [autoImportThreads, setAutoImportThreads] = useAutoImportThreads();
	const [autoImportSetup, setAutoImportSetup] = useAutoSetupImportSetting();
	const [tabUnloadMinutes, setTabUnloadMinutes] = usePersistedNumber(
		TAB_UNLOAD_MINUTES_KEY,
		0
	);

	// "Hide tray icon" is persisted in the desktop process (tauri-plugin-store)
	// so it can be read at startup before Core is up. Disabled by default — the
	// icon shows in the tray / menu bar unless the user opts out.
	const [hideTrayIcon, setHideTrayIcon] = useState(false);
	// "Stay in the tray when closed" lives in the same desktop-process store and
	// is ON by default, so seed it optimistically to true — reading it back false
	// for a frame would flash the toggle off on every open.
	const [closeToTray, setCloseToTray] = useState(true);
	useEffect(() => {
		if (!canManageDesktopLifecycle) {
			return;
		}
		invoke<boolean>("get_hide_tray_icon")
			.then(setHideTrayIcon)
			.catch(() => {
				// Non-Tauri context or command unavailable: keep the default.
			});
		invoke<boolean>("get_close_to_tray")
			.then(setCloseToTray)
			.catch(() => {
				// Non-Tauri context or command unavailable: keep the default.
			});
	}, [canManageDesktopLifecycle]);

	// "Launch at login" is an OS registration (macOS LaunchAgent, Windows Run key,
	// Linux ~/.config/autostart), so the OS — not a local mirror — is the source
	// of truth: seed the toggle from the plugin. "Start hidden" is a local desktop
	// preference read during startup, and only applies to a login-launched
	// instance, so a manual launch is always visible.
	const [launchAtLogin, setLaunchAtLogin] = useState(false);
	const [startHidden, setStartHidden] = useState(false);
	useEffect(() => {
		if (!canManageDesktopLifecycle) {
			return;
		}
		isAutostartEnabled()
			.then(setLaunchAtLogin)
			.catch(() => {
				// Non-Tauri context or unsupported platform: keep the default.
			});
		invoke<boolean>("get_start_hidden")
			.then(setStartHidden)
			.catch(() => {
				// Non-Tauri context or command unavailable: keep the default.
			});
	}, [canManageDesktopLifecycle]);

	const handleLaunchAtLogin = async (enabled: boolean) => {
		setLaunchAtLogin(enabled);
		try {
			await (enabled ? enableAutostart() : disableAutostart());
		} catch {
			setLaunchAtLogin(!enabled);
			toast.error("Couldn't update the launch-at-login setting", {
				description:
					"Your change wasn't saved. You may need to allow Ryu to start at login in your system settings.",
			});
		}
	};

	const handleStartHidden = async (hidden: boolean) => {
		setStartHidden(hidden);
		try {
			await invoke("set_start_hidden", { hidden });
		} catch {
			setStartHidden(!hidden);
			toast.error("Couldn't update the start-hidden setting", {
				description: "Your change wasn't saved. Please try again.",
			});
		}
	};

	const handleCloseToTray = async (enabled: boolean) => {
		setCloseToTray(enabled);
		try {
			await invoke("set_close_to_tray", { enabled });
		} catch {
			setCloseToTray(!enabled);
			toast.error("Couldn't update the close-to-tray setting", {
				description: "Your change wasn't saved. Please try again.",
			});
		}
	};

	const handleHideTrayIcon = async (hidden: boolean) => {
		setHideTrayIcon(hidden);
		try {
			await invoke("set_hide_tray_icon", { hidden });
		} catch {
			// Revert the optimistic toggle if the command failed.
			setHideTrayIcon(!hidden);
			toast.error("Couldn't update the tray icon setting", {
				description: "Your change wasn't saved. Please try again.",
			});
		}
	};

	const handleDefaultNodeChange = (name: string) => {
		const nextName = name === NO_STARTUP_DEFAULT ? null : name;
		if (!nextName) {
			setDefaultNodeName(null);
			return;
		}
		void setDefaultNode(nextName)
			.then(() => {
				setDefaultNodeName(nextName);
			})
			.catch(() => {
				toast.error("Couldn't update the default node", {
					description: "Your change wasn't saved. Please try again.",
				});
			});
	};

	const resetOnboarding = () => {
		for (const key of [
			"ryu_onboarding_complete",
			"ryu_setup_seen",
			"ryu_default_agent",
			STORAGE_KEYS.lightPreset,
			STORAGE_KEYS.darkPreset,
			STORAGE_KEYS.uiFont,
			STORAGE_KEYS.headingFont,
			STORAGE_KEYS.codeFont,
			STORAGE_KEYS.contrast,
			STORAGE_KEYS.radius,
			STORAGE_KEYS.spacing,
			STORAGE_KEYS.scale,
			STORAGE_KEYS.cardSpacing,
			STORAGE_KEYS.chatWidth,
		]) {
			localStorage.removeItem(key);
		}
		navigate("/onboarding");
	};

	// ── Sub-pages ────────────────────────────────────────────────────────────
	// Seven groups covering tabs, chats, the terminal, file opening, tray behaviour
	// and setup —
	// unrelated topics that shared one scroll. Split the way iOS/macOS General
	// is: an index of topics, one page each. "On startup" stays on the index
	// because it is the question people open this pane to answer.
	//
	// Bodies are the same nodes as before, moved verbatim. Adding a group here
	// means adding it to `SUBPAGE_BY_GROUP` in `settings-index.ts` too, or
	// settings search will land on this pane and highlight nothing.
	const startupIntro = (
		<div className="space-y-6">
			<SettingsSection
				caption="What Ryu opens when you launch it."
				title="On startup"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Select
								items={STARTUP_OPTIONS}
								onValueChange={(v) => setStartupBehavior(v as StartupBehavior)}
								value={startupBehavior}
							>
								<SelectTrigger
									className="h-8 w-56 flex-shrink-0 text-sm"
									id="startup-behavior-select"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{STARTUP_OPTIONS.map((opt) => (
										<SelectItem key={opt.value} value={opt.value}>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Choose what opens when the window launches: a clean launchpad with no tabs, the Home page, a new chat, or the tabs you had open last time."
						title="Open with"
					/>
					{isDesktop ? (
						<SettingsItem
							actions={
								<Select
									items={STARTUP_REALM_OPTIONS}
									onValueChange={(value) => {
										if (isStartupRealm(value)) {
											setStartupRealmPreference(value);
										}
									}}
									value={startupRealm}
								>
									<SelectTrigger
										className="h-8 w-56 flex-shrink-0 text-sm"
										id="startup-realm-select"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{STARTUP_REALM_OPTIONS.map((option) => (
											<SelectItem
												key={option.value}
												value={option.value satisfies StartupRealm}
											>
												{option.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							}
							description="Choose which realm opens when Ryu launches. Last used remembers the realm you selected most recently; new users start in Bot."
							settingsId="general.on-startup.realm"
							title="Realm on startup"
						/>
					) : null}
					<SettingsItem
						actions={
							<Select
								items={STARTUP_SELECTION_OPTIONS}
								onValueChange={(value) =>
									setStartupSelectionMode(value as StartupSelectionMode)
								}
								value={startupSelection.mode}
							>
								<SelectTrigger
									className="h-8 w-56 flex-shrink-0 text-sm"
									id="startup-selection-mode-select"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{STARTUP_SELECTION_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Choose whether Ryu asks for an account and node every time, uses the defaults below when available, or skips this screen."
						title="Account and node selection"
					/>
					<SettingsItem
						actions={
							<Select
								disabled={startupAccounts.length === 0}
								items={[
									{ label: "Ask at startup", value: NO_STARTUP_DEFAULT },
									...startupAccounts.map((account) => ({
										label: account.isAnonymous
											? "Guest"
											: account.name || account.email || "Account",
										value: account.userId,
									})),
								]}
								onValueChange={(value) =>
									setDefaultAccountId(
										value === NO_STARTUP_DEFAULT ? null : value
									)
								}
								value={startupDefaultAccountValue}
							>
								<SelectTrigger
									className="h-8 w-56 flex-shrink-0 text-sm"
									id="startup-default-account-select"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={NO_STARTUP_DEFAULT}>
										Ask at startup
									</SelectItem>
									{startupAccounts.map((account) => (
										<SelectItem key={account.userId} value={account.userId}>
											{account.isAnonymous
												? "Guest"
												: account.name || account.email || "Account"}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Used by Use defaults. Choose Ask at startup to select an account on the next launch."
						title="Default account"
					/>
					<SettingsItem
						actions={
							<Select
								disabled={startupNodes.length === 0}
								items={[
									{ label: "Ask at startup", value: NO_STARTUP_DEFAULT },
									...startupNodes.map((node) => ({
										label: node.name,
										value: node.name,
									})),
								]}
								onValueChange={handleDefaultNodeChange}
								value={startupDefaultNodeValue}
							>
								<SelectTrigger
									className="h-8 w-56 flex-shrink-0 text-sm"
									id="startup-default-node-select"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={NO_STARTUP_DEFAULT}>
										Ask at startup
									</SelectItem>
									{startupNodes.map((node) => (
										<SelectItem key={node.name} value={node.name}>
											{node.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Used by Use defaults. Choose Ask at startup to select a node on the next launch."
						title="Default node"
					/>
				</SettingsGroup>
			</SettingsSection>
			<TrainingDataNotice />
		</div>
	);

	const tabsPage = (
		<>
			<SettingsSection caption="How open tabs look and behave." title="Tabs">
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
						description="Open pages from the sidebar and command palette in the tab you're already on instead of a new tab each time. Pinned and split tabs are never replaced, and you can still open a new tab any time: middle-click a sidebar item, use its “Open in new tab” menu, or the + button."
						title="Open links in the current tab"
					/>
					<SettingsItem
						actions={
							<Select
								items={TAB_SWITCH_OPTIONS}
								onValueChange={(v) =>
									setTabSwitchBehavior(v as TabSwitchBehavior)
								}
								value={tabSwitchBehavior}
							>
								<SelectTrigger
									className="h-8 w-56 flex-shrink-0 text-sm"
									id="tab-switch-behavior-select"
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
						description="Ctrl/Cmd+Tab and Ctrl/Cmd+Shift+Tab cycle open tabs. In order walks the tab strip left to right; most recently used jumps between tabs you've viewed lately (hold the modifier and press Tab repeatedly to keep cycling)."
						title="Switch tabs with Ctrl/Cmd+Tab"
					/>
					<SettingsItem
						actions={
							<Select
								items={TAB_LAYOUT_OPTIONS}
								onValueChange={(value) => setTabLayout(value as TabLayout)}
								value={tabLayout}
							>
								<SelectTrigger
									className="h-8 w-52 flex-shrink-0 text-sm"
									id="tab-layout-select"
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
						description="Choose how open tabs appear: a compact top strip, a sidebar list, a center-pane scroll track, or an infinite canvas."
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
						description="Keep tabs as separate floating pills. Turn this off to let the active tab blend into the page surface with a morphing-tab shape."
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
						description="Tuck the title bar and tab strip away until you move the cursor near the top of the window, like the floating sidebar peek. Off by default, so the bar stays docked and always visible."
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
						description="Shrink open tabs equally to share the available width (Chrome-style) instead of keeping each a fixed size and scrolling the bar when they overflow. Only applies to the horizontal tab bar."
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
									className="h-8 w-40 flex-shrink-0 text-sm"
									id="tab-unload-select"
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
						description="Free memory by unloading tabs you haven't viewed for a while. An unloaded tab reloads when you click it; pinned and active tabs are never unloaded."
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
						description="Each tab can connect to a different node independently."
						title="Per-tab node override"
					/>
				</SettingsGroup>
			</SettingsSection>

			{/* Split-view layout presets: captured from the split's own context
			    menu, renamed or deleted here. */}
			<SplitPresetSettings />
		</>
	);

	const chatsPage = (
		<>
			<SettingsSection
				caption="How Ryu shows your agents' own chat history."
				title="Chats"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={autoImportThreads}
								id="auto-import-threads-toggle"
								onCheckedChange={setAutoImportThreads}
							/>
						}
						description="Automatically import threads from your agents' own on-disk history (Claude Code, Codex…) into Ryu and keep them in sync. New threads appear on their own, each filed under the project folder it ran in. Ryu rescans on launch, on a timer, and when the window regains focus. You can always import manually from the Chats section or the launchpad."
						title="Auto-import agent threads"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={autoImportSetup}
								id="auto-import-setup-toggle"
								onCheckedChange={setAutoImportSetup}
							/>
						}
						description="Automatically import agent setup instructions (AGENTS.md / CLAUDE.md) from your Claude Code, Cursor, and Codex config folders, so imported projects stay in sync. Only instructions are auto-imported — skills, MCP servers, and plugins are always imported explicitly from the Import setup dialog."
						title="Auto-import agent setup"
					/>
					<SettingsItem
						actions={
							<Select
								items={COMPOSER_SEND_SHORTCUT_OPTIONS}
								onValueChange={(value) => {
									if (
										value === "enter" ||
										value === "shift-enter" ||
										value === "command-enter"
									) {
										setComposerSendShortcut(value);
									}
								}}
								value={composerSendShortcut}
							>
								<SelectTrigger
									className="h-8 w-56 flex-shrink-0 text-sm"
									id="composer-send-shortcut-select"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{COMPOSER_SEND_SHORTCUT_OPTIONS.map((option) => (
										<SelectItem
											key={option.value}
											value={option.value satisfies ComposerSendShortcut}
										>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Choose which key sends a prompt from the chat composer."
						title="Send shortcut"
					/>
					<SettingsItem
						actions={
							<Select
								items={QUEUE_DRAIN_OPTIONS}
								onValueChange={(v) => setQueueDrainMode(v as QueueDrainMode)}
								value={queueDrainMode}
							>
								<SelectTrigger
									className="h-8 w-56 flex-shrink-0 text-sm"
									id="queue-drain-mode-select"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{QUEUE_DRAIN_OPTIONS.map((opt) => (
										<SelectItem key={opt.value} value={opt.value}>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="When you send messages while an agent is still replying, they wait in a queue. Auto delivers all pending messages together at the next safe turn boundary, like Claude Code; the other choices let you choose oldest-first, latest-first, or send-all behavior explicitly."
						title="Queued messages send"
					/>
					<SettingsItem
						actions={
							<Select
								items={COMPOSER_SELECTION_APPLY_OPTIONS}
								onValueChange={(value) => {
									if (value === "next-turn" || value === "next-user-message") {
										setComposerSelectionApplyModeSetting(value);
									}
								}}
								value={composerSelectionApplyMode}
							>
								<SelectTrigger
									className="h-8 w-56 flex-shrink-0 text-sm"
									id="composer-selection-apply-mode-select"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{COMPOSER_SELECTION_APPLY_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Choose when changes to the composer’s agent, model, and effort controls take effect. The confirmation toast only appears while an agent is working."
						title="Composer selection changes"
					/>
				</SettingsGroup>
			</SettingsSection>
		</>
	);

	const terminalPage = (
		<>
			<SettingsSection
				caption="How the built-in terminal and git actions run commands."
				title="Terminal"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Select
								items={TERMINAL_SHELL_OPTIONS}
								onValueChange={(value) => {
									if (value) {
										setTerminalShell(value);
									}
								}}
								value={terminalShell}
							>
								<SelectTrigger
									className="h-8 w-56 flex-shrink-0 text-sm"
									id="terminal-shell-select"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{TERMINAL_SHELL_OPTIONS.map((opt) => (
										<SelectItem key={opt.value} value={opt.value}>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="Which shell the built-in terminal and git actions use. OS default follows the platform shell (PowerShell on Windows, Zsh on macOS, and the user's configured Unix shell when available)."
						title="Default shell"
					/>
				</SettingsGroup>
			</SettingsSection>
		</>
	);

	const filesPage = (
		<SettingsSection
			caption="How the workspace file tree opens files and folders."
			title="Files"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Select
							items={DEFAULT_FILE_OPENER_OPTIONS}
							onValueChange={(value) => {
								if (
									value === "system" ||
									value === "vscode" ||
									value === "cursor" ||
									value === "zed"
								) {
									setDefaultFileOpener(value);
								}
							}}
							value={defaultFileOpener}
						>
							<SelectTrigger
								className="h-8 w-56 flex-shrink-0 text-sm"
								id="default-file-opener-select"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{DEFAULT_FILE_OPENER_OPTIONS.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					description={`Choose what the file tree's Open action uses. ${FILE_MANAGER_NAME} is used for the OS default, or choose an installed editor for files and folders.`}
					title="Default file opener"
				/>
			</SettingsGroup>
		</SettingsSection>
	);

	const systemPage = (
		<>
			<SettingsSection
				caption="How Ryu appears in the system tray and runs in the background."
				title="System"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={launchAtLogin}
								id="launch-at-login-toggle"
								onCheckedChange={handleLaunchAtLogin}
							/>
						}
						description="Start Ryu automatically when you sign in to your device, so your agents and background work are ready without opening it yourself. Works on macOS, Windows, and Linux."
						title="Start Ryu on startup"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={startHidden}
								disabled={!launchAtLogin}
								id="start-hidden-toggle"
								onCheckedChange={handleStartHidden}
							/>
						}
						description="When Ryu starts at login, run it in the background with no window on screen. Open it later from the tray icon, the dock or taskbar, or its global shortcut. Launching Ryu yourself always opens the window."
						title="Start hidden"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={closeToTray && !hideTrayIcon}
								disabled={hideTrayIcon}
								id="close-to-tray-toggle"
								onCheckedChange={handleCloseToTray}
							/>
						}
						description="Closing the window leaves Ryu running in the tray instead of quitting, so background agents and running turns keep going. Quit from the tray menu to stop it completely. Ignored while the tray icon is hidden, since that would leave no way back to the window."
						title="Stay in tray on close"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={hideTrayIcon}
								id="hide-tray-icon-toggle"
								onCheckedChange={handleHideTrayIcon}
							/>
						}
						description="Remove the Ryu icon from the system tray (the menu bar on macOS). Ryu keeps running in the background and you can still open it from the taskbar, dock, or its global shortcut."
						title="Hide tray icon"
					/>
				</SettingsGroup>
			</SettingsSection>
		</>
	);

	const setupPage = (
		<>
			<SettingsSection title="Setup">
				<SettingsGroup>
					<SettingsItem
						actions={
							<Button onClick={resetOnboarding} size="sm" variant="ghost">
								Reset onboarding
							</Button>
						}
						description="Restart the first-run setup flow. This also clears your saved theme, typography, and layout preferences."
						title="Onboarding"
					/>
				</SettingsGroup>
			</SettingsSection>

			{/* Last, and node-scoped rather than app-scoped: everything above is a
			    preference about this window, while Safe Mode changes what the node
			    itself loads on its next boot. */}
			<SafeModeSettings />
		</>
	);

	return (
		<SettingsSubpages
			backLabel="General"
			intro={startupIntro}
			label="Settings"
			pages={[
				{
					id: "tabs",
					title: "Tabs & panes",
					hint: "How open tabs look and behave, and the split-pane presets.",
					icon: LayoutTable01Icon,
					tint: "blue",
					content: tabsPage,
				},
				{
					id: "chats",
					title: "Chats",
					hint: "How Ryu shows your agents' own chat history.",
					icon: Chat01Icon,
					tint: "teal",
					content: chatsPage,
				},
				...(canUseNativeShell
					? [
							{
								id: "terminal",
								title: "Terminal",
								hint: "How the built-in terminal and git actions run commands.",
								icon: CommandLineIcon,
								tint: "gray" as const,
								content: terminalPage,
							},
							{
								id: "files",
								title: "Files",
								hint: "How the workspace file tree opens files and folders.",
								icon: FolderOpenIcon,
								tint: "purple" as const,
								content: filesPage,
							},
						]
					: []),
				...(canManageDesktopLifecycle
					? [
							{
								id: "system",
								title: "System & tray",
								hint: "How Ryu appears in the system tray and runs in the background.",
								icon: ComputerIcon,
								tint: "indigo" as const,
								content: systemPage,
							},
						]
					: []),
				{
					id: "setup",
					title: "Setup & recovery",
					hint: "Re-run onboarding, or start Ryu in safe mode.",
					icon: Rocket01Icon,
					tint: "orange",
					content: setupPage,
				},
			]}
			revealPageId={pendingSubpage}
		/>
	);
}
