import { createRoot } from "react-dom/client";
import { NodeOnboardingSettings } from "../../src/components/gateway/NodeOnboardingSettings.tsx";
import "../../src/index.css";

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<main className="min-h-screen bg-background p-8 text-foreground">
			<div className="mx-auto max-w-2xl">
				<NodeOnboardingSettings
					canConfigure
					target={{
						token: "node-onboarding-proof-token",
						url: window.location.origin,
						userJwt: null,
					}}
				/>
			</div>
		</main>
	);
}
