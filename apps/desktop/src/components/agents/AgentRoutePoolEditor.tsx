// apps/desktop/src/components/agents/AgentRoutePoolEditor.tsx
//
// Per-agent auto-routing pool (Plane A): narrow which models and providers
// automatic model routing may pick for ONE agent — e.g. only Claude and GPT
// models, or only OpenRouter and this node's agents — without replacing the
// router itself. Writes `routing.smart_routing.agent_pools[<agentId>]` in the
// gateway config; the gateway applies it to every request attributed to the
// agent (OpenAI-compatible chat and gateway-routed ACP agents alike) and
// intersects it with the global Smart routing pool, so an agent can narrow the
// node's pool but never widen it. Clearing both fields removes the entry.

import { Button } from "@ryu/ui/components/button.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useEffect, useMemo, useState } from "react";
import { sileo } from "sileo";
import { RoutePoolFields } from "@/src/components/gateway/RoutePoolFields.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { ApiError, toTarget } from "@/src/lib/api/client.ts";
import {
	fetchAgentRoutePool,
	formatPoolList,
	parsePoolList,
	type RoutePool,
	SmartRoutingUnavailableError,
	saveAgentRoutePool,
} from "@/src/lib/api/gateway.ts";

const SAVE_FAILED_COPY =
	"The save failed. Your draft is still here; check the connection and retry.";
const SAVE_DENIED_COPY =
	"This node denied the change. Changing routing pools needs the gateway.configure permission. Your draft is still here.";
const UNAVAILABLE_COPY =
	"This node's gateway does not report smart routing, so it cannot store routing pools. Update the node to use this setting.";

function saveErrorCopy(error: unknown): string {
	if (error instanceof SmartRoutingUnavailableError) {
		return UNAVAILABLE_COPY;
	}
	if (error instanceof ApiError && error.status === 403) {
		return SAVE_DENIED_COPY;
	}
	return SAVE_FAILED_COPY;
}

export function AgentRoutePoolEditor({ agentId }: { agentId: string }) {
	const node = useActiveNode();
	// Keyed on the node's own identity (see AgentSmartRouteOverride): a node
	// switch must move the load and the save to the newly active node.
	const target = useMemo(
		() => toTarget(node),
		// the two fields toTarget reads are the identity that matters
		[node.url, node.token]
	);
	const [models, setModels] = useState("");
	const [providers, setProviders] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoaded(false);
		setLoadError(null);
		fetchAgentRoutePool(target, agentId)
			.then((pool) => {
				if (cancelled) {
					return;
				}
				setModels(formatPoolList(pool?.allowed_models));
				setProviders(formatPoolList(pool?.allowed_providers));
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					setLoadError(
						error instanceof SmartRoutingUnavailableError
							? UNAVAILABLE_COPY
							: "Could not load this agent's routing pool. Check this node's connection or permissions and retry."
					);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoaded(true);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [agentId, loadAttempt, target]);

	const handleSave = async () => {
		setSaving(true);
		setSaveError(null);
		const pool: RoutePool = {
			allowed_models: parsePoolList(models),
			allowed_providers: parsePoolList(providers),
		};
		try {
			await saveAgentRoutePool(target, agentId, pool);
		} catch (error) {
			setSaveError(saveErrorCopy(error));
			sileo.error({ title: "Failed to save the routing pool" });
			return;
		} finally {
			setSaving(false);
		}
		setModels(formatPoolList(pool.allowed_models));
		setProviders(formatPoolList(pool.allowed_providers));
		const open =
			pool.allowed_models.length === 0 && pool.allowed_providers.length === 0;
		sileo.success({
			title: open ? "Routing pool cleared" : "Routing pool saved",
			description: open
				? "This agent routes inside the node's pool."
				: "Automatic routing for this agent stays inside its pool.",
		});
	};

	if (!loaded) {
		return <SkeletonRows spacing="generous" />;
	}
	if (loadError) {
		return (
			<div className="flex flex-col gap-3 rounded-lg border border-destructive/30 p-4">
				<p className="text-sm text-status-destructive" role="alert">
					{loadError}
				</p>
				<div>
					<Button
						onClick={() => setLoadAttempt((attempt) => attempt + 1)}
						size="sm"
						variant="outline"
					>
						Retry
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-0.5">
				<span className="font-medium text-sm">Routing pool</span>
				<p className="text-detail text-muted-foreground">
					Narrow the models smart routing may pick for this agent. Empty uses
					the node&apos;s pool.
				</p>
			</div>
			<RoutePoolFields
				idPrefix={`agent-route-pool-${agentId}`}
				models={models}
				onModelsChange={(next) => {
					setSaveError(null);
					setModels(next);
				}}
				onProvidersChange={(next) => {
					setSaveError(null);
					setProviders(next);
				}}
				providers={providers}
			/>
			{saveError ? (
				<p className="text-sm text-status-destructive" role="alert">
					{saveError}
				</p>
			) : null}
			<div>
				<Button loading={saving} onClick={() => handleSave()} size="sm">
					Save routing pool
				</Button>
			</div>
		</div>
	);
}
