// apps/desktop/src/pages/HomePage.tsx
//
// The Home dashboard: a customizable, constantly-updating grid of widgets. The
// grid is the main surface; a collapsible "Build with AI" panel hosts the
// dashboard builder chat (mirroring the Workflows page). Widgets render from a
// fixed catalog of standard shadcn components, pull live data via Core's refresh
// loop, and update over SSE. Layout (drag/resize) persists to Core per widget.

import {
	Alert02Icon,
	DashboardSquare01Icon,
	PlusSignIcon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";

import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Input } from "@ryu/ui/components/input.tsx";

import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";

import { AddWidgetDialog } from "@/src/components/dashboard/AddWidgetDialog.tsx";
import { DashboardCanvas } from "@/src/components/dashboard/DashboardCanvas.tsx";
import { DashboardGrid } from "@/src/components/dashboard/DashboardGrid.tsx";
import { useHomeAssistantSurface } from "./HomePage.assistant.tsx";
import { useHomeDashboardActions } from "./HomePage.dashboards.ts";
import { useHomeDashboardData } from "./HomePage.data.ts";
import { useHomeWidgetActions } from "./HomePage.widgets.ts";

export default function HomePage() {
	const tl = useLiteralMessages();
	const {
		addOpen,
		builderOpen,
		canvasCenterRef,
		confirmDeleteOpen,
		coreEndpoints,
		dashboardId,
		dashboardName,
		dashboards,
		error,
		generating,
		live,
		loading,
		nameDialog,
		publishDashboardChanged,
		refreshList,
		reload,
		setAddOpen,
		setBuilderOpen,
		setConfirmDeleteOpen,
		setDashboardId,
		setDashboardName,
		setDashboards,
		setError,
		setGenerating,
		setLive,
		setLoading,
		setNameDialog,
		setReloadKey,
		setViewMode,
		setWidgets,
		sourceTypes,
		target,
		viewMode,
		widgets,
	} = useHomeDashboardData();
	const {
		handleCanvasPersist,
		handleLayoutPersist,
		handleRefresh,
		handleRemove,
		handleSetViewMode,
	} = useHomeWidgetActions({
		dashboardId,
		publishDashboardChanged,
		reload,
		setDashboards,
		setLive,
		setViewMode,
		setWidgets,
		target,
		viewMode,
	});
	const {
		handleCreateWidget,
		handleDeleteCurrent,
		handleGenerateWithAi,
		handleRetry,
		handleSelectDashboard,
		handleSubmitName,
		resolveDashboardId,
		setStarterPending,
		starterPending,
	} = useHomeDashboardActions({
		canvasCenterRef,
		dashboardId,
		dashboards,
		handleRefresh,
		nameDialog,
		publishDashboardChanged,
		refreshList,
		reload,
		setBuilderOpen,
		setConfirmDeleteOpen,
		setDashboardId,
		setDashboardName,
		setError,
		setGenerating,
		setLive,
		setLoading,
		setNameDialog,
		setReloadKey,
		setWidgets,
		target,
		viewMode,
		widgets,
	});
	useHomeAssistantSurface({
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
	});

	if (loading && widgets.length === 0 && !error) {
		return <SkeletonRows rows={6} spacing="library" />;
	}

	const buildLoadErrorArea = () => (
		<Empty className="h-full">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<HugeiconsIcon icon={Alert02Icon} />
				</EmptyMedia>
				<EmptyTitle>Couldn't load your dashboard</EmptyTitle>
				<EmptyDescription>{error}</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<Button onClick={handleRetry} size="sm" variant="ghost">
					Try again
				</Button>
			</EmptyContent>
		</Empty>
	);

	const buildEmptyArea = () => {
		// An AI "generate" turn is running: show progress, not the call-to-action,
		// so the user waits for widgets to materialise rather than re-triggering.
		if (generating) {
			return (
				<Empty className="h-full">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Spinner />
						</EmptyMedia>
						<EmptyTitle>Assembling your work view…</EmptyTitle>
						<EmptyDescription>
							Ryu is choosing useful widgets and arranging them for you. They'll
							appear here as they're created — you can follow along in the chat.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			);
		}
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={DashboardSquare01Icon} />
					</EmptyMedia>
					<EmptyTitle>Your work dashboard is empty</EmptyTitle>
					<EmptyDescription>
						Start with a view of the work that matters. Ryu can build one from
						your activity, or you can add the pieces yourself.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<div className="flex flex-wrap items-center justify-center gap-2">
						<Button onClick={handleGenerateWithAi} size="sm" variant="outline">
							<HugeiconsIcon icon={SparklesIcon} size={16} /> Build a work view
							for me
						</Button>
						<Button onClick={() => setAddOpen(true)} size="sm" variant="ghost">
							<HugeiconsIcon icon={PlusSignIcon} size={16} /> Add a widget
						</Button>
					</div>
				</EmptyContent>
			</Empty>
		);
	};

	const buildGridArea = () => {
		// A failed fetch must not masquerade as an empty dashboard.
		if (error && widgets.length === 0) {
			return buildLoadErrorArea();
		}
		if (widgets.length === 0) {
			return buildEmptyArea();
		}
		if (viewMode === "canvas") {
			return (
				<DashboardCanvas
					live={live}
					onAddWidget={() => setAddOpen(true)}
					onCanvasPersist={handleCanvasPersist}
					onRefresh={handleRefresh}
					onRemove={handleRemove}
					onViewportCenterChange={(c) => {
						canvasCenterRef.current = c;
					}}
					widgets={widgets}
				/>
			);
		}
		return (
			<div className="scroll-fade h-full overflow-auto p-3">
				<DashboardGrid
					live={live}
					onLayoutPersist={handleLayoutPersist}
					onRefresh={handleRefresh}
					onRemove={handleRemove}
					widgets={widgets}
				/>
			</div>
		);
	};

	const gridArea = buildGridArea();

	return (
		<div className="flex h-full flex-col overflow-hidden">
			{error && widgets.length > 0 && (
				<div className="flex items-center gap-3 bg-destructive/10 px-4 py-2 text-status-destructive text-xs">
					<span className="flex-1">{error}</span>
					<Button onClick={handleRetry} size="tiny" variant="ghost">
						Try again
					</Button>
					<Button
						aria-label="Dismiss error"
						onClick={() => setError(null)}
						size="tiny"
						variant="ghost"
					>
						Dismiss
					</Button>
				</div>
			)}
			<div className="min-h-0 flex-1">{gridArea}</div>
			<AddWidgetDialog
				coreEndpoints={coreEndpoints}
				onCreate={handleCreateWidget}
				onOpenChange={setAddOpen}
				open={addOpen}
				sourceTypes={sourceTypes}
			/>
			<Dialog
				onOpenChange={(open) => {
					if (!open) {
						setNameDialog(null);
					}
				}}
				open={nameDialog !== null}
			>
				<DialogContent className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle>
							{nameDialog?.mode === "rename"
								? "Rename dashboard"
								: "New dashboard"}
						</DialogTitle>
					</DialogHeader>
					<Input
						aria-label="Dashboard name"
						autoFocus
						onChange={(e) =>
							setNameDialog((prev) =>
								prev ? { ...prev, value: e.target.value } : prev
							)
						}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								handleSubmitName();
							}
						}}
						placeholder="Dashboard name"
						value={nameDialog?.value ?? ""}
					/>
					<DialogFooter>
						<Button onClick={() => setNameDialog(null)} variant="ghost">
							Cancel
						</Button>
						<Button
							disabled={!nameDialog?.value.trim()}
							onClick={() => handleSubmitName()}
							variant="mono"
						>
							{nameDialog?.mode === "rename" ? "Rename" : "Create"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<AlertDialog onOpenChange={setConfirmDeleteOpen} open={confirmDeleteOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{tl('Delete "{dashboardName}"?', { dashboardName })}
						</AlertDialogTitle>
						<AlertDialogDescription>
							This permanently deletes this dashboard and all of its widgets.
							This cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => handleDeleteCurrent()}
							variant="destructive"
						>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
