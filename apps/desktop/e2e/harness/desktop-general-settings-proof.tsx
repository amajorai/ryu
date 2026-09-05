import { I18nProvider } from "@ryu/i18n/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { GeneralTab } from "../../src/components/settings/GeneralTab.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import type {
	GatewayAcpConfig,
	GatewayConfig,
	GatewayConfigPatch,
} from "../../src/lib/api/gateway.ts";
import "../../src/index.css";

const INITIAL_ACP: GatewayAcpConfig = {
	active_agents: 1,
	auto_max_parallel_agents: 2,
	effective_max_parallel_agents: 2,
	hardware: {
		cpu_cores: 8,
		physical_cores: 4,
		total_ram_bytes: 16 * 1024 ** 3,
	},
	idle_timeout_minutes: 10,
	keep_computer_awake: true,
	max_parallel_agents: null,
};

let gatewayConfig = { acp: INITIAL_ACP } as GatewayConfig;

function installGatewayMock(): () => void {
	const nativeFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		if (!url.endsWith("/api/gateway/config")) {
			return nativeFetch(input, init);
		}

		if ((init?.method ?? "GET").toUpperCase() === "PUT") {
			const patch = JSON.parse(
				typeof init.body === "string" ? init.body : "{}"
			) as GatewayConfigPatch;
			if (patch.acp) {
				gatewayConfig = {
					...gatewayConfig,
					acp: { ...gatewayConfig.acp, ...patch.acp },
				};
			}
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "content-type": "application/json" },
				status: 200,
			});
		}

		return new Response(JSON.stringify(gatewayConfig), {
			headers: { "content-type": "application/json" },
			status: 200,
		});
	};
	return () => {
		window.fetch = nativeFetch;
	};
}

function ProofSurface() {
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: { queries: { retry: false } },
			}),
		[]
	);

	useEffect(() => installGatewayMock(), []);

	return (
		<QueryClientProvider client={queryClient}>
			<AppSurfaceProvider surface="desktop">
				<I18nProvider>
					<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
						<main
							className="min-h-dvh bg-background p-8 text-foreground"
							data-testid="desktop-general-settings-proof"
						>
							<div className="mx-auto flex max-w-5xl flex-col gap-6">
								<header className="rounded-2xl border bg-card p-6 shadow-sm">
									<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
										Desktop settings verification
									</p>
									<h1 className="mt-2 font-semibold text-2xl">
										General preferences
									</h1>
									<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
										The live Desktop settings surface, including persisted
										workspace defaults and the active node's keep-awake policy.
									</p>
								</header>
								<section className="rounded-2xl border bg-card p-6 shadow-sm">
									<GeneralTab />
								</section>
							</div>
						</main>
					</ThemeProvider>
				</I18nProvider>
			</AppSurfaceProvider>
		</QueryClientProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<MemoryRouter>
			<ProofSurface />
		</MemoryRouter>
	);
}
