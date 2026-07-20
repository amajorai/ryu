// apps/desktop/src/components/agents/ClaudeGatewayConfig.tsx
//
// Per-agent control for Claude Code (`acp:claude`): route its egress through the
// Ryu gateway's transparent passthrough proxy while keeping the user's own Pro/Max
// subscription. Backed by the `claude-gateway-routing` Core preference; Core reads
// it on the (sync) ACP spawn path and injects `ANTHROPIC_BASE_URL` only when on.
//
// Subscription-preservation: Core injects ONLY the base URL, never an API key, so
// the user's subscription OAuth still authenticates the call. The gateway forwards
// that bearer upstream to Anthropic unchanged, applying request-side DLP + audit.

import { ClaudeGatewayConfigView } from "@ryu/blocks/desktop/agent-edit";
import { useEffect, useState } from "react";
import { sileo } from "sileo";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	getClaudeGatewayRouting,
	setClaudeGatewayRouting,
} from "@/src/lib/api/preferences.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

export function ClaudeGatewayConfig() {
	const [enabled, setEnabled] = useState(false);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		let cancelled = false;
		const target = toTarget(useNodeStore.getState().getActiveNode());
		getClaudeGatewayRouting(target).then((value) => {
			if (!cancelled) {
				setEnabled(value);
				setLoaded(true);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const handleToggle = async (next: boolean) => {
		setEnabled(next);
		const target = toTarget(useNodeStore.getState().getActiveNode());
		const ok = await setClaudeGatewayRouting(target, next);
		if (ok) {
			sileo.success({
				title: next
					? "Routing Claude Code through the gateway"
					: "Claude Code egress is direct again",
				description: next
					? "Restart Claude Code to apply. Your subscription is preserved."
					: undefined,
			});
		} else {
			setEnabled(!next);
			sileo.error({ title: "Failed to update gateway routing" });
		}
	};

	return (
		<ClaudeGatewayConfigView
			enabled={enabled}
			loaded={loaded}
			onToggle={handleToggle}
		/>
	);
}
