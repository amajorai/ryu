import {
	Chat01Icon,
	CommandLineIcon,
	ComputerIcon,
	FolderOpenIcon,
	Globe02Icon,
	LayoutTable01Icon,
	Rocket01Icon,
} from "@hugeicons/core-free-icons";
import { SettingsSubpages } from "@ryu/blocks/desktop/settings-nav.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { useNavigate } from "react-router-dom";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import { usePendingSubpage } from "@/src/hooks/useSettingSubpage.ts";
import { resetDesktopOnboarding } from "@/src/lib/desktop-onboarding-state.ts";
import { STORAGE_KEYS } from "@/src/lib/themes/presets.ts";
import { GeneralTabChatsPage } from "./GeneralTab-chats-page.tsx";
import { GeneralTabStartupIntro } from "./GeneralTab-startup-intro.tsx";
import {
	GeneralTabSystemPage,
	useGeneralTabSystemControls,
} from "./GeneralTab-system-page.tsx";
import { GeneralTabTabsPage } from "./GeneralTab-tabs-page.tsx";
import {
	GeneralTabFilesPage,
	GeneralTabTerminalPage,
} from "./GeneralTab-terminal-files-pages.tsx";
import { LanguageSettings } from "./LanguageSettings.tsx";
import { OpenSourceLicensesSettings } from "./OpenSourceLicensesSettings.tsx";
import { SafeModeSettings } from "./SafeModeSettings.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

export function GeneralTab() {
	const { canManageDesktopLifecycle, canUseNativeShell } = useAppSurface();
	// Which sub-page a settings-search hit lives on, so the reveal has something
	// to find — a row on a closed page is not in the DOM.
	const pendingSubpage = usePendingSubpage("general");
	const navigate = useNavigate();
	const systemControls = useGeneralTabSystemControls(canManageDesktopLifecycle);

	const resetOnboarding = () => {
		resetDesktopOnboarding();
		for (const key of [
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
	// Seven groups covering startup, tabs, chats, language, terminal, file opening,
	// tray behaviour and setup — unrelated topics that shared one scroll. Split the
	// way iOS/macOS General
	// is: an index of topics, one page each. "On startup" stays on the index
	// because it is the question people open this pane to answer.
	//
	// Bodies are the same nodes as before, moved verbatim. Adding a group here
	// means adding it to `SUBPAGE_BY_GROUP` in `settings-index.ts` too, or
	// settings search will land on this pane and highlight nothing.
	const setupPage = (
		<>
			<SettingsSection title="Setup">
				<SettingsGroup>
					<SettingsItem
						actions={
							<Button onClick={resetOnboarding} size="sm" variant="outline">
								Reset onboarding
							</Button>
						}
						description="Re-run first-run setup. Also resets theme, typography and layout."
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
			intro={<GeneralTabStartupIntro />}
			label="Settings"
			outro={<OpenSourceLicensesSettings />}
			pages={[
				{
					id: "tabs",
					title: "Tabs & panes",
					hint: "Tab behaviour, layout and split presets.",
					icon: LayoutTable01Icon,
					content: <GeneralTabTabsPage />,
				},
				{
					id: "chats",
					title: "Chats",
					hint: "Availability, imports and the composer.",
					icon: Chat01Icon,
					content: <GeneralTabChatsPage />,
				},
				{
					id: "language",
					title: "Language",
					hint: "The interface language.",
					icon: Globe02Icon,
					content: <LanguageSettings settingsId="general.language" />,
				},
				...(canUseNativeShell
					? [
							{
								id: "terminal",
								title: "Terminal",
								hint: "Where terminals open and which shell runs.",
								icon: CommandLineIcon,
								content: <GeneralTabTerminalPage />,
							},
							{
								id: "files",
								title: "Files",
								hint: "How the file tree opens files.",
								icon: FolderOpenIcon,
								content: <GeneralTabFilesPage />,
							},
						]
					: []),
				...(canManageDesktopLifecycle
					? [
							{
								id: "system",
								title: "System & tray",
								hint: "Login, tray and background behaviour.",
								icon: ComputerIcon,
								content: <GeneralTabSystemPage controls={systemControls} />,
							},
						]
					: []),
				{
					id: "setup",
					title: "Setup & recovery",
					hint: "Re-run onboarding or start in safe mode.",
					icon: Rocket01Icon,
					content: setupPage,
				},
			]}
			revealPageId={pendingSubpage}
		/>
	);
}
