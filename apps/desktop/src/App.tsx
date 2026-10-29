import { ditherAvatarSeed } from "@ryu/ui/components/dither-kit/avatar.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { DEFAULT_THEME_MODE } from "@ryu/ui/theme/prefs.ts";
import { ThemeProvider } from "next-themes";
import { type ReactNode, Suspense, useEffect, useState } from "react";
import {
	getActiveToken,
	useSession,
	vaultHydrated,
} from "@/lib/auth-client.ts";
import { PLAYGROUND_BUILD } from "@/lib/playground.ts";
import {
	type AppSurface,
	AppSurfaceProvider,
	type HostBackButton,
	useAppSurface,
} from "@/src/contexts/app-surface-context.tsx";
import { BootSpinner } from "./boot/boot-spinner.tsx";
import {
	CompanionOverlay,
	DesktopNativeSync,
	DesktopStartupChooser,
	MediaPipOverlay,
	preloadSignedInShell,
	SignedInShell,
	WaitlistPage,
} from "./boot/screens.ts";
import { useBootServices } from "./boot/use-boot-services.ts";
import { useCoreStatusPoll } from "./boot/use-core-status-poll.ts";
import { useNativeEventToasts } from "./boot/use-native-event-toasts.ts";
import { useNodeOnboardingState } from "./boot/use-node-onboarding-state.ts";
import { useQuestEvents } from "./boot/use-quest-events.ts";
import { useRouterEpoch } from "./boot/use-router-epoch.ts";
import { useSessionValidation } from "./boot/use-session-validation.ts";
import { useShellChrome } from "./boot/use-shell-chrome.ts";
import { useStartupSelection } from "./boot/use-startup-selection.ts";
import { useWaitlistGate } from "./boot/use-waitlist-gate.ts";
import {
	HOSTED_STANDALONE_APP_ID,
	WINDOW_LABEL,
} from "./boot/window-identity.ts";
import { AgentationToolbar } from "./components/AgentationToolbar.tsx";
import { BotTerminologyProvider } from "./components/BotTerminologyProvider.tsx";
import { CrashBoundary } from "./components/CrashBoundary.tsx";
import { PageWrapper } from "./components/layout/PageWrapper.tsx";
import { GlobalContextMenu } from "./components/shell/GlobalContextMenu.tsx";
import { UpdateStartupScreen } from "./components/startup/UpdateStartupScreen.tsx";
import { useThemePreset } from "./hooks/useThemePreset.ts";
import { useUpdateStartupHealth } from "./hooks/useUpdateStartupHealth.ts";
import {
	isDesktopOnboardingComplete,
	shouldStartOnboarding,
	wasNodeSetupComplete,
} from "./lib/desktop-onboarding-state.ts";
import { isRyuStandaloneApp } from "./lib/product.ts";
import { useProductMode } from "./lib/product-mode.ts";
// The signed-out first screen (and its largest paint) stays in the entry; every
// screen past it loads on demand from `./boot/screens.ts`.
import LoginPage from "./pages/LoginPage.tsx";
import { useAppStore } from "./store/useAppStore.ts";
import { useNodeStore } from "./store/useNodeStore.ts";

/** The active account's bearer (from the sealed vault), or null when the shell is cookie-only. */
function readActiveSessionToken(): string | null {
	return getActiveToken();
}

export interface DesktopAppProps {
	/** A host-owned Back control, such as Telegram's Mini App header button. */
	hostBackButton?: HostBackButton;
	/** The product shell hosting this shared React tree. */
	hostSurface: AppSurface;
}

export default function App({ hostBackButton, hostSurface }: DesktopAppProps) {
	// Companion overlay is a completely separate surface — no auth, no layout.
	// Wrap both surfaces in the crash boundary so an unhandled render error is
	// caught (recoverable fallback, not a white screen) and reported when the user
	// consented to crash reports. The transparent overlay windows show nothing,
	// not a spinner, while their code loads.
	return (
		<AppSurfaceProvider hostBackButton={hostBackButton} surface={hostSurface}>
			<CrashBoundary>
				{WINDOW_LABEL === "companion" ? (
					<Suspense fallback={null}>
						<CompanionOverlay />
					</Suspense>
				) : WINDOW_LABEL === "media-pip" ? (
					<Suspense fallback={null}>
						<MediaPipOverlay />
					</Suspense>
				) : (
					<MainApp hostSurface={hostSurface} />
				)}
			</CrashBoundary>
		</AppSurfaceProvider>
	);
}

