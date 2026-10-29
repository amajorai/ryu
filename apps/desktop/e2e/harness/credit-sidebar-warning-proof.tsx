import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
// Browser proof for the real managed-node wallet row in the desktop sidebar.
// The control-plane and Core responses are deterministic so the product surface
// can be inspected without credentials, a running node, or a live checkout.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { NodeSelector } from "../../src/components/shell/NodeSelector.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { SystemStatusProvider } from "../../src/contexts/SystemStatusContext.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import { LOCAL_FALLBACK, useNodeStore } from "../../src/store/useNodeStore.ts";
import { useSettingsDialog } from "../../src/store/useSettingsDialog.ts";
import "../../src/index.css";

const PROOF_ORG_ID = "org-proof";
const PROOF_NODE = {
	managed: true,
	name: "cloud-proof",
	orgId: PROOF_ORG_ID,
	serverId: "server-proof",
	token: "proof-node-token",
	url: "http://cloud-proof.local:7980",
};

function jsonResponse<FixturePayload>(body: FixturePayload): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status: 200,
	});
}

function streamResponse<FixturePayload>(
	event: string,
	body: FixturePayload
): Response {
	const encoder = new TextEncoder();
	const frame = encoder.encode(
		`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`
	);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(frame);
		},
	});
	return new Response(stream, {
		headers: { "Content-Type": "text/event-stream" },
		status: 200,
	});
}

window.localStorage.setItem("ryu_session_token", "proof-session-token");

window.fetch = async (input) => {
	const rawUrl = isNativeText(input)
		? input
		: input instanceof Request
			? input.url
			: input.toString();
	const path = new URL(rawUrl, window.location.origin).pathname;

	if (path.endsWith("/api/credits/wallet/stream")) {
		return streamResponse("wallet", {
			balanceMicroUsd: 2_000_000,
			currency: "usd",
			id: "wallet-proof",
			ownerId: PROOF_ORG_ID,
			updatedAt: "2026-08-23T08:00:00.000Z",
		});
	}

	if (path.endsWith("/api/credits/wallet")) {
		return jsonResponse({
			ledger: [],
			wallet: {
				balanceMicroUsd: 2_000_000,
				currency: "usd",
				id: "wallet-proof",
				ownerId: PROOF_ORG_ID,
				ownerType: "organization",
				updatedAt: "2026-08-23T08:00:00.000Z",
			},
		});
	}

	if (path.endsWith("/api/billing/subscription-status")) {
		return jsonResponse({
			entitlement: {
				desktopAccess: true,
				managedInference: true,
				monthlyCreditPoolMicroUsd: 50_000_000,
				plan: "teams",
				seats: 5,
			},
			organizationId: PROOF_ORG_ID,
			plan: "teams",
			scope: "org",
			subscription: {
				currentPeriodEnd: "2026-08-31T22:34:00.000Z",
				interval: "month",
				status: "active",
			},
		});
	}

	if (path.endsWith("/api/control-plane/orgs")) {
		return jsonResponse({
			organizations: [
				{
					createdAt: "2026-01-01T00:00:00.000Z",
					id: PROOF_ORG_ID,
					isPersonal: false,
					logo: null,
					name: "A Major",
					role: "owner",
					slug: "a-major",
				},
			],
		});
	}

	if (path.endsWith("/api/auth/get-session")) {
		return jsonResponse({ session: { activeOrganizationId: PROOF_ORG_ID } });
	}

	if (path.endsWith("/api/system/status")) {
		return jsonResponse({
			engine: { active: "managed", running: true },
			gateway: { reachable: true },
			mesh: null,
			sidecars: [
				{ name: "core", running: true },
				{ name: "gateway", running: true },
			],
		});
	}

	return jsonResponse({});
};

useNodeStore.setState({
	defaultNode: PROOF_NODE.name,
	localNodes: [PROOF_NODE, LOCAL_FALLBACK],
	nodes: [PROOF_NODE, LOCAL_FALLBACK],
});

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

function SettingsProbe() {
	const open = useSettingsDialog((state) => state.open);
	const section = useSettingsDialog((state) => state.section);
	return (
		<output className="sr-only" data-testid="settings-probe">
			{open ? `${section}:open` : "closed"}
		</output>
	);
}

function Story() {
	return (
		<ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
			<QueryClientProvider client={queryClient}>
				<EntitlementProvider>
					<TabsProvider>
						<SystemStatusProvider>
							<main className="min-h-screen bg-background p-10 text-foreground">
								<div className="w-80 rounded-xl border border-border/60 bg-sidebar p-4 shadow-sm">
									<p className="mb-3 font-medium text-muted-foreground text-xs uppercase tracking-wider">
										Nodes
									</p>
									<NodeSelector mode="persistent-sidebar" />
								</div>
								<SettingsProbe />
							</main>
						</SystemStatusProvider>
					</TabsProvider>
				</EntitlementProvider>
			</QueryClientProvider>
		</ThemeProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
