"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Label } from "@ryu/ui/components/label.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useId } from "react";
import type {
	ApiKeyFallback,
	ProviderCredential,
} from "@/src/lib/api/provider-credentials.ts";

interface Props {
	/** True while a change is being saved. */
	busy?: boolean;
	fallback: ApiKeyFallback;
	/** Display name of the provider the API keys belong to. */
	keyProviderLabel: string;
	onChange: (enabled: boolean) => void;
}

/** What one fallback key is doing right now, in plain words. */
function keyState(
	key: ProviderCredential
): "off" | "limited" | "rejected" | "ready" {
	if (!key.enabled) {
		return "off";
	}
	return key.resting ?? "ready";
}

/**
 * "Use API keys when subscription accounts run out": off by default, because
 * API keys cost money per request. When on, the keys that would take over are
 * listed in the order they are tried.
 */
export function ApiKeyFallbackSetting({
	busy = false,
	fallback,
	keyProviderLabel,
	onChange,
}: Props) {
	const tl = useLiteralMessages();
	const id = useId();
	if (!fallback.supported) {
		return null;
	}
	const stateText = {
		off: tl("Turned off"),
		limited: tl("At its limit, waiting"),
		rejected: tl("Refused by the provider, will be tried again"),
		ready: tl("Ready"),
	};
	return (
		<section
			className="space-y-2 border-border border-t pt-3"
			data-slot="api-key-fallback"
		>
			<div className="flex items-center justify-between gap-6">
				<div className="flex min-w-0 flex-col gap-0.5">
					<Label htmlFor={id} size="compact">
						Use API keys when subscription accounts run out
					</Label>
					<span className="text-detail text-muted-foreground">
						{fallback.enabled
							? tl(
									"On. When every subscription account you use here is at its limit or failing, the next request uses your first {provider} API key. API keys are billed per request.",
									{ provider: keyProviderLabel }
								)
							: tl(
									"Off. A subscription account at its limit waits until the limit resets. An API key is never used in its place."
								)}
					</span>
				</div>
				<Switch
					checked={fallback.enabled}
					disabled={busy}
					id={id}
					onCheckedChange={onChange}
				/>
			</div>
			{fallback.enabled && fallback.keys.length === 0 ? (
				<p className="text-detail text-status-destructive" role="status">
					{tl(
						"No {provider} API key is saved, so nothing can take over yet. Add one in the {provider} settings.",
						{ provider: keyProviderLabel }
					)}
				</p>
			) : null}
			{fallback.enabled && fallback.keys.length > 0 ? (
				<div>
					<p className="font-medium text-sm">
						{tl("{provider} API keys, in the order they are tried", {
							provider: keyProviderLabel,
						})}
					</p>
					<ol className="m-0 list-none p-0" data-slot="fallback-keys">
						{fallback.keys.map((key, index) => (
							<li
								className="flex flex-wrap items-baseline gap-2 border-border border-b py-2 last:border-b-0"
								data-state={keyState(key)}
								key={key.accountId}
							>
								<span
									aria-hidden="true"
									className="w-4 shrink-0 text-end text-detail text-muted-foreground tabular-nums"
								>
									{index + 1}
								</span>
								<span
									className="min-w-0 flex-1 truncate text-sm"
									title={key.label}
								>
									{key.label}
								</span>
								{key.hint ? (
									<span className="shrink-0 text-detail text-muted-foreground">
										{tl("Key ending in {hint}", { hint: key.hint })}
									</span>
								) : null}
								<span className="shrink-0 text-detail text-muted-foreground">
									{stateText[keyState(key)]}
								</span>
							</li>
						))}
					</ol>
					<p className="mt-2 text-detail text-muted-foreground">
						{tl(
							"Change the order, or turn a key off, in the {provider} settings.",
							{ provider: keyProviderLabel }
						)}
					</p>
				</div>
			) : null}
		</section>
	);
}
