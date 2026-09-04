import { useState } from "react";
import { createRoot } from "react-dom/client";
import { NodePersonalizationStep } from "../../src/components/onboarding/NodePersonalizationStep.tsx";
import type { SaveNodeOnboardingStateInput } from "../../src/lib/api/onboarding-profile.ts";
import { DEFAULT_USER_PERSONALIZATION } from "../../src/lib/api/preferences.ts";
import "../../src/index.css";

function Story() {
	const [saved, setSaved] = useState<SaveNodeOnboardingStateInput | null>(null);

	return (
		<main className="h-screen bg-background text-foreground">
			<NodePersonalizationStep
				companyContext=""
				initialPersonalization={DEFAULT_USER_PERSONALIZATION}
				initialSetupKind="team"
				onContinue={(input) => setSaved(input)}
			/>
			<output className="sr-only" data-testid="node-personalization-status">
				{saved ? `saved: ${saved.setupKind}` : "active"}
			</output>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
