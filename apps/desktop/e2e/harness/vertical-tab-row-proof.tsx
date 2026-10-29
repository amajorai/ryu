import { I18nProvider } from "@ryu/i18n/react";
import {
	Sidebar,
	SidebarContent,
	SidebarProvider,
} from "@ryu/ui/components/sidebar.tsx";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { TabsSection } from "../../src/components/layout/sidebar-tabs-section.tsx";
import { TabDndProvider } from "../../src/components/layout/tabDnd.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import {
	TabsProvider,
	useTabsContext,
} from "../../src/contexts/TabsContext.tsx";
import { type TabLayout, useTabLayout } from "../../src/hooks/useTabLayout.ts";
import { EntitlementProvider } from "./vertical-tab-row-entitlement.mock.tsx";
import {
	initializeVerticalTabFixture,
	type VerticalTabProofState,
} from "./vertical-tab-row-tauri.mock.ts";
import "../../src/index.css";
import {
	IDLE_REORDER_SHIFT,
	type ReorderShift,
} from "@ryu/ui/hooks/use-reorder-shift.tsx";

interface SectionDndFixture {
	draggingKey: string | null;
	dragOverKey: string | null;
	onDragEnd: () => void;
	onDragOver: (key: string) => void;
	onDragStart: (key: string) => void;
	onDrop: (key: string) => void;
	order: string[];
	shift: ReorderShift;
}

interface SectionMenuFixture {
	canMove: (key: string, direction: "up" | "down") => boolean;
	onHide: (key: string) => void;
	onMove: (key: string, direction: "up" | "down") => void;
	onOpenCustomize: () => void;
	onSetPageSize: (key: string, size: number) => void;
	onSetSort: (
		key: string,
		sort: "default" | "updated" | "created" | "name-asc" | "name-desc"
	) => void;
}

export interface TabsSectionFixtureProps {
	collapsed: boolean;
	dnd: SectionDndFixture;
	menu: SectionMenuFixture;
	onToggleCollapsed: (key: string) => void;
	pageSize: number;
	sort: "default" | "updated" | "created" | "name-asc" | "name-desc";
}

export interface VerticalTabSnapshot {
	activeTabId: string;
	layout: TabLayout;
	splits: Array<{ id: string; tabIds: string[] }>;
	tabs: Array<{
		conversationId: string | null;
		id: string;
		path: string;
		pinned: boolean;
		splitId: string | null;
		title: string;
		unloaded: boolean;
	}>;
}

declare global {
	interface Window {
		__READ_VERTICAL_TAB_STATE__?: () => VerticalTabSnapshot;
		__VERTICAL_TAB_PROOF__?: VerticalTabProofState;
	}
}

const dnd: SectionDndFixture = {
	draggingKey: null,
	dragOverKey: null,
	onDragEnd: () => undefined,
	onDragOver: () => undefined,
	onDragStart: () => undefined,
	onDrop: () => undefined,
	shift: IDLE_REORDER_SHIFT,
	order: ["tabs"],
};

const menu: SectionMenuFixture = {
	canMove: () => false,
	onHide: () => undefined,
	onMove: () => undefined,
	onOpenCustomize: () => undefined,
	onSetPageSize: () => undefined,
	onSetSort: () => undefined,
};

function VerticalTabsSurface() {
	const state = useTabsContext();
	const layout = useTabLayout();

	const readState = () => {
		const tabs = state.tabs.map((tab) => ({
			conversationId: tab.conversationId ?? null,
			id: tab.id,
			path: tab.path,
			pinned: Boolean(tab.pinned),
			splitId: tab.splitId ?? null,
			title: tab.title,
			unloaded: Boolean(tab.unloaded),
		}));
		return {
			activeTabId: state.activeTabId,
			layout,
			splits: state.splits.map((split) => ({
				id: split.id,
				tabIds: tabs
					.filter((tab) => tab.splitId === split.id)
					.map((tab) => tab.id),
			})),
			tabs,
		};
	};
	window.__READ_VERTICAL_TAB_STATE__ = readState;

	return (
		<SidebarProvider>
			<Sidebar className="h-[680px]" collapsible="none">
				<SidebarContent spacing="flush">
					<div className="border-b px-3 py-4">
						<h1 className="font-semibold text-sm">Tabs</h1>
						<p className="mt-1 text-muted-foreground text-xs">
							Production AppSidebar tabs section with isolated conversation,
							native-window, and session fixtures.
						</p>
						<output className="sr-only" data-testid="tab-layout">
							{layout}
						</output>
					</div>
					{layout === "vertical" ? (
						<TabsSection
							collapsed={false}
							dnd={dnd}
							menu={menu}
							onToggleCollapsed={() => undefined}
							pageSize={50}
							sort="default"
						/>
					) : (
						<p
							className="p-3 text-muted-foreground text-xs"
							data-testid="vertical-tabs-hidden"
						>
							The vertical rows are hidden while {layout} tabs are selected.
						</p>
					)}
				</SidebarContent>
			</Sidebar>
		</SidebarProvider>
	);
}

function ProofSurface() {
	return (
		<EntitlementProvider>
			<I18nProvider>
				<ThemeProvider
					attribute="class"
					defaultTheme="dark"
					enableSystem={false}
				>
					<TabsProvider>
						<TabDndProvider>
							<AppSurfaceProvider surface="desktop">
								<VerticalTabsSurface />
							</AppSurfaceProvider>
						</TabDndProvider>
					</TabsProvider>
				</ThemeProvider>
			</I18nProvider>
		</EntitlementProvider>
	);
}

const params = new URLSearchParams(window.location.search);
const bootstrap = params.get("seed") === "true";
initializeVerticalTabFixture();
if (bootstrap) {
	localStorage.clear();
	localStorage.setItem("ryu_startup_behavior", "restore");
	localStorage.setItem("ryu_tab_layout", params.get("layout") ?? "vertical");
	localStorage.setItem(
		"ryu_session_tabs",
		JSON.stringify({
			activeIndex: 0,
			tabs: [
				{
					conversationId: "conversation-alpha",
					path: "/chat",
					title: "Alpha conversation",
				},
				{
					conversationId: "conversation-beta",
					path: "/chat",
					title: "Beta conversation",
				},
			],
		})
	);
	params.delete("seed");
	params.delete("layout");
	window.history.replaceState(
		null,
		"",
		`${window.location.pathname}${params.size > 0 ? `?${params}` : ""}`
	);
}

document.documentElement.classList.add("dark");
const rootElement = document.getElementById("root");
if (!rootElement) {
	throw new Error("Missing root element");
}
createRoot(rootElement).render(<ProofSurface />);
