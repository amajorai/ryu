import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { OAuthAccountPoolControls } from "@/src/components/settings/OAuthAccountPoolControls.tsx";
import type { PiAccount, PiProvider } from "@/src/lib/api/pi-config.ts";
import "./sdk-account-quota-proof.css";

const supported =
	new URLSearchParams(window.location.search).get("provider") !== "xai";
const providerId = supported ? "openai-codex" : "xai";
const accounts: PiAccount[] = supported
	? [
			{
				accountId: "personal",
				label: "Personal Codex",
				kind: "oauth",
				active: true,
				updatedAt: 0,
			},
			{
				accountId: "work",
				label: "Work Codex",
				kind: "oauth",
				active: false,
				updatedAt: 0,
			},
			{
				accountId: "disabled",
				label: "Disabled Codex",
				kind: "oauth",
				active: false,
				updatedAt: 0,
			},
			{
				accountId: "quarantined",
				label: "Reconnect Codex",
				kind: "oauth",
				active: false,
				needsReauth: true,
				updatedAt: 0,
			},
		]
	: [
			{
				accountId: "key",
				label: "xAI key",
				kind: "api_key",
				active: true,
				updatedAt: 0,
			},
		];
const capabilities: NonNullable<PiProvider["accountRouting"]> = {
	credentialKinds: supported ? ["oauth"] : ["api_key"],
	quotaObservations: supported,
	strategies: supported
		? ["manual", "round_robin", "quota_first", "fill_first", "reset_first"]
		: ["manual", "round_robin", "fill_first"],
};
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={queryClient}>
			<main className="min-h-screen bg-background px-5 py-8 text-foreground sm:px-10">
				<div className="mx-auto max-w-2xl space-y-5">
					<header className="space-y-1">
						<p className="text-muted-foreground text-xs uppercase tracking-wider">
							Gateway · LLM providers
						</p>
						<h1 className="font-semibold text-2xl">
							{supported ? "Codex accounts" : "xAI accounts"}
						</h1>
					</header>
					<OAuthAccountPoolControls
						accounts={accounts}
						capabilities={capabilities}
						providerId={providerId}
					/>
					<p className="text-muted-foreground text-xs">
						Local verification fixture. Credentials stay out of the browser; no
						vendor calls are used.
					</p>
				</div>
			</main>
		</QueryClientProvider>
	);
}
