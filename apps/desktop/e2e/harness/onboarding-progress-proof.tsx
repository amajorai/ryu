import { OnboardingView } from "@ryu/blocks/desktop/onboarding.tsx";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

const root = document.getElementById("root");
if (!root) {
	throw new Error("Onboarding proof root is missing");
}

const theme = new URLSearchParams(window.location.search).get("theme");
const isDark = theme === "dark";
const isIndeterminate =
	new URLSearchParams(window.location.search).get("progress") === "unknown";

createRoot(root).render(
	<div
		className={`${isDark ? "dark" : ""} h-screen w-screen bg-background text-foreground`}
		data-testid={`theme-${isDark ? "dark" : "light"}`}
	>
		<OnboardingView
			progress={isIndeterminate ? undefined : 42}
			step="installing"
			subtitle="Preparing your workspace"
			title="Setting things up"
		/>
	</div>
);
