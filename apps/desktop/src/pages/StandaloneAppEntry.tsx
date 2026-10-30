import type { StandaloneBootstrapPhase } from "@ryu/app-host/standalone";
import { Logo as OrbLogo } from "@ryu/ui/components/logo.tsx";
import { PageHeader } from "@ryu/ui/components/page-header.tsx";
import { SidebarInset, SidebarProvider } from "@ryu/ui/components/sidebar.tsx";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { bootstrapStandaloneApp } from "@/lib/tauri-bridge.ts";
import {
	type StandaloneAppNavigation,
	StandaloneAppSidebar,
} from "@/src/components/layout/StandaloneAppSidebar.tsx";
import { TabsProvider } from "@/src/contexts/TabsContext.tsx";
import {
	pluginCompanionPath,
	usePluginContributions,
} from "@/src/hooks/usePluginContributions.ts";
import { triggerGlobalRefresh } from "@/src/lib/core-refresh.ts";
import { isNavigablePluginCompanion } from "@/src/lib/plugin-companion-navigation.ts";
import { STANDALONE_APP_NAME } from "@/src/lib/product.ts";
import PluginCompanionPage from "@/src/pages/PluginCompanionPage.tsx";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

function phaseLabel(phase: StandaloneBootstrapPhase): string {
	switch (phase) {
		case "installing":
			return "Installing the app";
		case "enabling":
			return "Starting the app";
		case "no_companion":
			return "This app runs through Ryu Core";
		case "ready":
			return "Opening the app";
		case "error":
			return "The app could not start";
		default:
			return "Starting Ryu";
	}
}

function withTimeout<T>(
	promise: Promise<T>,
	milliseconds: number,
	label: string
) {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${label} timed out after ${milliseconds}ms.`)),
			milliseconds
		);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

function StandaloneBootstrap({
	appId,
	onCompanionReady,
}: {
	appId: string;
	onCompanionReady: (companionId: string) => void;
}) {
	const setLocalNodeToken = useNodeStore((state) => state.setLocalNodeToken);
	const { companions } = usePluginContributions();
	const [phase, setPhase] = useState<StandaloneBootstrapPhase>("loading");
	const [appName, setAppName] = useState(STANDALONE_APP_NAME || "Ryu App");
	const [error, setError] = useState<string | null>(null);
	const started = useRef(false);

	useEffect(() => {
		let active = true;
		if (!(appId && !started.current)) {
			return () => {
				active = false;
			};
		}
		started.current = true;

		async function bootstrap(): Promise<void> {
			try {
				const result = await withTimeout(
					bootstrapStandaloneApp(),
					180_000,
					"Standalone native bootstrap"
				);
				if (result.appId !== appId) {
					throw new Error(
						`Standalone bundle is for ${result.appId}, not ${appId}.`
					);
				}
				setAppName(result.appName);
				setLocalNodeToken(result.token);
				if (result.companionId) {
					onCompanionReady(result.companionId);
				}
				triggerGlobalRefresh();
				if (active) {
					setPhase(result.companionId ? "loading" : "no_companion");
				}
			} catch (cause) {
				if (!active) {
					return;
				}
				setError(cause instanceof Error ? cause.message : String(cause));
				setPhase("error");
			}
		}

		bootstrap().catch((cause) => {
			if (active) {
				setError(cause instanceof Error ? cause.message : String(cause));
				setPhase("error");
			}
		});
		return () => {
			active = false;
		};
	}, [appId, onCompanionReady, setLocalNodeToken]);

	useEffect(() => {
		const companionId = companions.find(
			(companion) =>
				companion.pluginId === appId && isNavigablePluginCompanion(companion)
		)?.id;
		if (companionId) {
			onCompanionReady(companionId);
			setPhase("ready");
			return;
		}
	}, [appId, companions, onCompanionReady, phase]);

	if (phase === "ready") {
		return null;
	}

	return (
		<div
			className="scroll-fade fixed inset-0 z-[100] h-full w-full overflow-y-auto bg-background"
			data-tauri-drag-region="true"
		>
			<div
				className="flex min-h-full w-full flex-col items-center justify-center gap-8 p-8"
				data-tauri-drag-region="true"
			>
				<div className="fade-in flex w-full max-w-md animate-in flex-col items-center gap-6 duration-(--duration-base) ease-enter">
					<div className="shrink-0">
						<OrbLogo
							size="56px"
							variant={phase === "error" ? "outline" : "shimmer"}
						/>
					</div>
					<PageHeader
						className="w-full text-center"
						size="app"
						subtitle={error ?? phaseLabel(phase)}
						title={appName}
						titleClassName="text-center"
					/>
				</div>
				{phase === "no_companion" ? (
					<p className="max-w-md text-muted-foreground text-sm">
						The app is enabled and its Core services are ready. This app does
						not declare a visual Companion surface.
					</p>
				) : null}
				{phase === "error" ? (
					<p className="text-sm text-status-destructive">
						Check the local Ryu Core logs, then restart this app.
					</p>
				) : null}
			</div>
		</div>
	);
}

/**
 * The app-first surface for a standalone product. The Ryu shell is a host
 * contract, not the product chrome: standalone windows mount the contributed
 * Companion directly while retaining the host providers that its bridge uses.
 */

function StandaloneCompanionSurface({
	appId,
	companionId,
}: {
	appId: string;
	companionId: string;
}) {
	const [navigation, setNavigation] = useState<StandaloneAppNavigation>({
		target: pluginCompanionPath(companionId),
	});
	const handleNavigate = useCallback((next: StandaloneAppNavigation) => {
		setNavigation(next);
	}, []);

	return (
		<TooltipProvider delay={0}>
			<SidebarProvider defaultOpen>
				<StandaloneAppSidebar appId={appId} onNavigate={handleNavigate} />
				<SidebarInset>
					<TabsProvider
						initialTab={{
							path: navigation.target,
							title: "App",
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
		</TooltipProvider>
	);
}

function StandaloneAppContent({ appId }: { appId: string }) {
	const [companionId, setCompanionId] = useState<string | null>(null);
	const handleCompanionReady = useCallback((id: string) => {
		setCompanionId(id);
	}, []);

	return (
		<>
			<StandaloneBootstrap
				appId={appId}
				onCompanionReady={handleCompanionReady}
			/>
			{companionId ? (
				<StandaloneCompanionSurface appId={appId} companionId={companionId} />
			) : null}
		</>
	);
}

/** A standalone product window with its app UI as the only visible surface. */
export default function StandaloneAppEntry({ appId }: { appId: string }) {
	return <StandaloneAppContent appId={appId} />;
}
