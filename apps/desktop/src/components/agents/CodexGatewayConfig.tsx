// apps/desktop/src/components/agents/CodexGatewayConfig.tsx
//
// Per-agent control for Codex (`acp:codex`): route its ChatGPT-login
// (subscription) egress through the Ryu gateway's transparent passthrough proxy
// while keeping the user's own ChatGPT subscription. Backed by the
// `codex-gateway-routing` Core preference; Core reads it on the (sync) ACP spawn
// path and points Codex at an isolated CODEX_HOME → gateway passthrough only when
// on.
//
// Subscription-preservation: Core never injects an API key, so the user's OAuth
// (bearer + ChatGPT-Account-ID) still authenticates the call. The gateway
// forwards both upstream unchanged, applying request-side DLP + audit.

import { CodexGatewayConfigView } from "@ryu/blocks/desktop/agent-edit";
import { useEffect, useState } from "react";
import { sileo } from "sileo";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	getCodexGatewayRouting,
	setCodexGatewayRouting,
} from "@/src/lib/api/preferences.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

export function CodexGatewayConfig() {
	const [enabled, setEnabled] = useState(false);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		let cancelled = false;
		const target = toTarget(useNodeStore.getState().getActiveNode());
		getCodexGatewayRouting(target).then((value) => {
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
		const ok = await setCodexGatewayRouting(target, next);
		if (ok) {
			sileo.success({
				title: next
					? "Routing Codex through the gateway"
					: "Codex egress is direct again",
				description: next
					? "Restart Codex to apply. Your subscription is preserved."
					: undefined,
			});
		} else {
			setEnabled(!next);
			sileo.error({ title: "Failed to update gateway routing" });
		}
	};

	return (
		<CodexGatewayConfigView
			enabled={enabled}
			loaded={loaded}
			onToggle={handleToggle}
		/>
	);
}
