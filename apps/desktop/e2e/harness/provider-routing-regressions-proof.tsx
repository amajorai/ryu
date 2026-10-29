import { Toaster } from "@ryu/ui/components/sileo.tsx";
import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { RyuPiConfig } from "../../src/components/agents/RyuPiConfig.tsx";
import { ProviderRow } from "../../src/components/gateway/GatewayProviderKeyRow.tsx";
import { OAuthAccountPoolControls } from "../../src/components/settings/OAuthAccountPoolControls.tsx";
import {
	configureGatewayProviderAccount,
	fetchGatewayConfig,
} from "../../src/lib/api/gateway.ts";
import type { PiAccount } from "../../src/lib/api/pi-config.ts";
import "../../src/index.css";

const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const target = { url: window.location.origin, token: null, userJwt: null };
// Test instrumentation refreshes the real query after the mock Core switches
// catalog accounts. No replacement UI or discovery hook participates.
window.addEventListener("proof:refresh-provider-catalog", () => {
	client
		.invalidateQueries({ queryKey: ["pi-config-catalog", target.url] })
		.catch(() => undefined);
});

const oauthAccounts: PiAccount[] = [
	{
		accountId: "claude-work",
		label: "Work Claude",
		kind: "oauth",
		active: true,
		gatewayActive: false,
	},
];
const unusedWriter = async () => {
	throw new Error("Credential mutations are outside this proof");
};
function Proof() {
	const gateway = useQuery({
		queryKey: ["proof-gateway"],
		queryFn: () => fetchGatewayConfig(target),
	});
	return (
		<main className="min-h-screen bg-background px-6 py-8 text-foreground">
			<div className="mx-auto max-w-3xl space-y-8">
				<h1 className="font-semibold text-2xl">Provider routing</h1>
				<section aria-label="Pi discovery">
					<RyuPiConfig />
				</section>
				<section aria-label="Gateway accounts">
					<h2 className="mb-4 font-medium text-lg">Gateway accounts</h2>
					<ProviderRow
						accountCount={1}
						accounts={gateway.data?.providers.accounts?.openai ?? []}
						canConfigure
						isSet
						label="OpenAI"
						onAdd={unusedWriter}
						onClear={unusedWriter}
						onConfigure={async (slug, account) => {
							await configureGatewayProviderAccount(target, slug, account);
							await client.invalidateQueries({ queryKey: ["proof-gateway"] });
						}}
						onRemove={unusedWriter}
						onSave={unusedWriter}
						placeholder="API key"
						quotaRouting
						slug="openai"
					/>
				</section>
				<section aria-label="Claude account routing">
					<h2 className="mb-4 font-medium text-lg">Claude account routing</h2>
					<OAuthAccountPoolControls
						accounts={oauthAccounts}
						capabilities={{
							credentialKinds: ["oauth"],
							quotaObservations: true,
							strategies: [
								"manual",
								"round_robin",
								"quota_first",
								"fill_first",
								"reset_first",
							],
						}}
						providerId="claude-pro-max"
					/>
				</section>
			</div>
		</main>
	);
}
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={client}>
			<Toaster position="bottom-right" theme="system" />
			<Proof />
		</QueryClientProvider>
	);
}
