// apps/desktop/src/components/agents/AgentAutoRoutingEditor-classify-tier.tsx
//
// Local classify-tier probe, badge tone and status row for the agent-auto
// rules editor (split out of AgentAutoRoutingEditor.tsx).

import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { useQuery } from "@tanstack/react-query";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	CLASSIFY_MODEL_ID,
	CLASSIFY_TIER_COPY,
	type ClassifyTierState,
	classifyTierServable,
	deriveClassifyTierState,
	fetchClassifyWeightsPresent,
} from "@/src/lib/api/gateway.ts";
import { fetchSidecarStatus } from "@/src/lib/api/system.ts";

// Same cadences the gateway's Smart routing card polls at: the run state flips
// whenever the lazy sidecar starts, the weights land once after a download.
const CLASSIFY_STATUS_POLL_MS = 5000;
const CLASSIFY_WEIGHTS_POLL_MS = 30_000;

/**
 * Live state of the local classify tier on the node this config is written to,
 * from the same two independent probes the gateway's Smart routing card crosses:
 *
 *  - `/api/sidecar/status` — is the sidecar registered, and is it resident? Read
 *    from Core, not the gateway, because the sidecar is Core's and no gateway
 *    route reports it.
 *  - `/api/models/installed` — are its WEIGHTS on disk? Registered-but-idle is the
 *    sidecar's normal resting state, so the run state alone cannot tell a lazy
 *    tier apart from one whose non-fatal onboarding download failed and which will
 *    therefore bail on every start attempt.
 *
 * `undefined` for either probe while pending OR on failure (an older Core has no
 * `/api/models/installed`), which keeps the row silent instead of crying "not
 * downloaded" — {@link deriveClassifyTierState}, not this hook, decides what that
 * means. Only polled while the dialog is open, and keyed by node URL so it shares
 * one poll with every other card on the same node.
 */
export function useClassifyTier(
	target: ApiTarget,
	enabled: boolean
): ClassifyTierState {
	const status = useQuery({
		enabled,
		queryKey: ["sidecar-status", target.url],
		queryFn: () => fetchSidecarStatus(target),
		refetchInterval: CLASSIFY_STATUS_POLL_MS,
	});
	const weights = useQuery({
		enabled,
		queryKey: ["classify-weights", target.url],
		queryFn: () => fetchClassifyWeightsPresent(target),
		refetchInterval: CLASSIFY_WEIGHTS_POLL_MS,
	});
	return deriveClassifyTierState({
		sidecarStatus: status.isSuccess ? status.data : undefined,
		weightsPresent: weights.isSuccess ? weights.data : undefined,
	});
}

/**
 * Badge tone per tier state: `running` reads as active, `unweighted` is the one
 * state that is a genuine fault on this node, and `idle`/`absent` are neutral
 * facts.
 */
function classifyBadgeVariant(
	state: Exclude<ClassifyTierState, "unknown">
): "default" | "destructive" | "secondary" {
	if (state === "running") {
		return "default";
	}
	if (state === "unweighted") {
		return "destructive";
	}
	return "secondary";
}

/**
 * Status + one-click adopt row for the local classify tier, rendered under the
 * classifier field. The button only appears when this node can actually serve the
 * tier and it isn't already the selected value — offering it otherwise would hand
 * the user a model id whose call is guaranteed to fail.
 */
export function ClassifyTierNote({
	onUse,
	state,
	value,
}: {
	onUse: () => void;
	state: ClassifyTierState;
	value: string;
}) {
	if (state === "unknown") {
		return null;
	}
	const copy = CLASSIFY_TIER_COPY[state];
	const servable = classifyTierServable(state);
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Badge variant={classifyBadgeVariant(state)}>{copy.badge}</Badge>
			<span className="text-muted-foreground text-xs">{copy.hint}</span>
			{servable && value.trim() !== CLASSIFY_MODEL_ID ? (
				<Button onClick={onUse} size="sm" type="button" variant="ghost">
					Use it
				</Button>
			) : null}
		</div>
	);
}
