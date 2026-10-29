import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { DEFAULT_THEME_MODE } from "@ryu/ui/theme/prefs.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { AppSurfaceProvider } from "@/src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "@/src/contexts/entitlement-context.tsx";
import {
	DESKTOP_ONBOARDING_COMPLETE_KEY,
	DESKTOP_ONBOARDING_PHASE_KEY,
} from "@/src/lib/desktop-onboarding-state.ts";
import { onboardingInitialTab } from "@/src/lib/onboarding-navigation.ts";
import OnboardingPage from "@/src/pages/OnboardingPage.tsx";
import { LOCAL_FALLBACK, useNodeStore } from "@/src/store/useNodeStore.ts";
import "../../src/index.css";

declare global {
	interface Window {
		__onboardingHandoff?: {
			pathname: string;
			state: unknown;
			initialTab: ReturnType<typeof onboardingInitialTab>;
		};
	}
}

function HandoffProbe() {
	const location = useLocation();
	window.__onboardingHandoff = {
		pathname: location.pathname,
		state: location.state,
		initialTab: onboardingInitialTab(location.state),
	};
	return null;
}

if (!localStorage.getItem(DESKTOP_ONBOARDING_PHASE_KEY)) {
	localStorage.setItem(DESKTOP_ONBOARDING_PHASE_KEY, "first-project");
}
localStorage.removeItem(DESKTOP_ONBOARDING_COMPLETE_KEY);

const target = {
	name: "First project proof node",
	token: "first-project-integration-node-token",
	url: window.location.origin,
	userJwt: null,
};
useNodeStore.setState({
	defaultNode: target.name,
	localNodes: [LOCAL_FALLBACK],
	nodes: [LOCAL_FALLBACK, target],
});

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

createRoot(document.getElementById("root")!).render(
	<div className="h-screen w-screen">
		<QueryClientProvider client={queryClient}>
			<ThemeProvider
				attribute="class"
				defaultTheme={DEFAULT_THEME_MODE}
				enableSystem
				themes={["light", "dark", "system"]}
			>
				<Toaster position="bottom-right" theme="system" />
				<MemoryRouter initialEntries={["/onboarding"]}>
					<HandoffProbe />
					<AppSurfaceProvider surface="desktop">
						<EntitlementProvider>
							<OnboardingPage
								nodeOnboardingState={null}
								nodeOnboardingStateAvailable={false}
							/>
						</EntitlementProvider>
					</AppSurfaceProvider>
				</MemoryRouter>
			</ThemeProvider>
		</QueryClientProvider>
	</div>
);
