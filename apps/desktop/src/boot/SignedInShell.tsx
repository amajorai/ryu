import { ConsentHostContext } from "@ryu/blocks/desktop/agent-elements/consent-host-context.tsx";
import { Suspense } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "@/contexts/auth-context.tsx";
import type { AppSurface } from "@/src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "@/src/contexts/entitlement-context.tsx";
import type { NodeOnboardingSnapshot } from "@/src/lib/api/onboarding-profile.ts";
import { chatConsentHost } from "../components/chat/consent/chat-consent-host.ts";
import { PageWrapper } from "../components/layout/PageWrapper.tsx";
import { MfaEnrollmentGate } from "../components/MfaEnrollmentGate.tsx";
import { ProductModeAccessSync } from "../components/shell/ProductModeAccessSync.tsx";
import { STANDALONE_APP_ID } from "../lib/product.ts";
import { BootSpinner } from "./boot-spinner.tsx";
import {
	BotManagedEntry,
	HostedStandaloneAppEntry,
	Layout,
	OnboardingRoute,
	StandaloneAppEntry,
} from "./screens.ts";
import { HOSTED_STANDALONE_APP_ID } from "./window-identity.ts";

export interface SignedInShellProps {
	accountEmail: string | null;
	accountId: string | null;
	botProduct: boolean;
	controlPlaneToken: string | null;
	hostedStandaloneApp: boolean;
	hostSurface: AppSurface;
	mfaEnabled: boolean;
	nodeOnboardingState: NodeOnboardingSnapshot | null;
	nodeOnboardingStateAvailable: boolean;
	nodeSetupWaiting: boolean;
	renderedFromNodeSetupCache: boolean;
	routerEpoch: number;
	shouldMountOnboarding: boolean;
	standaloneApp: boolean;
}

/** Everything past sign-in and the waitlist. Loaded on demand (see `screens.ts`). */
export default function SignedInShell({
	accountEmail,
	accountId,
	botProduct,
	controlPlaneToken,
	hostedStandaloneApp,
	hostSurface,
	mfaEnabled,
	nodeOnboardingState,
	nodeOnboardingStateAvailable,
	nodeSetupWaiting,
	renderedFromNodeSetupCache,
	routerEpoch,
	shouldMountOnboarding,
	standaloneApp,
}: SignedInShellProps) {
	const shell = (
		// Past the waitlist, a signed-in account still needs a second
		// factor before the control plane answers it.
		<MfaEnrollmentGate
			accountEmail={accountEmail}
			accountId={accountId}
			enabled={mfaEnabled}
			frame={PageWrapper}
			loading={
				<PageWrapper>
					<BootSpinner />
				</PageWrapper>
			}
			token={controlPlaneToken}
		>
			<AuthProvider>
				<PageWrapper>
					<EntitlementProvider>
						<ProductModeAccessSync>
							<Suspense fallback={<BootSpinner />}>
								{standaloneApp ? (
									<StandaloneAppEntry appId={STANDALONE_APP_ID} />
								) : hostedStandaloneApp ? (
									<HostedStandaloneAppEntry appId={HOSTED_STANDALONE_APP_ID} />
								) : botProduct ? (
									<BotManagedEntry />
								) : nodeSetupWaiting && !renderedFromNodeSetupCache ? (
									<BootSpinner />
								) : (
									<MemoryRouter
										initialEntries={[
											shouldMountOnboarding ? "/onboarding" : "/chat",
										]}
										key={routerEpoch}
									>
										<Routes>
											<Route
												element={
													<OnboardingRoute
														nodeOnboardingState={nodeOnboardingState}
														nodeOnboardingStateAvailable={
															nodeOnboardingStateAvailable
														}
													/>
												}
												path="/onboarding"
											/>
											<Route element={<Layout />} path="/*" />
										</Routes>
									</MemoryRouter>
								)}
							</Suspense>
						</ProductModeAccessSync>
					</EntitlementProvider>
				</PageWrapper>
			</AuthProvider>
		</MfaEnrollmentGate>
	);
	// In-chat Connect / Install cards act through this host. It is a constant;
	// each card resolves its tab's node where it renders. Only the desktop host
	// provides it (the browser and Telegram hosts never did).
	return hostSurface === "desktop" ? (
		<ConsentHostContext.Provider value={chatConsentHost}>
			{shell}
		</ConsentHostContext.Provider>
	) : (
		shell
	);
}
