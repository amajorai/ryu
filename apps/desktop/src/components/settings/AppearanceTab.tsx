import {
	ChartLineData01Icon,
	Chat01Icon,
	DashboardSquare01Icon,
	Delete02Icon,
	Folder01Icon,
	GitCompareIcon,
	Layers01Icon,
	SparklesIcon,
	TextFontIcon,
} from "@hugeicons/core-free-icons";
import { SettingsSubpages } from "@ryu/blocks/desktop/settings-nav.tsx";
import {
	AppearanceChatPage,
	AppearanceResetPage,
	AppearanceUsagePage,
} from "./appearance-chat-page.tsx";
import { AppearanceDiffPage } from "./appearance-diff-page.tsx";
import { AppearanceFilesPage } from "./appearance-files-page.tsx";
import { AppearanceInterfacePage } from "./appearance-interface-page.tsx";
import {
	AppearanceLayoutPage,
	AppearanceMotionPage,
} from "./appearance-layout-page.tsx";
import { useAppearancePrefs } from "./appearance-prefs-state.ts";
import type { AppearanceTabState } from "./appearance-tab-state.ts";
import { AppearanceThemeIntro } from "./appearance-theme-intro.tsx";
import { useAppearanceThemeState } from "./appearance-theme-state.ts";
import { InterfaceSettingsPanel } from "./InterfaceSettingsPanel.tsx";
import { LanguageSettings } from "./LanguageSettings.tsx";

export function AppearanceTab() {
	const prefs = useAppearancePrefs();
	const themeState = useAppearanceThemeState();
	const state: AppearanceTabState = { ...prefs, ...themeState };
	const { pendingSubpage, showInterfaces } = state;

	// ── Sub-pages ────────────────────────────────────────────────────────────
	// Appearance is the longest pane in the app: eleven groups and ~1,200 lines
	// of controls in a single scroll, where finding "line numbers" meant knowing
	// it was a diff-viewer setting and then scrolling past ninety others. The
	// Apple answer to a pane this size is not a longer scroll — it is a short
	// index that pushes one page per topic, so that is what this is.
	//
	// Theme and colour stay on the index rather than behind a row: they are what
	// this pane is FOR, and a settings pane whose headline setting is one click
	// away has organised itself at the user's expense.
	//
	// The bodies below are the same nodes as before, moved verbatim. If you add a
	// group, add it here AND to `APPEARANCE_SUBPAGE_BY_GROUP` in
	// `settings-index.ts` — that map is what lets settings search reveal a row
	// that is currently behind a closed page.
	const themeIntro = <AppearanceThemeIntro state={state} />;
	const layoutPage = <AppearanceLayoutPage state={state} />;
	const motionPage = <AppearanceMotionPage state={state} />;
	const interfacePage = <AppearanceInterfacePage state={state} />;
	const chatPage = <AppearanceChatPage state={state} />;
	const usagePage = <AppearanceUsagePage state={state} />;
	const diffPage = <AppearanceDiffPage state={state} />;
	const filesPage = <AppearanceFilesPage state={state} />;
	const resetPage = <AppearanceResetPage state={state} />;

	return (
		<SettingsSubpages
			backLabel="Appearance"
			intro={themeIntro}
			label="Customize"
			pages={[
				{
					id: "language",
					title: "Language & vibe",
					hint: "Interface language and community voice packs.",
					icon: TextFontIcon,
					content: <LanguageSettings />,
				},
				{
					id: "layout",
					title: "Layout & text",
					hint: "Density, widths and interface fonts.",
					icon: TextFontIcon,
					content: layoutPage,
				},
				{
					id: "motion",
					title: "Motion & effects",
					hint: "Animation and seasonal extras.",
					icon: SparklesIcon,
					content: motionPage,
				},
				{
					id: "interface",
					title: "Interface",
					hint: "Sidebar, cursor, shadows and list grouping.",
					icon: DashboardSquare01Icon,
					content: interfacePage,
				},
				{
					id: "chat",
					title: "Chat view",
					hint: "How much detail a running chat shows.",
					icon: Chat01Icon,
					content: chatPage,
				},
				...(showInterfaces
					? [
							{
								id: "interfaces",
								title: "Interfaces",
								hint: "Per-interface and shared options.",
								icon: Layers01Icon,
								content: <InterfaceSettingsPanel />,
							},
						]
					: []),
				{
					id: "usage",
					title: "Usage meter",
					hint: "Whether and how the spend meter shows.",
					icon: ChartLineData01Icon,
					content: usagePage,
				},
				{
					id: "diff",
					title: "Diff viewer",
					hint: "Layout, themes and change markers.",
					icon: GitCompareIcon,
					content: diffPage,
				},
				{
					id: "files",
					title: "File tree",
					hint: "File browser density, icons and behaviour.",
					icon: Folder01Icon,
					content: filesPage,
				},
				{
					id: "reset",
					title: "Reset",
					hint: "Restore every appearance default.",
					icon: Delete02Icon,
					content: resetPage,
				},
			]}
			revealPageId={pendingSubpage}
		/>
	);
}
