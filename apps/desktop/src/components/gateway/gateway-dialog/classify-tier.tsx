import { Button } from "@ryu/ui/components/button.tsx";
import { useQuery } from "@tanstack/react-query";
import { StatusText } from "@/src/components/gateway/quiet.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { ClassifyTierState } from "@/src/lib/api/gateway.ts";
import {
	CLASSIFY_MODEL_ID,
	CLASSIFY_TIER_COPY,
	classifyTierServable,
	deriveClassifyTierState,
	fetchClassifyWeightsPresent,
} from "@/src/lib/api/gateway.ts";
import { fetchSidecarStatus } from "@/src/lib/api/system.ts";

/** Editing row for a smart-routing rule, with a stable client-side id for keys. */
export interface RuleRow {
	description: string;
	id: string;
	model: string;
	weight: string;
}

// ── Local classify tier (shared by the two "cheap model" fields) ──────────────
//
// Both the guardrail inspector and smart routing want a small, fast, free model
// that runs per turn. Core ships one — a lazy `llama.cpp` sidecar serving Gemma
// 3 270M, exposed by the gateway as the `classify` provider — but nothing in
// this dialog used to say so, so the fields read as "type a model id and hope".
// These two pieces make the tier visible: read its live state off the node, and
// offer its model id as a one-click value. The state MACHINE (and the copy, and
// the "can this node serve it" predicates) lives in `lib/api/gateway.ts` so it is
// testable without rendering the dialog; this file only owns the polling.

/** Matches the status cadence of the app-wide `useSystemStatus` poll. */
const CLASSIFY_STATUS_POLL_MS = 5000;

/**
 * The weights either exist or they don't; nothing but an install changes that,
 * and an install is minutes of download. Polled far slower than the run state so
 * a dialog left open doesn't re-stat the model directory every 5s.
 */
const CLASSIFY_WEIGHTS_POLL_MS = 30_000;

/**
 * Live state of the classify tier on the node this dialog is configuring, from
 * two independent probes:
 *
 *  - `/api/sidecar/status` — is the sidecar registered, and is it resident?
 *    Read through the shared system API client (the same endpoint the node
 *    selector and the Store's sidecar toggles use) because the sidecar is Core's,
 *    not the gateway's, and no gateway route reports it.
 *  - `/api/models/installed` — are its WEIGHTS on disk? Registered-but-idle is
 *    the sidecar's normal resting state, so the run state alone cannot tell a
 *    lazy tier apart from one whose non-fatal onboarding download failed and
 *    which will therefore bail on every start attempt. That failure is the whole
 *    reason this row exists, and it is invisible in the run state.
 *
 * Both are keyed by node URL, so every card in this dialog shares one poll of
 * each rather than one per card.
 */
export function useClassifyTier(target: ApiTarget, enabled: boolean) {
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
	// `undefined` for either probe while pending OR on failure (an older Core has
	// no `/api/models/installed`), which keeps the row silent instead of crying
	// "not downloaded" — the derivation, not this hook, decides what that means.
	return deriveClassifyTierState({
		sidecarStatus: status.isSuccess ? status.data : undefined,
		weightsPresent: weights.isSuccess ? weights.data : undefined,
	});
}

/**
 * Badge tone per tier state: `running` reads as active, `unweighted` is the one
 * state that is a genuine fault on this node (the sidecar can never start), and
 * `idle`/`absent` are neutral facts.
 */
function classifyTone(
	state: Exclude<ClassifyTierState, "unknown">
): "success" | "destructive" | "muted" {
	if (state === "running") {
		return "success";
	}
	if (state === "unweighted") {
		return "destructive";
	}
	return "muted";
}

/**
 * Status + one-click adopt row for the local classify tier, rendered under a
 * "cheap model" picker. The button only appears when this node can actually
 * serve the tier and it isn't already the selected value — offering it otherwise
 * would hand the user a model id whose call is guaranteed to fail.
 */
export function ClassifyTierNote({
	disabled,
	onUse,
	state,
	value,
}: {
	disabled: boolean;
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
			<StatusText tone={classifyTone(state)}>{copy.badge}</StatusText>
			<span className="text-muted-foreground text-xs">{copy.hint}</span>
			{servable && value.trim() !== CLASSIFY_MODEL_ID ? (
				<Button
					disabled={disabled}
					onClick={onUse}
					size="sm"
					type="button"
					variant="ghost"
				>
					Use it
				</Button>
			) : null}
		</div>
	);
}
