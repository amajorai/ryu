import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { NetworkSettings } from "../../src/components/settings/NetworkSettings.tsx";
import "../../src/index.css";

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const requestUrl = input instanceof Request ? input.url : String(input);
	const pathname = new URL(requestUrl, window.location.origin).pathname;
	const headers = { "content-type": "application/json" };

	if (pathname === "/api/mesh/status") {
		return new Response(
			JSON.stringify({
				backend: null,
				backend_state: "Stopped",
				enabled: false,
				peers: [],
				reachable: false,
				tailscale_ips: [],
			}),
			{ headers, status: 200 }
		);
	}
	if (
		pathname === "/api/preferences/mesh-backend" ||
		pathname === "/api/preferences/mesh-login-server"
	) {
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
						No-install private networking
					</h1>
					<p className="mt-2 text-muted-foreground text-sm">
						Fresh-node state with no saved tunnel preference. The settings
						surface should select Tailcat and explain that Ryu installs the
						client automatically.
					</p>
				</header>
				<NetworkSettings />
			</div>
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
