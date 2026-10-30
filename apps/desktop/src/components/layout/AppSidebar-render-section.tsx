import type { Dispatch, SetStateAction } from "react";
import type { useApps } from "@/src/hooks/useApps.ts";
import type { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import type { useTabLayout } from "@/src/hooks/useTabLayout.ts";
import type { Conversation } from "@/types/chat.ts";
import { AgentsSection } from "./sidebar-agents-section.tsx";
import {
	type ChatSectionViews,
	DEFAULT_CHAT_SECTION_VIEW,
} from "./sidebar-chat-view.ts";
import { ChatsSection } from "./sidebar-chats-section.tsx";
import {
	ChannelsSection,
	IntegrationsSection,
} from "./sidebar-connection-sections.tsx";
import type { ProjectBucket } from "./sidebar-conversation-list.tsx";
import type { ChatRowHandlers } from "./sidebar-conversation-rows.tsx";
import { DynamicSidebarSection } from "./sidebar-dynamic-section.tsx";
import {
	EnginesSection,
	PinnedSection,
} from "./sidebar-engines-pinned-sections.tsx";
import { AppsSection, PluginsSection } from "./sidebar-extension-sections.tsx";
import {
	IdentitiesSection,
	SkillsSection,
} from "./sidebar-identity-skill-sections.tsx";
import type { SidebarModeDescriptor } from "./sidebar-modes.ts";
import { SECTION_PLUGIN_OWNER } from "./sidebar-panel-state.tsx";
import {
	ArchivedSection,
	ProjectsSection,
} from "./sidebar-projects-section.tsx";
import { DEFAULT_PAGE_SIZE } from "./sidebar-scope-picker.tsx";
import type {
	SectionDnd,
	SectionMenu,
	SectionProps,
} from "./sidebar-section.tsx";
import {
	isDynamicSectionKey,
	SECTION_ICONS,
	type SectionKey,
} from "./sidebar-sections.ts";
import {
	CHAT_VIEW_SECTIONS,
	DEFAULT_SORT,
	type SortKey,
} from "./sidebar-sort-paging.ts";
import { SpacesSection } from "./sidebar-spaces-section.tsx";
import { TabsSection } from "./sidebar-tabs-section.tsx";
import { McpSection, ToolsSection } from "./sidebar-tool-sections.tsx";

/** Everything one sidebar section needs from the panel to render. */
export interface SidebarSectionRenderContext {
	activeMode: SidebarModeDescriptor;
	agentModeOtherChats: Conversation[];
	archived: Conversation[];
	botProduct: boolean;
	chatRowHandlers: ChatRowHandlers;
	chatSectionViews: ChatSectionViews;
	collapsedSections: Set<string>;
	contributedSections: ReturnType<
		typeof usePluginContributions
	>["sidebar_sections"];
	handleNewConversation: () => void;
	handleToggleSection: (key: SectionKey) => void;
	hiddenSections: Set<string>;
	onOpenQuickPreview?: (id: string) => void;
	onOpenQuickReply?: (id: string) => void;
	pinned: Conversation[];
	pluginApps: ReturnType<typeof useApps>["apps"];
	projectList: ProjectBucket[];
	rest: Conversation[];
	sectionDnd: SectionDnd;
	sectionMenu: SectionMenu;
	sectionPageSizes: Partial<Record<SectionKey, number>>;
	sectionSorts: Partial<Record<SectionKey, SortKey>>;
	setImportOpen: Dispatch<SetStateAction<boolean>>;
	setSetupImportOpen: Dispatch<SetStateAction<boolean>>;
	tabLayout: ReturnType<typeof useTabLayout>;
}

/** One sidebar section by key, or null when it is hidden or has no owner. */
export function renderSidebarSection(
	key: SectionKey,
	forceExpanded: boolean,
	{
		activeMode,
		agentModeOtherChats,
		archived,
		botProduct,
		chatRowHandlers,
		chatSectionViews,
		collapsedSections,
		contributedSections,
		handleNewConversation,
		handleToggleSection,
		hiddenSections,
		onOpenQuickPreview,
		onOpenQuickReply,
		pinned,
		pluginApps,
		projectList,
		rest,
		sectionDnd,
		sectionMenu,
		sectionPageSizes,
		sectionSorts,
		setImportOpen,
		setSetupImportOpen,
		tabLayout,
	}: SidebarSectionRenderContext
) {
	if (hiddenSections.has(key)) {
		return null;
	}
	// A plugin-owned section shows ONLY when its App is installed AND enabled.
	// Once the plugin list has loaded (`pluginApps` non-empty), an owner that is
	// absent (not installed — the not pre-installed apps) or disabled hides the section,
	// so Canvas/Whiteboard/Meetings don't render until their app is turned on.
	// While the list is still loading (empty) we show it, to never flicker a
	// working section away on a slow/failed /api/plugins fetch.
	const ownerPluginId = Object.entries(SECTION_PLUGIN_OWNER).find(
		([ownerKey]) => ownerKey === key
	)?.[1];
	if (ownerPluginId && pluginApps.length > 0) {
		const owner = pluginApps.find((a) => a.id === ownerPluginId);
		if (!owner?.enabled) {
			return null;
		}
	}
	const sectionProps: SectionProps = {
		chatView: CHAT_VIEW_SECTIONS.has(key)
			? (chatSectionViews[key] ?? DEFAULT_CHAT_SECTION_VIEW)
			: undefined,
		// In tabbed mode the selected section is always shown expanded — the bar,
		// not a collapse toggle, decides what's visible.
		collapsed: botProduct
			? false
			: forceExpanded
				? false
				: collapsedSections.has(key),
		dnd: sectionDnd,
		icon: isDynamicSectionKey(key) ? undefined : SECTION_ICONS[key],
		menu: sectionMenu,
		onOpenQuickPreview,
		onOpenQuickReply,
		pageSize: sectionPageSizes[key] ?? DEFAULT_PAGE_SIZE,
		sort: sectionSorts[key] ?? DEFAULT_SORT,
		onToggleCollapsed: handleToggleSection,
	};
	switch (key) {
		case "tabs":
			// The sidebar tab list only exists in vertical layout; every other view
			// owns its live tabs somewhere in the title bar or center pane.
			return tabLayout === "vertical" ? (
				<TabsSection key={key} {...sectionProps} />
			) : null;
		case "agents":
			return <AgentsSection key={key} {...sectionProps} />;
		case "spaces":
			return <SpacesSection key={key} {...sectionProps} />;
		// "meetings" is app-registered (@ryu/meetings `sidebar_sections`),
		// rendered via DynamicSidebarSection — no hardcoded case.
		case "channels":
			return <ChannelsSection key={key} {...sectionProps} />;
		case "integrations":
			return <IntegrationsSection key={key} {...sectionProps} />;
		case "identities":
			return <IdentitiesSection key={key} {...sectionProps} />;
		case "skills":
			return <SkillsSection key={key} {...sectionProps} />;
		case "mcp":
			return <McpSection key={key} {...sectionProps} />;
		case "tools":
			return <ToolsSection key={key} {...sectionProps} />;
		case "plugins":
			return <PluginsSection key={key} {...sectionProps} />;
		case "companions":
			return <AppsSection apps={pluginApps} key={key} {...sectionProps} />;
		case "engines":
			return <EnginesSection key={key} {...sectionProps} />;
		case "pinned":
			return (
				<PinnedSection
					key={key}
					{...sectionProps}
					handlers={chatRowHandlers}
					pinned={pinned}
				/>
			);
		case "projects":
			return (
				<ProjectsSection
					key={key}
					{...sectionProps}
					handlers={chatRowHandlers}
					projects={projectList}
				/>
			);
		case "chats":
			return (
				<ChatsSection
					botMode={botProduct || activeMode.key === "agent"}
					key={key}
					{...sectionProps}
					handlers={chatRowHandlers}
					loose={agentModeOtherChats}
					managedProduct={botProduct}
					onImport={botProduct ? undefined : () => setImportOpen(true)}
					onImportSetup={
						botProduct ? undefined : () => setSetupImportOpen(true)
					}
					onNew={handleNewConversation}
					sectionLabel={
						activeMode.key === "agent" ? "Projects & chats" : undefined
					}
					sessionSource={botProduct ? undefined : rest}
				/>
			);
		// canvas + whiteboard are app-registered (com.ryu.{canvas,whiteboard}
		// `sidebar_sections`, backed by /api/apps/<id>/docs), rendered via
		// DynamicSidebarSection — no hardcoded cases.
		case "archived":
			return (
				<ArchivedSection
					archived={archived}
					key={key}
					{...sectionProps}
					handlers={chatRowHandlers}
				/>
			);
		default: {
			// App-registered dynamic section (`plugin:<pluginId>:<sectionId>`):
			// resolve the contribution from the feed and render it generically.
			if (isDynamicSectionKey(key)) {
				const contribution = contributedSections.find(
					(s) => `plugin:${s.plugin}:${s.id}` === key
				);
				return contribution ? (
					<DynamicSidebarSection
						contribution={contribution}
						key={key}
						{...sectionProps}
					/>
				) : null;
			}
			return null;
		}
	}
}
