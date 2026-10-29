import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

localStorage.setItem(DESKTOP_ONBOARDING_PHASE_KEY, "skills");
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
	<QueryClientProvider client={queryClient}>
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
	</QueryClientProvider>
);