function ThemeWatcher() {
	useThemePreset();
	return null;
}

function MainApp({ hostSurface }: { hostSurface: AppSurface }) {
	const productMode = useProductMode();
	const botProduct = productMode === "bot";
	const standaloneApp = isRyuStandaloneApp();
	const hostedStandaloneApp = Boolean(HOSTED_STANDALONE_APP_ID);
	const activeNodeForOnboarding = useNodeStore((s) => s.getActiveNode());
	const { data: session, isPending } = useSession();
	const [vaultReady, setVaultReady] = useState(false);
	const [nodesReady, setNodesReady] = useState(false);
	const [startupSelectionStatus, setStartupSelectionStatus] = useState<
		"loading" | "show" | "ready"
	>("loading");
	const isAuthenticated = useAppStore((s) => s.isAuthenticated);

	// `useSession()` (Better Auth) re-fetches on every window focus, flipping
	// `isPending` back to true. Without this guard that swaps the whole tree to
	// the loading spinner and REMOUNTS LoginPage — so alt-tabbing back from the
	// device-approval tab reset the sign-in flow to "Get Started" and killed the
	// poll. Show the full-screen spinner only until the session resolves the FIRST
	// time; later focus-refetches keep the current screen mounted.
	const [sessionSettledOnce, setSessionSettledOnce] = useState(false);
	const updateStartupStatus = useUpdateStartupHealth(
		vaultReady && nodesReady && sessionSettledOnce,
		hostSurface === "desktop" && WINDOW_LABEL === "main"
	);
	useEffect(() => {
		if (!isPending) {
			setSessionSettledOnce(true);
		}
	}, [isPending]);

	useEffect(() => {
		let active = true;
		void vaultHydrated.then(() => {
			if (active) {
				setVaultReady(true);
			}
		});
		return () => {
			active = false;
		};
	}, []);

	useBootServices(setNodesReady);
	useCoreStatusPoll(botProduct);
	useNativeEventToasts(botProduct);
	useSessionValidation(session);

	const authed = !!session || isAuthenticated;
	// Node setup is a server-owned gate. Read it only after the active node and
	// startup chooser have settled, so a new desktop can discover an incomplete
	// node even when its own localStorage says desktop onboarding is finished.
	// Older nodes that do not expose the endpoint remain compatible: a failed read
	// does not invent state and falls back to the existing desktop-only marker.
	const {
		nodeOnboardingState,
		nodeOnboardingStateAvailable,
		nodeOnboardingStateStatus,
	} = useNodeOnboardingState({
		activeNodeForOnboarding,
		authed,
		botProduct,
		nodesReady,
		startupSelectionStatus,
		vaultReady,
	});
	useQuestEvents({
		authed,
		hostSurface,
		userId: session?.user?.id,
		vaultReady,
	});
	useStartupSelection({
		authed,
		botProduct,
		nodesReady,
		setStartupSelectionStatus,
		vaultReady,
	});
	const waitlistSurface = useWaitlistGate({
		activeNodeForOnboarding,
		authed,
		session,
	});
	useShellChrome();

	// The Codespaces playground build opens on the codespace's own Core with no
	// hosted account, the way a standalone app does: the visitor owns that node,
	// and its same-origin proxy holds the node token. No other build sets it.
	const showApp = standaloneApp || authed || PLAYGROUND_BUILD;
	// Hold the app behind the waitlist check while it resolves, so we never flash
	// the app and then bounce a pending managed-node user to the queue screen.
	const waitlistResolving =
		!standaloneApp && showApp && waitlistSurface === "loading";
	const waitlisted =
		!standaloneApp && showApp && waitlistSurface === "waitlisted";
	// Read every render, so a sign-in or account switch re-reads the account's
	// second-factor status under the new bearer.
	const controlPlaneToken = authed ? readActiveSessionToken() : null;
	const startupSelectionLoading =
		!(standaloneApp || hostedStandaloneApp) &&
		authed &&
		startupSelectionStatus === "loading";
	const startupChooserVisible =
		!(botProduct || standaloneApp || hostedStandaloneApp) &&
		authed &&
		startupSelectionStatus === "show";
	const desktopOnboardingComplete = isDesktopOnboardingComplete();
	// Onboarding is a desktop install flow (accounts, local engines, devices); the
	// playground skips it and opens the chat on the provider-backed Core.
	const shouldMountOnboarding =
		!PLAYGROUND_BUILD &&
		shouldStartOnboarding({
			desktopComplete: desktopOnboardingComplete,
			nodeCanConfigure: nodeOnboardingState?.canConfigure,
			nodeComplete: nodeOnboardingState?.completed,
			nodeStateAvailable: nodeOnboardingStateAvailable,
		});
	// A node that finished setup last time renders the shell immediately while the
	// live node-setup read runs. If that read says setup is now required, the
	// router is remounted once so it starts on /onboarding (MemoryRouter only
	// reads `initialEntries` at mount).
	const nodeSetupWaiting =
		nodeOnboardingStateStatus === "loading" && !nodeOnboardingStateAvailable;
	const renderedFromNodeSetupCache =
		nodeSetupWaiting &&
		desktopOnboardingComplete &&
		wasNodeSetupComplete(activeNodeForOnboarding.url);
	const routerEpoch = useRouterEpoch({
		nodeOnboardingStateStatus,
		renderedFromNodeSetupCache,
		shouldMountOnboarding,
	});

	// A signed-in (or vault-remembered) user is headed for the shell: start its
	// download while the session, waitlist and node checks run.
	const headedForShell =
		!waitlisted && (showApp || (vaultReady && getActiveToken() !== null));
	const shellUsesLayout = !(botProduct || standaloneApp || hostedStandaloneApp);
	useEffect(() => {
		if (headedForShell) {
			preloadSignedInShell({ layout: shellUsesLayout });
		}
	}, [headedForShell, shellUsesLayout]);

	return (
		<ThemeProvider
			attribute="class"
			defaultTheme={DEFAULT_THEME_MODE}
			enableSystem
			themes={["light", "dark", "system"]}
		>
			<BotTerminologyProvider>
				<ThemeWatcher />
				{/* The native title and keep-awake sync; inert in browser hosts. */}
				{hostSurface === "desktop" ? (
					<Suspense fallback={null}>
						<DesktopNativeSync />
					</Suspense>
				) : null}
				<Toaster position="bottom-right" theme="system" />
				{updateStartupStatus === "ready" && <AgentationToolbar />}
				<HostContextMenu>
					{updateStartupStatus === "ready" ? (
						startupSelectionLoading ? (
							<PageWrapper>
								<BootSpinner />
							</PageWrapper>
						) : startupChooserVisible ? (
							<PageWrapper>
								<Suspense fallback={<BootSpinner />}>
									<DesktopStartupChooser />
								</Suspense>
							</PageWrapper>
						) : (!standaloneApp && isPending && !sessionSettledOnce) ||
							waitlistResolving ? (
							<PageWrapper>
								<BootSpinner />
							</PageWrapper>
						) : waitlisted ? (
							<PageWrapper>
								<Suspense fallback={<BootSpinner />}>
									<WaitlistPage
										avatarSeed={ditherAvatarSeed({
											id: session?.user?.id,
											email: session?.user?.email,
											name: session?.user?.name,
										})}
										avatarUrl={session?.user?.image ?? null}
										userName={session?.user?.name ?? null}
										userNameLoading={isPending}
									/>
								</Suspense>
							</PageWrapper>
						) : showApp ? (
							<Suspense
								fallback={
									<PageWrapper>
										<BootSpinner />
									</PageWrapper>
								}
							>
								<SignedInShell
									accountEmail={session?.user?.email ?? null}
									accountId={session?.user?.id ?? null}
									botProduct={botProduct}
									controlPlaneToken={controlPlaneToken}
									hostedStandaloneApp={hostedStandaloneApp}
									hostSurface={hostSurface}
									mfaEnabled={authed && !session?.user?.isAnonymous}
									nodeOnboardingState={nodeOnboardingState}
									nodeOnboardingStateAvailable={nodeOnboardingStateAvailable}
									nodeSetupWaiting={nodeSetupWaiting}
									renderedFromNodeSetupCache={renderedFromNodeSetupCache}
									routerEpoch={routerEpoch}
									shouldMountOnboarding={shouldMountOnboarding}
									standaloneApp={standaloneApp}
								/>
							</Suspense>
						) : (
							<PageWrapper>
								<LoginPage />
							</PageWrapper>
						)
					) : (
						<PageWrapper>
							<UpdateStartupScreen status={updateStartupStatus} />
						</PageWrapper>
					)}
				</HostContextMenu>
			</BotTerminologyProvider>
		</ThemeProvider>
	);
}

function HostContextMenu({ children }: { children: ReactNode }) {
	return useAppSurface().isDesktop ? (
		<GlobalContextMenu>{children}</GlobalContextMenu>
	) : (
		children
	);
}
