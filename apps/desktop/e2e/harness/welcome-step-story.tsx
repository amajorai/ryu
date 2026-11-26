import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LanguagePackBridge } from "../../src/components/LanguagePackBridge.tsx";
import { OnboardingPrismBackground } from "../../src/components/onboarding/OnboardingPrismBackground.tsx";
import { WelcomeStep } from "../../src/components/onboarding/WelcomeStep.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import {
	persistDesktopOnboardingPhase,
	resolveDesktopOnboardingPhase,
} from "../../src/lib/desktop-onboarding-state.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

// The language provider reads installed packs from the active node. Point it at
// this page's own origin, which has none, so the story never leaves the proof
// server and lists the built-in languages only.
useNodeStore.setState({
	autoSelect: false,
	defaultNode: "welcome-proof",
	nodes: [
		{
			name: "welcome-proof",
			url: window.location.origin,
			token: "welcome-proof-node",
		},
	],
});

function Story() {
	const [completed, setCompleted] = useState(false);
	const [phase, setPhase] = useState(() =>
		resolveDesktopOnboardingPhase({
			desktopPending: true,
			nodePending: true,
		})
	);
	const resumeProofEnabled = new URLSearchParams(window.location.search).has(
		"resume-proof"
	);

	const simulatePermissionHandoff = () => {
		persistDesktopOnboardingPhase("mic");
		setPhase("mic");
	};

	return (
		<main
			className="h-screen bg-background text-foreground"
			data-testid="welcome-step-proof"
		>
			<OnboardingPrismBackground>
				<WelcomeStep onContinue={() => setCompleted(true)} />
			</OnboardingPrismBackground>
			{/* A machine-read marker for the spec, so it stays out of translation. */}
			<output
				className="sr-only"
				data-ryu-i18n="off"
				data-testid="onboarding-status"
			>
				{completed ? "completed" : "active"}
			</output>
			{resumeProofEnabled ? (
				<div className="sr-only">
					<output data-testid="onboarding-phase">{phase}</output>
					<button onClick={simulatePermissionHandoff} type="button">
						Simulate macOS permission handoff
					</button>
				</div>
			) : null}
		</main>
	);
}

const root = document.getElementById("root");
const storyParams = new URLSearchParams(window.location.search);
const forcedTheme = storyParams.get("theme") === "dark" ? "dark" : undefined;
// The desktop window draws native controls in a top corner and the language
// control clears them; `?surface=web` is the browser, which has none.
const surface = storyParams.get("surface") === "web" ? "web" : "desktop";
if (root) {
	// next-themes 0.4 derives `resolvedTheme` from the stored theme and ignores
	// `forcedTheme`, so `?theme=dark` must also seed the default for the backdrop
	// (which reads `resolvedTheme`) to pick its dark variant.
	createRoot(root).render(
		<ThemeProvider
			attribute="class"
			defaultTheme={forcedTheme ?? "light"}
			enableSystem={false}
			forcedTheme={forcedTheme}
		>
			<AppSurfaceProvider surface={surface}>
				<LanguagePackBridge>
					<Story />
				</LanguagePackBridge>
			</AppSurfaceProvider>
		</ThemeProvider>
	);
}
