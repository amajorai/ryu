import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { WorktreesSection } from "../../src/components/gateway/WorktreesSection.tsx";
import type { GatewayGovernanceSnapshot } from "../../src/lib/api/governance.ts";
import "../../src/index.css";

const PREFERENCE_KEY = "threads-worktree-isolate-by-default";
const PROOF_STORAGE_KEY = "proof-coordinator-worktree-isolation-default";
const TARGET = { token: null, url: window.location.origin };

const governance: GatewayGovernanceSnapshot = {
	layers: [
		{
			revision: 1,
			scope: "node",
			values: {
				worktrees: {
					autoDelete: true,
					autoDeleteLimit: 15,
					fetchUpstream: false,
					root: "",
				},
			},
			writable: true,
		},
		{ revision: 1, scope: "organization", values: {}, writable: false },
		{ revision: 1, scope: "team", values: {}, writable: false },
		{ revision: 1, scope: "user", values: {}, writable: true },
	],
	schemaVersion: 1,
};

function jsonResponse<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});
}

window.fetch = async (input, init) => {
	const requestUrl =
		input instanceof Request
			? input.url
			: input instanceof URL
				? input.href
				: input;
	const url = new URL(requestUrl);
	const method = (init?.method ?? "GET").toUpperCase();

	if (url.pathname === "/api/gateway/governance") {
		return jsonResponse(governance);
	}
	if (url.pathname === `/api/preferences/${PREFERENCE_KEY}`) {
		if (method === "PUT") {
			const body = z
				.object({ value: z.string() })
				.safeParse(JSON.parse(isNativeText(init?.body) ? init.body : "{}"));
			if (body.success) {
				sessionStorage.setItem(PROOF_STORAGE_KEY, body.data.value);
			}

			return jsonResponse({ ok: true });
		}

		const value = sessionStorage.getItem(PROOF_STORAGE_KEY);
		return value === null
			? jsonResponse({ error: "preference not set" }, 404)
			: jsonResponse({ key: PREFERENCE_KEY, value });
	}

	return jsonResponse({});
};

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

function Proof() {
	return (
		<ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
			<QueryClientProvider client={queryClient}>
				<main className="min-h-screen bg-background px-8 py-10 text-foreground">
					<div className="mx-auto max-w-5xl">
						<WorktreesSection canConfigure target={TARGET} />
					</div>
				</main>
			</QueryClientProvider>
		</ThemeProvider>
	);
}

createRoot(document.getElementById("root")!).render(<Proof />);
