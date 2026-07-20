// apps/desktop/src/components/agents/GatewayRoutingConfig.tsx
//
// Generic per-agent control: route ANY OpenAI-compatible agent's egress through
// the Ryu gateway via the OpenAI base-URL swap. Backed by the per-agent
// `agent-gateway-routing` Core preference (a JSON map of agent id → enabled);
// Core reads it on the (sync) ACP spawn path and injects OPENAI_BASE_URL +
// OPENAI_API_KEY only when on.
//
// Unlike the Claude/Codex toggles (subscription passthroughs, format-specific),
// this is the BYO lever: most useful for a custom `acp-exec:` OpenAI-compatible
// agent the user added. Pi, Claude Code and Codex have their own dedicated
// controls and are NOT configured here.

import { GatewayRoutingConfigView } from "@ryu/blocks/desktop/agent-edit";
import { useEffect, useState } from "react";
import { sileo } from "sileo";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	getAgentGatewayRouting,
	setAgentGatewayRouting,
} from "@/src/lib/api/preferences.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

export function GatewayRoutingConfig({ agentId }: { agentId: string }) {
	const [enabled, setEnabled] = useState(false);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		let cancelled = false;
		const target = toTarget(useNodeStore.getState().getActiveNode());
		getAgentGatewayRouting(target, agentId).then((value) => {
			if (!cancelled) {
				setEnabled(value);
				setLoaded(true);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [agentId]);

	const handleToggle = async (next: boolean) => {
		setEnabled(next);
		const target = toTarget(useNodeStore.getState().getActiveNode());
		const ok = await setAgentGatewayRouting(target, agentId, next);
		if (ok) {
			sileo.success({
				title: next
					? "Routing this agent through the gateway"
					: "Agent egress is direct again",
				description: next
					? "Restart the agent to apply. Only takes effect for OpenAI-compatible agents."
					: undefined,
			});
		} else {
			setEnabled(!next);
			sileo.error({ title: "Failed to update gateway routing" });
		}
	};

	return (
		<GatewayRoutingConfigView
			enabled={enabled}
			loaded={loaded}
			onToggle={handleToggle}
		/>
	);
}
