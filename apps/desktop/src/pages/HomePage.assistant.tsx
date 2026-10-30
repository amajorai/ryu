import {
	ArrowDown01Icon,
	Delete02Icon,
	FrameIcon,
	GridViewIcon,
	PencilEdit01Icon,
	PlusSignIcon,
	SparklesIcon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import { useEffect, useMemo, useRef } from "react";
import { WIDGET_DEFINITIONS } from "@/src/components/dashboard/widgets/registry.tsx";
import { useIsActiveTab } from "@/src/contexts/TabsContext.tsx";
import { useTitleBar } from "@/src/contexts/TitleBarContext.tsx";
import { useAssistantSurface } from "@/src/hooks/useAssistantBuilder.ts";
import { useAssistantPageContext } from "@/src/hooks/useAssistantPageContext.ts";
import { useAssistantStore } from "@/src/store/useAssistantStore.ts";
import type { useHomeDashboardActions } from "./HomePage.dashboards.ts";
import type { useHomeDashboardData } from "./HomePage.data.ts";
import {
	AI_STARTER_PROMPT,
	dashboardSnapshot,
	presetsFor,
} from "./HomePage.presets.ts";
import type { useHomeWidgetActions } from "./HomePage.widgets.ts";

type HomeAssistantSurfaceInput = Pick<
	ReturnType<typeof useHomeDashboardData>,
	| "builderOpen"
	| "dashboardId"
	| "dashboardName"
	| "dashboards"
	| "reload"
	| "setAddOpen"
	| "setBuilderOpen"
	| "setConfirmDeleteOpen"
	| "setGenerating"
	| "setNameDialog"
	| "sourceTypes"
	| "viewMode"
	| "widgets"
> &
	Pick<
		ReturnType<typeof useHomeDashboardActions>,
		| "handleCreateWidget"
		| "handleSelectDashboard"
		| "resolveDashboardId"
		| "setStarterPending"
		| "starterPending"
	> &
	Pick<ReturnType<typeof useHomeWidgetActions>, "handleSetViewMode">;

/** Assistant surface and page context, builder auto-open, and title bar actions. */
export function useHomeAssistantSurface({
	builderOpen,
	dashboardId,
	dashboardName,
	dashboards,
	handleCreateWidget,
	handleSelectDashboard,
	handleSetViewMode,
	reload,
	resolveDashboardId,
	setAddOpen,
	setBuilderOpen,
	setConfirmDeleteOpen,
	setGenerating,
	setNameDialog,
	setStarterPending,
	sourceTypes,
	starterPending,
	viewMode,
	widgets,
}: HomeAssistantSurfaceInput) {
	// Live handle on the widgets for the assistant's send-time context resolver —
	// a dashboard refreshes itself, so the resolver must read the CURRENT board,
	// not the one captured when the effect published.
	const widgetsRef = useRef(widgets);
	widgetsRef.current = widgets;
	const snapshot = useMemo(() => dashboardSnapshot(widgets), [widgets]);
	// ── The dashboard as an assistant surface ────────────────────────────────
	// "Build with AI" is the global Ask Ryu assistant docked as this dashboard's
	// builder — `dashboard_builder.*` tools, live board as page context — not a chat pane of
	// Home's own. It registers only while `builderOpen`, because a takeover
	// replaces the generic assistant, and merely *looking at* Home is not a
	// request to give up general chat. Choosing "Build" is an explicit request, so
	// the surface docks the panel open (the default for builder pages).
	const widgetKinds = useMemo(
		() => WIDGET_DEFINITIONS.map((d) => d.kind).join(", "),
		[]
	);
	const quickAddPresets = useMemo(() => presetsFor(sourceTypes), [sourceTypes]);
	useAssistantSurface(
		builderOpen
			? {
					kind: "dashboard",
					label: `Build ${dashboardName}`,
					description:
						"Say what you want to see and I'll assemble the widgets on this board.",
					preamble: [
						"You are Ryu's Home dashboard builder. You are helping the user assemble",
						'the dashboard with id "{{targetId}}". A dashboard is a grid of widgets,',
						`each with a kind (${widgetKinds}), a data source, and a grid layout.`,
						"When the user describes what they want to see, BUILD it by calling the",
						"dashboard_builder tools. For edits prefer",
						'dashboard_builder.configure_dashboard with dashboard_id "{{targetId}}"',
						"using widgets_upsert (pass each widget's layout x/y/w/h to place it on",
						"the 12-column grid) and widgets_remove. Pick a sensible source from",
						`the types this node supports: ${sourceTypes.join(", ")}. Never use`,
						"any other source type. If a save is rejected, read the error and fix",
						"it. Call",
						"dashboard_builder.get_dashboard when you need the current widgets.",
						"Keep replies short and confirm what you changed.",
					].join(" "),
					tools: [
						"dashboard_builder.configure_dashboard",
						"dashboard_builder.get_dashboard",
					],
					prompts: [
						"Chart a public JSON API",
						"Show my unread email",
						"Tidy the layout",
					],
					// The live board travels as the removable page context below.
					snapshot: "",
					targetId: dashboardId,
					targetName: dashboardName,
					// One conversation per board, so switching dashboards never
					// carries the previous board's turns into this one's edits.
					thread: dashboardId ? `dashboard:${dashboardId}` : undefined,
					resolveId: resolveDashboardId,
					onChanged: (id) => {
						void reload(id).then(() => setGenerating(false));
					},
				}
			: null
	);
	const activeSurfaceKind = useAssistantStore((s) => s.builder?.kind);
	useEffect(() => {
		if (starterPending && activeSurfaceKind === "dashboard") {
			setStarterPending(false);
			useAssistantStore.getState().setPendingPrompt(AI_STARTER_PROMPT);
		}
	}, [starterPending, activeSurfaceKind]);
	// Closing the assistant ends build mode, so the surface is released and the
	// assistant goes back to general chat. Only while Home is focused: leaving
	// the tab also tears the takeover down, and coming back should resume it.
	const isActiveTab = useIsActiveTab();
	const assistantMode = useAssistantStore((s) => s.mode);
	const builderShownRef = useRef(false);
	useEffect(() => {
		if (!(builderOpen && isActiveTab)) {
			builderShownRef.current = false;
			return;
		}
		if (assistantMode !== "closed") {
			builderShownRef.current = true;
			return;
		}
		if (builderShownRef.current) {
			builderShownRef.current = false;
			setBuilderOpen(false);
			setGenerating(false);
		}
	}, [builderOpen, isActiveTab, assistantMode]);
	// …and the same board as plain CONTEXT, resolved at send time. A dashboard's
	// widgets refresh on their own, so a snapshot pushed at mount would describe a
	// board that no longer exists by the time the user asks about it.
	useAssistantPageContext(
		dashboardId
			? {
					id: `dashboard:${dashboardId}`,
					title: dashboardName,
					text: snapshot,
					getText: () => dashboardSnapshot(widgetsRef.current),
				}
			: null
	);
	// Dashboard controls live in the window titlebar actions instead of an
	// in-page header row. To keep the titlebar uncluttered, everything hangs off
	// the single dashboard selector dropdown: switching dashboards, adding widgets
	// (Build with AI + the widget presets), and managing the current dashboard.
	const dashboardActions = useMemo(
		() => (
			<div className="flex items-center gap-1.5">
				<ToggleGroup
					appearance="segmented"
					onValueChange={(values: string[]) => {
						const v = values[0];
						if (v === "grid" || v === "canvas") {
							handleSetViewMode(v);
						}
					}}
					spacing={0}
					value={[viewMode]}
					variant="default"
				>
					<ToggleGroupItem
						aria-label="Grid view"
						density="dashboard-tab"
						value="grid"
					>
						<HugeiconsIcon icon={GridViewIcon} size={14} /> Grid
					</ToggleGroupItem>
					<ToggleGroupItem
						aria-label="Canvas view"
						density="dashboard-tab"
						value="canvas"
					>
						<HugeiconsIcon icon={FrameIcon} size={14} /> Canvas
					</ToggleGroupItem>
				</ToggleGroup>
				<DropdownMenu>
					<DropdownMenuTrigger render={<Button size="sm" variant="ghost" />}>
						<span className="flex items-center gap-0.5">
							{dashboardName}
							<HugeiconsIcon
								className="text-muted-foreground"
								icon={ArrowDown01Icon}
								size={14}
							/>
						</span>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="min-w-52">
						<DropdownMenuGroup>
							<DropdownMenuLabel>Dashboards</DropdownMenuLabel>
							{dashboards.map((d) => (
								<DropdownMenuItem
									key={d.id}
									onClick={() => handleSelectDashboard(d.id)}
								>
									<HugeiconsIcon
										className={
											d.id === dashboardId ? "size-4" : "size-4 opacity-0"
										}
										icon={Tick02Icon}
									/>
									<span className="truncate" title={d.name}>
										{d.name}
									</span>
								</DropdownMenuItem>
							))}
						</DropdownMenuGroup>
						<DropdownMenuSeparator />
						<DropdownMenuItem onClick={() => setBuilderOpen(true)}>
							<HugeiconsIcon icon={SparklesIcon} size={16} /> Build a work view
						</DropdownMenuItem>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>
								<HugeiconsIcon icon={PlusSignIcon} size={16} /> Add widget
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								{quickAddPresets.map((preset) => (
									<DropdownMenuItem
										key={preset.label}
										onClick={() => handleCreateWidget(preset)}
									>
										{preset.label}
									</DropdownMenuItem>
								))}
								<DropdownMenuSeparator />
								<DropdownMenuItem onClick={() => setAddOpen(true)}>
									<HugeiconsIcon icon={PlusSignIcon} size={16} /> Custom widget…
								</DropdownMenuItem>
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onClick={() => setNameDialog({ mode: "create", value: "" })}
						>
							<HugeiconsIcon icon={PlusSignIcon} size={16} /> New dashboard
						</DropdownMenuItem>
						<DropdownMenuItem
							onClick={() =>
								setNameDialog({ mode: "rename", value: dashboardName })
							}
						>
							<HugeiconsIcon icon={PencilEdit01Icon} size={16} /> Rename
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={dashboards.length <= 1}
							onClick={() => setConfirmDeleteOpen(true)}
							variant="destructive"
						>
							<HugeiconsIcon icon={Delete02Icon} size={16} /> Delete
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		),
		[
			dashboardName,
			dashboards,
			dashboardId,
			handleSelectDashboard,
			handleCreateWidget,
			viewMode,
			handleSetViewMode,
		]
	);
	useTitleBar(null, dashboardActions);
	return {};
}
