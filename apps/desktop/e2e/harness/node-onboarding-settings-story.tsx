import { createRoot } from "react-dom/client";
import { NodeOnboardingSettings } from "../../src/components/gateway/NodeOnboardingSettings.tsx";
import "../../src/index.css";

const state = {
	canConfigure: true,
	completed: true,
	completedAtMs: 1_788_339_063_780,
	personalization: {
		companyContext: "We build reviewable finance tools for operations teams.",
		companyKnowledgeEnabled: true,
	},
	setupKind: "team" as const,
	version: 1,
};

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
	if (String(input).includes("/api/onboarding/state")) {
		if (init?.method === "DELETE") {
			return Response.json({
				...state,
				completed: false,
				completedAtMs: null,
				personalization: {
					companyContext: "",
					companyKnowledgeEnabled: false,
				},
				setupKind: null,
			});
		}
		return Response.json(state);
	}
	return originalFetch(input, init);
}) as typeof globalThis.fetch;

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<main className="min-h-screen bg-background p-8 text-foreground">
			<div className="mx-auto max-w-2xl">
				<NodeOnboardingSettings
					canConfigure
					target={{
						token: null,
						url: "http://127.0.0.1:8987",
						userJwt: null,
					}}
				/>
			</div>
		</main>
	);
}
