import { DEFAULT_THEME_MODE } from "@ryu/ui/theme/prefs.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AppSurfaceProvider } from "@/src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "@/src/contexts/entitlement-context.tsx";
import {
	DESKTOP_ONBOARDING_COMPLETE_KEY,
	DESKTOP_ONBOARDING_PHASE_KEY,
} from "@/src/lib/desktop-onboarding-state.ts";
import OnboardingPage from "@/src/pages/OnboardingPage.tsx";
import { LOCAL_FALLBACK, useNodeStore } from "@/src/store/useNodeStore.ts";
import "../../src/index.css";

if (!localStorage.getItem(DESKTOP_ONBOARDING_PHASE_KEY)) {
	localStorage.setItem(DESKTOP_ONBOARDING_PHASE_KEY, "skills");
}
localStorage.setItem("ryu_session_token", "onboarding-fixture-session");
localStorage.removeItem(DESKTOP_ONBOARDING_COMPLETE_KEY);

const target = {
	name: "Setup proof node",
	token: "setup-proof-node-token",
	url: window.location.origin,
	userJwt: null,
};

useNodeStore.setState({
	defaultNode: target.name,
	localNodes: [LOCAL_FALLBACK],
	nodes: [LOCAL_FALLBACK, target],
});

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { retry: false },
	},
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
				<MemoryRouter initialEntries={["/onboarding"]}>
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
