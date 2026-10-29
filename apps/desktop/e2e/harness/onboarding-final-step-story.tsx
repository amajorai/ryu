import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { OnboardingGuidanceStep } from "../../src/components/onboarding/OnboardingGuidanceStep.tsx";
import { PrivacyStep } from "../../src/components/onboarding/PrivacyStep.tsx";
import "../../src/index.css";

const originalFetch = window.fetch.bind(window);

// Keep this story deterministic while exercising the real PrivacyStep component.
// The production component still uses the canonical Core preference API; the story
// only supplies its four preference reads/writes so the visual proof has no live
// service dependency.
window.fetch = async (input, init) => {
	const requestUrl = new URL(
		isNativeText(input)
			? input
			: input instanceof Request
				? input.url
				: input.toString(),
		window.location.href
	);
	if (requestUrl.pathname.includes("/api/preferences/")) {
		const key = decodeURIComponent(requestUrl.pathname.split("/").pop() ?? "");
		const method = init?.method?.toUpperCase() ?? "GET";
		if (method === "GET") {
			return new Response(
				JSON.stringify({
					key,
					value: key === "diagnostics-export-enabled" ? "false" : "true",
				}),
				{ headers: { "Content-Type": "application/json" }, status: 200 }
			);
		}
		return new Response(JSON.stringify({ key, value: "true" }), {
			headers: { "Content-Type": "application/json" },
			status: 200,
		});
	}
	return originalFetch(input, init);
};

function Story() {
	const [completed, setCompleted] = useState(false);
	const [showPrivacy, setShowPrivacy] = useState(false);

	return (
		<main
			className="h-screen overflow-hidden bg-background text-foreground"
			data-testid="onboarding-final-step-proof"
		>
			{showPrivacy ? (
				<PrivacyStep onContinue={() => setCompleted(true)} />
			) : (
				<OnboardingGuidanceStep onContinue={() => setShowPrivacy(true)} />
			)}
			<output className="sr-only" data-testid="onboarding-status">
				{completed ? "completed" : "active"}
			</output>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
