import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { NetworkSettings } from "../../src/components/settings/NetworkSettings.tsx";
import { type ProofJsonValue, parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

const realFetch = window.fetch.bind(window);
const cloudflaredStory = new URLSearchParams(location.search).has(
	"cloudflared"
);
const enabledStorageKey = "mesh-auto-install-proof.enabled";
const loginServerStorageKey = "mesh-auto-install-proof.login-server";
const initialEnabled = localStorage.getItem(enabledStorageKey) === "true";
const fixtureUrl = new URL(window.location.href);
const backend = cloudflaredStory
	? "cloudflared"
	: (fixtureUrl.searchParams.get("backend") ?? "tailcat");
const initialLoginServer =
	localStorage.getItem(loginServerStorageKey) ??
	fixtureUrl.searchParams.get("loginServer") ??
	"";
interface MeshProofCapturedState {
	backend: string;
	enabled: boolean;
	failNextWrite: boolean;
	failPreferenceWrite: boolean;
	loginServer: string;
	requests: Array<{ body: unknown; method: string; path: string }>;
}

const state: MeshProofCapturedState = {
	backend,
	enabled: cloudflaredStory || initialEnabled,
	failNextWrite: false,
	failPreferenceWrite:
		fixtureUrl.searchParams.get("failPreferenceWrite") === "true",
	loginServer: initialLoginServer,
	requests: [],
};

declare global {
	interface Window {
		__meshProof: typeof state;
	}
}

window.__meshProof = state;
window.fetch = async (input, init) => {
	const requestUrl = input instanceof Request ? input.url : String(input);
	const url = new URL(requestUrl, window.location.origin);
	const pathname = url.pathname;
	const method = (
		init?.method ?? (input instanceof Request ? input.method : "GET")
	).toUpperCase();
	let body: ProofJsonValue = null;
	if (isNativeText(init?.body)) {
		try {
			body = parseProofJson(init.body);
		} catch {
			body = init.body;
		}
	}
	if (pathname.startsWith("/api/")) {
		state.requests.push({ body, method, path: pathname });
	}
	const headers = { "content-type": "application/json" };

	if (pathname === "/api/mesh/status") {
		return new Response(
			JSON.stringify(
				cloudflaredStory
					? {
							backend: "cloudflared",
							backend_state: "Running",
							cloudflaredUrl: "https://warm-tree.trycloudflare.com",
							enabled: true,
							peers: [],
							reachable: true,
							tailscale_ips: [],
							up: true,
						}
					: {
							backend: state.backend,
							backend_state: state.enabled ? "Running" : "Stopped",
							enabled: state.enabled,
							peers: [],
							reachable: state.enabled,
							tailcat_address:
								state.enabled && state.backend === "tailcat"
									? "tailcat://node-proof-secret"
									: null,
							tailscale_ips: [],
						}
			),
			{ headers, status: 200 }
		);
	}
	if (pathname === "/api/mesh/config" && init?.method === "POST") {
		if (state.failNextWrite) {
			state.failNextWrite = false;
			return new Response(JSON.stringify({ error: "mesh unavailable" }), {
				headers,
				status: 500,
			});
		}
		const body = z
			.object({ enabled: z.boolean().optional() })
			.parse(JSON.parse(String(init.body ?? "{}")));
		state.enabled = body.enabled === true;
		localStorage.setItem(enabledStorageKey, String(state.enabled));
		return new Response(
			JSON.stringify({
				backend: state.backend,
				backend_state: state.enabled ? "Running" : "Stopped",
				enabled: state.enabled,
				peers: [],
				reachable: state.enabled,
				tailcat_address:
					state.enabled && state.backend === "tailcat"
						? "tailcat://node-proof-secret"
						: null,
				tailscale_ips: [],
			}),
			{ headers, status: 200 }
		);
	}
	if (pathname === "/api/preferences/mesh-backend") {
		return new Response(
			JSON.stringify({ key: "mesh-backend", value: state.backend }),
			{
				headers,
				status: 200,
			}
		);
	}
	if (pathname === "/api/preferences/mesh-login-server") {
		if (init?.method === "PUT") {
			if (state.failPreferenceWrite) {
				return new Response(
					JSON.stringify({ error: "preference write denied" }),
					{
						headers,
						status: 500,
					}
				);
			}
			const body = z
				.object({ value: z.string().optional() })
				.parse(JSON.parse(String(init.body ?? "{}")));
			state.loginServer = body.value ?? "";
			localStorage.setItem(loginServerStorageKey, state.loginServer);
			return new Response(JSON.stringify({ ok: true }), {
				headers,
				status: 200,
			});
		}
		return new Response(
			JSON.stringify({ key: "mesh-login-server", value: state.loginServer }),
			{ headers, status: 200 }
		);
	}
	if (pathname.startsWith("/api/preferences/")) {
		return new Response(JSON.stringify({ error: "preference_not_set" }), {
			headers,
			status: 404,
		});
	}
	if (pathname.startsWith("/api/")) {
		return new Response(JSON.stringify({ error: "not_found" }), {
			headers,
			status: 404,
		});
	}

	return realFetch(input, init);
};

function ProofSurface() {
	return (
		<main className="min-h-screen bg-background p-8 text-foreground">
			<div className="mx-auto flex max-w-3xl flex-col gap-5">
				<header className="rounded-2xl border bg-card p-6 shadow-sm">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						Network setup verification
					</p>
					<h1 className="mt-2 font-semibold text-2xl">
						{cloudflaredStory
							? "Cloudflare Quick Tunnel status"
							: "No-install private networking"}
					</h1>
					<p className="mt-2 text-muted-foreground text-sm">
						{cloudflaredStory
							? "An active Cloudflare Quick Tunnel. The settings surface should show the temporary public URL and explain who can reach it."
							: "Fresh-node state with no saved tunnel preference. The settings surface should select Tailcat and explain that Ryu installs the client automatically."}
					</p>
				</header>
				<NetworkSettings />
			</div>
			<Toaster position="bottom-right" />
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	document.documentElement.classList.add("light");
	createRoot(root).render(
		<QueryClientProvider client={queryClient}>
			<ProofSurface />
		</QueryClientProvider>
	);
	document.body.dataset.harnessReady = "true";
}
