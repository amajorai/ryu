import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProviderRow } from "../../src/components/gateway/GatewayProviderKeyRow.tsx";
import { SettingsSection } from "../../src/components/settings/shared/settings-items.tsx";
import {
	configureGatewayProviderAccount,
	type GatewayProviderAccount,
} from "../../src/lib/api/gateway.ts";
import "../../src/index.css";

function Story() {
	const requested = new URLSearchParams(window.location.search).get("provider");
	const slug =
		requested === "runway" ||
		requested === "topaz" ||
		requested === "minimax" ||
		requested === "bfl" ||
		requested === "stability" ||
		requested === "recraft" ||
		requested === "modal" ||
		requested === "replicate" ||
		requested === "fal"
			? requested
			: "gemini";
	const label =
		slug === "runway"
			? "Runway"
			: slug === "topaz"
				? "Topaz Labs"
				: slug === "minimax"
					? "MiniMax"
					: slug === "bfl"
						? "Black Forest Labs"
						: slug === "stability"
							? "Stability AI"
							: slug === "recraft"
								? "Recraft"
								: slug === "modal"
									? "Modal"
									: slug === "replicate"
										? "Replicate"
										: slug === "fal"
											? "Fal"
											: "Gemini";
	const [keys, setKeys] = useState(["first-secret", "second-secret"]);
	const named = new URLSearchParams(window.location.search).has("named");
	const live = new URLSearchParams(window.location.search).has("live");
	const [policies, setPolicies] = useState<
		Record<string, GatewayProviderAccount>
	>(() => JSON.parse(localStorage.getItem("proof-account-policies") ?? "{}"));
	const accounts = keys.map((key, index) => {
		const id =
			key === "first-secret"
				? "a".repeat(64)
				: key === "second-secret"
					? "b".repeat(64)
					: "c".repeat(64);
		return (
			policies[id] ?? {
				id,
				name: `Account ${index + 1}`,
				enabled: true,
				priority: 0,
			}
		);
	});
	return (
		<main className="min-h-screen bg-background px-5 py-8 text-foreground sm:px-10">
			<div className="mx-auto max-w-4xl space-y-5">
				<header className="space-y-1">
					<p className="text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
						Gateway · Keys
					</p>
					<h1 className="font-semibold text-2xl">Upstream provider accounts</h1>
					{live ? (
						<p className="text-muted-foreground text-sm">
							Account settings apply without reconnecting Gateway.
						</p>
					) : null}
				</header>
				<SettingsSection
					caption={`Provider keys authenticate calls from Ryu to ${label}. Gateway client keys are managed separately.`}
					title="Provider keys (BYOK)"
				>
					<ProviderRow
						accountCount={keys.length}
						accounts={named ? accounts : undefined}
						isSet={keys.length > 0}
						label={label}
						onAdd={async (_slug, key) =>
							setKeys((current) => [...current, key])
						}
						onClear={async () => setKeys([])}
						onConfigure={
							named
								? async (_slug, account) => {
										if (live) {
											await configureGatewayProviderAccount(
												{
													url: window.location.origin,
													token: null,
													userJwt: null,
												},
												slug,
												account
											);
										}
										const next = { ...policies, [account.id]: account };
										localStorage.setItem(
											"proof-account-policies",
											JSON.stringify(next)
										);
										setPolicies(next);
									}
								: undefined
						}
						onRemove={async (_slug, index) =>
							setKeys((current) => current.filter((_, at) => at !== index))
						}
						onSave={async (_slug, key) =>
							setKeys((current) => [key, ...current.slice(1)])
						}
						placeholder={
							slug === "modal"
								? "Deployment bearer token"
								: slug === "replicate"
									? "r8_…"
									: "AIza…"
						}
						slug={slug}
					/>
				</SettingsSection>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
