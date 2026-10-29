import { Button } from "@ryu/ui/components/button.tsx";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProviderPoolsEditor } from "@/src/components/gateway/ProviderPoolsEditor.tsx";
import {
	fetchGatewayConfig,
	type GatewayConfig,
	type GatewayRoutingConfig,
	PROVIDER_POOL_STRATEGIES,
	updateGatewayConfig,
} from "@/src/lib/api/gateway.ts";
import "@/src/index.css";

const initialPools: NonNullable<GatewayRoutingConfig["provider_pools"]> = {
	balanced: {
		strategy: "round_robin",
		members: [
			{
				provider: "openai",
				model: "gpt-4o-mini",
				priority: 0,
				weight: 1,
				enabled: true,
			},
			{
				provider: "anthropic",
				model: "claude-haiku-4-5",
				priority: 0,
				weight: 1,
				enabled: true,
			},
		],
	},
};

function Story() {
	const [pools, setPools] = useState(initialPools);
	const native = new URLSearchParams(window.location.search).has("native");
	const [config, setConfig] = useState<GatewayConfig | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [dispatchResult, setDispatchResult] = useState<string | null>(null);
	const target = { url: window.location.origin, token: null };
	useEffect(() => {
		if (!native) {
			return;
		}
		let active = true;
		fetchGatewayConfig({ url: window.location.origin, token: null })
			.then((value) => {
				if (active) {
					setConfig(value);
					setPools(value.routing.provider_pools ?? {});
				}
			})
			.catch((error) => {
				if (active) {
					setLoadError(
						error instanceof Error
							? error.message
							: "Runtime configuration unavailable"
					);
				}
			});
		return () => {
			active = false;
		};
	}, [native]);
	return (
		<main className="min-h-screen bg-background px-5 py-8 text-foreground sm:px-10">
			<div className="mx-auto max-w-4xl space-y-5">
				<header className="space-y-1">
					<p className="text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						Gateway · Routing
					</p>
					<h1 className="font-semibold text-2xl">Provider pool routing</h1>
				</header>
				{loadError ? (
					<p role="alert">{loadError}</p>
				) : native && config === null ? (
					<p role="status">Loading runtime configuration…</p>
				) : (
					<ProviderPoolsEditor
						disabled={false}
						modelMap={
							native
								? (config?.routing.model_map ?? {})
								: { "balanced-chat": { provider: "pool:balanced" } }
						}
						onSave={async (name, pool) => {
							if (native) {
								const latest = await fetchGatewayConfig(target);
								if (latest.routing.provider_pools === undefined) {
									throw new Error("Runtime does not expose provider pools");
								}
								const provider_pools = { ...latest.routing.provider_pools };
								if (pool) {
									provider_pools[name] = pool;
								} else {
									delete provider_pools[name];
								}
								await updateGatewayConfig(target, {
									routing: { ...latest.routing, provider_pools },
								});
								const saved = await fetchGatewayConfig(target);
								setConfig(saved);
								setPools(saved.routing.provider_pools ?? {});
								return;
							}
							setPools((current) => {
								const next = { ...current };
								if (pool) {
									next[name] = pool;
								} else {
									delete next[name];
								}
								return next;
							});
						}}
						pools={pools}
						providers={
							native
								? config?.providers.openai
									? ["openai"]
									: []
								: ["openai", "anthropic", "mistral", "together"]
						}
						supportedStrategies={
							native
								? config?.strategyCapabilities?.chat
								: PROVIDER_POOL_STRATEGIES
						}
					/>
				)}
				{native && config ? (
					<section
						aria-label="Loopback request result"
						className="space-y-3 rounded-md border border-border bg-card p-4"
					>
						<Button
							onClick={async () => {
								const response = await fetch("/proof/chat/completions", {
									method: "POST",
									headers: { "Content-Type": "application/json" },
									body: JSON.stringify({
										model: "balanced-chat",
										messages: [
											{ role: "user", content: "Local routing proof" },
										],
										stream: false,
									}),
								});
								const value: {
									choices?: { message?: { content?: string } }[];
									error?: { message?: string };
								} = await response.json();
								setDispatchResult(
									response.ok
										? (value.choices?.[0]?.message?.content ??
												"No response content")
										: (value.error?.message ?? "Loopback request failed")
								);
							}}
						>
							Send loopback test
						</Button>
						{dispatchResult ? <p role="status">{dispatchResult}</p> : null}
					</section>
				) : null}
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
