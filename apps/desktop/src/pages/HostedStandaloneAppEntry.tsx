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
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Logo as OrbLogo } from "@ryu/ui/components/logo.tsx";
import { PageHeader } from "@ryu/ui/components/page-header.tsx";
import { SidebarInset, SidebarProvider } from "@ryu/ui/components/sidebar.tsx";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { useCallback, useEffect, useState } from "react";
import { closeCurrentWindow } from "@/lib/tauri-bridge.ts";
import {
	type StandaloneAppNavigation,
	StandaloneAppSidebar,
} from "@/src/components/layout/StandaloneAppSidebar.tsx";
import { TabsProvider } from "@/src/contexts/TabsContext.tsx";
import {
	pluginCompanionPath,
	usePluginContributionsLiveRefresh,
	usePluginContributionsQuery,
} from "@/src/hooks/usePluginContributions.ts";
import { useStandaloneApps } from "@/src/hooks/useStandaloneApps.ts";
import { isNavigablePluginCompanion } from "@/src/lib/plugin-companion-navigation.ts";
import PluginCompanionPage from "@/src/pages/PluginCompanionPage.tsx";

function StartupState({
	title,
	description,
}: {
	title: string;
	description: string;
}) {
	return (
		<div className="flex size-full items-center justify-center bg-background">
			<div className="fade-in flex w-full max-w-md animate-in flex-col items-center gap-6 p-8 duration-(--duration-base) ease-enter">
				<OrbLogo size="56px" variant="shimmer" />
				<PageHeader
					className="w-full text-center"
					size="app"
					subtitle={description}
					title={title}
					titleClassName="text-center"
				/>
			</div>
		</div>
	);
}

function UnavailableStandaloneApp({
	appId,
	description,
}: {
	appId: string;
	description: string;
}) {
	const tl = useLiteralMessages();
	return (
		<Empty appearance="standalone" className="size-full">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<OrbLogo size="28px" variant="outline" />
				</EmptyMedia>
				<EmptyTitle>Standalone app unavailable</EmptyTitle>
				<EmptyDescription>
					{tl("{description} The app and its data remain safe in Ryu.", {
						description,
					})}
				</EmptyDescription>
			</EmptyHeader>
			<EmptyContent>
				<Button
					onClick={() => closeCurrentWindow().catch(() => undefined)}
					size="sm"
					variant="outline"
				>
					Close window
				</Button>
			</EmptyContent>
			<p className="text-muted-foreground text-xs">{appId}</p>
		</Empty>
	);
}

function HostedStandaloneSurface({
	appId,
	companionId,
	appName,
}: {
	appId: string;
	companionId: string;
	appName: string;
}) {
	const tl = useLiteralMessages();
	const [navigation, setNavigation] = useState<StandaloneAppNavigation>({
		target: pluginCompanionPath(companionId),
	});
	const [removeOpen, setRemoveOpen] = useState(false);
	const [removeError, setRemoveError] = useState<string | null>(null);
	const [removing, setRemoving] = useState(false);
	const { closeStandaloneWindow, uninstall: uninstallStandalone } =
		useStandaloneApps();

	const handleNavigate = useCallback((next: StandaloneAppNavigation) => {
		setNavigation(next);
	}, []);

	const handleRemove = async () => {
		if (removing) {
			return;
		}
		setRemoving(true);
		setRemoveError(null);
		try {
			await uninstallStandalone(appId);
			await closeStandaloneWindow();
			setRemoveOpen(false);
		} catch (cause) {
			setRemoveError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setRemoving(false);
		}
	};

	return (
		<TooltipProvider delay={0}>
			<SidebarProvider defaultOpen>
				<StandaloneAppSidebar
					appId={appId}
					onNavigate={handleNavigate}
					onRequestRemove={() => {
						setRemoveError(null);
						setRemoveOpen(true);
					}}
				/>
				<SidebarInset>
					<TabsProvider
						initialTab={{
							path: navigation.target,
							title: appName,
						}}
						key={`${navigation.target}:${JSON.stringify(navigation.context ?? {})}`}
					>
						<div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
							<PluginCompanionPage
								companionId={companionId}
								mountContext={navigation.context}
							/>
						</div>
					</TabsProvider>
				</SidebarInset>
			</SidebarProvider>
			<AlertDialog
				onOpenChange={(open) => {
					if (!removing) {
						setRemoveOpen(open);
					}
				}}
				open={removeOpen}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Remove standalone app?</AlertDialogTitle>
						<AlertDialogDescription>
							{tl(
								"This closes this app-first window and removes its standalone launcher. {appName} stays installed inside Ryu, and its data, settings, and connections are not deleted.",
								{ appName }
							)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					{removeError ? (
						<p className="text-sm text-status-destructive" role="alert">
							{tl(
								"{removeError} Try again to finish removing the standalone app.",
								{
									removeError,
								}
							)}
						</p>
					) : null}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							disabled={removing}
							onClick={(event) => {
								event.preventDefault();
								handleRemove().catch(() => undefined);
							}}
						>
							{removing ? "Removing…" : "Remove standalone app"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</TooltipProvider>
	);
}

/** Hosted standalone view: same node and app bridge, different Desktop chrome. */
export default function HostedStandaloneAppEntry({ appId }: { appId: string }) {
	usePluginContributionsLiveRefresh();
	const { data, error, isLoading } = usePluginContributionsQuery();
	const companion = data?.companions.find(
		(candidate) =>
			candidate.pluginId === appId && isNavigablePluginCompanion(candidate)
	);

	useEffect(() => {
		if (companion?.label || companion?.name) {
			document.title = companion.label || companion.name;
		}
	}, [companion]);

	if (isLoading) {
		return (
			<StartupState
				description="Loading the shared Ryu app data…"
				title="Starting app"
			/>
		);
	}
	if (error || !companion) {
		return (
			<UnavailableStandaloneApp
				appId={appId}
				description={
					error
						? "Ryu could not load this app from the active node."
						: "This app is disabled or no longer installed on the active node."
				}
			/>
		);
	}

	return (
		<HostedStandaloneSurface
			appId={appId}
			appName={companion.label || companion.name}
			companionId={companion.id}
		/>
	);
}
