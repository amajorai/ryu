import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { OnboardingPrismBackground } from "../../src/components/onboarding/OnboardingPrismBackground.tsx";
import { WelcomeStep } from "../../src/components/onboarding/WelcomeStep.tsx";
import {
	persistDesktopOnboardingPhase,
	resolveDesktopOnboardingPhase,
} from "../../src/lib/desktop-onboarding-state.ts";
import "../../src/index.css";

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
			<output className="sr-only" data-testid="onboarding-status">
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
const forcedTheme =
	new URLSearchParams(window.location.search).get("theme") === "dark"
		? "dark"
		: undefined;
if (root) {
	createRoot(root).render(
		<ThemeProvider
			attribute="class"
			defaultTheme="light"
			enableSystem={false}
			forcedTheme={forcedTheme}
		>
			<Story />
		</ThemeProvider>
	);
}
