declare const window: Window;

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { TOKEN_KEY } from "../../lib/auth-client.ts";
import { NodeOrganizationBindingCard } from "../../src/components/gateway/NodeOrganizationBindingCard.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import { LOCAL_FALLBACK, useNodeStore } from "../../src/store/useNodeStore.ts";
import {
	type BindingRequest,
	bindingInputStringSchema,
	bindingRequestBody,
	bindingRequestsSchema,
} from "../node-binding-proof.contracts.ts";
import styles from "./node-organization-binding-proof.module.css";
import "../../src/index.css";

const LONG_ORGANIZATION_NAME =
	"Acme Research International Applied Intelligence Division with an exceptionally long organization name 0123456789abcdefghijklmnopqrstuvwxyz";

const defaultOrganizations = [
	{
		id: "org-acme",
		name: "Acme Research",
		role: "admin" as const,
	},
	{
		id: "org-personal",
		name: "Personal",
		role: "owner" as const,
	},
];

function jsonResponse<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});
}

localStorage.setItem(TOKEN_KEY, "proof-session");
let permissionAttempts = 0;
const REQUESTS_KEY = "proof:binding-requests";
function requests(): BindingRequest[] {
	return bindingRequestsSchema.parse(
		JSON.parse(sessionStorage.getItem(REQUESTS_KEY) ?? "[]")
	);
}
window.__nodeBindingProof = { requests };

window.fetch = async (input, init) => {
	const inputString = bindingInputStringSchema.safeParse(input);
	const url = inputString.success
		? inputString.data
		: input instanceof Request
			? input.url
			: input.toString();
	const captured = requests();
	captured.push({
		authorization: new Headers(init?.headers).get("authorization"),
		body: bindingRequestBody(init),
		method: init?.method ?? "GET",
		path: new URL(url, window.location.href).pathname,
		query: new URL(url, window.location.href).search,
	});
	sessionStorage.setItem(REQUESTS_KEY, JSON.stringify(captured));
	if (url.endsWith("/api/auth/token")) {
		return jsonResponse({}, 401);
	}
	if (url.includes("/api/control-plane/me/permissions")) {
		permissionAttempts += 1;
		const permissionError = new URL(window.location.href).searchParams.has(
			"permissionsError"
		);
		if (permissionError && permissionAttempts === 1) {
			return jsonResponse({ error: "permission service unavailable" }, 503);
		}
		const readOnly = new URL(window.location.href).searchParams.has("readonly");
		return jsonResponse({
			permissions: readOnly
				? ["gateway.view"]
				: ["gateway.view", "gateway.configure"],
		});
	}
	if (url.endsWith("/api/fleet/status")) {
		const params = new URL(window.location.href).searchParams;
		if (
			sessionStorage.getItem("proof:bound") === "true" ||
			params.has("bound")
		) {
			return jsonResponse({
				enrolled: true,
				managedInferenceReady: true,
				nodeId: "node_studio_7f3a",
				organizationId: "org-acme",
				organizationName: params.has("longName")
					? LONG_ORGANIZATION_NAME
					: "Acme Research",
				status: { state: "active" },
			});
		}
		return jsonResponse({ enrolled: false, status: {} });
	}
	// Issuing an enrollment code asks for an `org.credentials` step-up; this
	// proof covers the binding itself, so the window is already open.
	if (url.includes("/api/step-up/status")) {
		return jsonResponse({
			action: "change or reveal access keys and shared secrets",
			enrolmentRequired: false,
			methods: ["totp"],
			satisfied: true,
			scope: "org.credentials",
			twoFactorEnabled: true,
			windowMs: 600_000,
		});
	}
	if (url.includes("/nodes/enrollment-tokens")) {
		return jsonResponse({
			expiresAt: "2030-08-24T12:10:00.000Z",
			token: `rfe_${"a".repeat(64)}`,
		});
	}
	if (url.endsWith("/api/fleet/enroll") && init?.method === "POST") {
		sessionStorage.setItem("proof:bound", "true");
		if (new URL(window.location.href).searchParams.has("lostEnrollResponse")) {
			throw new TypeError("connection closed after Core saved enrollment");
		}
		return jsonResponse({
			managedInferenceReady: true,
			nodeId: "node_studio_7f3a",
			organizationId: "org-acme",
		});
	}
	return jsonResponse({});
};

useNodeStore.setState({
	defaultNode: LOCAL_FALLBACK.name,
	localNodes: [LOCAL_FALLBACK],
	nodes: [LOCAL_FALLBACK],
});

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

function Proof() {
	const params = new URL(window.location.href).searchParams;
	const organizations = params.has("longName")
		? [
				{ ...defaultOrganizations[0], name: LONG_ORGANIZATION_NAME },
				defaultOrganizations[1],
			]
		: defaultOrganizations;
	return (
		<ThemeProvider
			attribute="class"
			defaultTheme={params.has("light") ? "light" : "dark"}
			enableSystem={false}
		>
			<QueryClientProvider client={queryClient}>
				<EntitlementProvider>
					<TabsProvider>
						<main className="min-h-screen bg-background px-8 py-10 text-foreground">
							<div className="mx-auto flex max-w-3xl flex-col gap-8">
								<header className="flex flex-col gap-2">
									<p
										className={`font-medium text-muted-foreground text-xs uppercase ${styles.eyebrow}`}
									>
										Ryu · Self-hosted Core
									</p>
									<h1 className="font-heading text-3xl tracking-tight">
										Organization access for this node
									</h1>
									<p className="max-w-2xl text-muted-foreground text-sm">
										Bind Fleet management and managed inference in one step.
										Local Gateway keys stay on this machine.
									</p>
								</header>
								<NodeOrganizationBindingCard organizations={organizations} />
							</div>
						</main>
					</TabsProvider>
				</EntitlementProvider>
			</QueryClientProvider>
		</ThemeProvider>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing proof root");
}
createRoot(root).render(<Proof />);
