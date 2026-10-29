// apps/desktop/src/components/agents/GatewayRoutingConfig.tsx
//
// The agent editor's per-agent view of the TWO independent gates Core keeps for
// a generic ACP agent:
//
//   * MODEL EGRESS — `agent-gateway-routing`. Core injects OPENAI_BASE_URL +
//     OPENAI_API_KEY into the agent's spawn command, so an agent whose client
//     honours the OpenAI base URL sends its model calls through the gateway.
//     Default ON for newly created/installed ACP agents; turning it off is the
//     explicit opt-out to keep model egress direct.
//   * RYU TOOLS — `agent-tool-bridge`. Core injects its own in-process MCP server
//     into the ACP session, so the agent can call the tools its allowlist already
//     permits. Default ON, because it grants nothing the user has not configured.
//
// ── Why this file changed ────────────────────────────────────────────────────
// These used to be ONE preference. An agent whose owner declined the credential
// swap ALSO silently lost every Ryu tool, which
// is why a freshly added ACP agent could not do anything. `agent_routing` split
// them; this editor previously showed only the egress half, so after the split
// the tool gate had no per-agent control in the agent editor at all.
//
// ── Where this actually renders ──────────────────────────────────────────────
// `AgentEditPage` mounts this ONLY when `chatModel === ACP_CUSTOM_ENGINE`, i.e.
// for a BYO `acp-exec:<command>` agent. Pi, Claude Code and Codex have their own
// dedicated egress controls and never reach this component. That render gate is
// why the flagship's story is NOT told here — it would render nowhere. The
// surface that lists every installed agent, flagship included, is
// `components/gateway/AgentEgressSection.tsx`.
//
// ── Why the tools half is classified rather than assumed ─────────────────────
// Core's decision is `acp_bridge_supported(spawn_cmd) && is_tool_bridge_enabled(id)`,
// and the first term is `!spawn_cmd.contains("pi-acp")`. A BYO command may well BE
// pi-acp, in which case no preference value can give it the bridge. Rendering a
// switch there would be a settable control that cannot take effect — the same
// defect the egress column already refuses for `gateway_bypass` agents. So this
// reuses `classifyToolBridge`, the one function that mirrors both of Core's terms,
// instead of reading the preference directly and hoping.

import { GatewayRoutingConfigView } from "@ryu/blocks/desktop/agent-edit.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect, useState } from "react";
import { sileo } from "sileo";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	type AgentToolBridge,
	classifyToolBridge,
} from "@/src/lib/api/agent-egress.ts";
import { fetchAgent } from "@/src/lib/api/agents.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	getAgentGatewayRouting,
	getAgentToolBridgeMap,
	setAgentGatewayRouting,
	setAgentToolBridge,
} from "@/src/lib/api/preferences.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

export function GatewayRoutingConfig({
	agentId,
	limitedNotice = null,
}: {
	agentId: string;
	/** Shown when the agent's account access is limited. */
	limitedNotice?: string | null;
}) {
	const [enabled, setEnabled] = useState(true);
	const [loaded, setLoaded] = useState(false);
	const [tools, setTools] = useState<AgentToolBridge | null>(null);
	// The value THIS component last persisted for the tools switch, so the control
	// stays where the user put it while `tools` still holds the pre-write read.
	// Same reasoning as the gateway panel's `saved`.
	const [toolsSaved, setToolsSaved] = useState<boolean | null>(null);

	useEffect(() => {
		let cancelled = false;
		const target = toTarget(useNodeStore.getState().getActiveNode());
		getAgentGatewayRouting(target, agentId).then((value) => {
			if (!cancelled) {
				setEnabled(value);
				setLoaded(true);
			}
		});
		Promise.all([
			// The engine carries the `acp-exec:<command>` text Core's transport guard
			// matches on, so the tools half cannot be classified without it. A record
			// we cannot read leaves `tools` null and renders nothing, rather than
			// guessing a control into existence.
			fetchAgent(target, agentId).catch(() => null),
			getAgentToolBridgeMap(target).catch(
				() =>
					/* SAFETY: The failure fallback is this freshly authored empty object, so it has no entries that could violate the boolean map contract. */ ({}) as Record<
						string,
						boolean
					>
			),
		]).then(([record, toolMap]) => {
			if (cancelled || !record) {
				return;
			}
			setTools(
				classifyToolBridge(
					{
						id: agentId,
						name: record.name,
						engine: record.engine,
						flagship: false,
					},
					// A BYO `acp-exec:` engine resolves to no catalog entry — the same
					// `null` `classifyAgentEgress` threads through for that branch.
					null,
					{ tools: toolMap },
					"openai-base-url"
				)
			);
			setToolsSaved(null);
		});
		return () => {
			cancelled = true;
		};
	}, [agentId]);

	// Both writes below `.catch(() => false)` rather than awaiting bare. The
	// setters go through `getPreference`, which THROWS on a network failure
	// instead of returning false — and the JSX call sites swallow rejections, so
	// an unguarded await would leave the switch showing the new value with no
	// toast and no rollback: a control displaying a state the node does not hold,
	// which is the one thing this whole surface exists not to do.
	const handleToggle = async (next: boolean) => {
		setEnabled(next);
		const target = toTarget(useNodeStore.getState().getActiveNode());
		const ok = await setAgentGatewayRouting(target, agentId, next).catch(
			() => false
		);
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

	const handleToolsToggle = async (next: boolean) => {
		setToolsSaved(next);
		const target = toTarget(useNodeStore.getState().getActiveNode());
		const ok = await setAgentToolBridge(target, agentId, next).catch(
			() => false
		);
		if (ok) {
			sileo.success({
				title: next
					? "This agent can use Ryu's tools"
					: "Ryu's tools are withheld from this agent",
				description: tools?.takesEffect ?? undefined,
			});
		} else {
			setToolsSaved(!next);
			sileo.error({ title: "Failed to update tool access" });
		}
	};

	const toolsChecked = toolsSaved ?? tools?.enabled === true;

	return (
		<div className="flex flex-col gap-6">
			{/* Tools first: it is the gate that is ON by default and the one a user is
			    looking for when a newly added agent "does nothing". Leading with the
			    credential-moving switch would put the riskier control on top. */}
			{tools ? (
				<SettingsSection
					caption="Whether this agent can call Ryu's tools. Separate from gateway routing below, and on by default — the bridge offers exactly the tools this agent's own allowlist permits and re-checks that allowlist on every call, so it grants nothing you have not already configured. Turning gateway routing off does not take these away."
					title="Ryu tools"
				>
					<SettingsGroup>
						<SettingsItem
							actions={
								tools.control === null ? (
									<Badge variant="outline">Not available</Badge>
								) : (
									<Switch
										aria-label="Give this agent access to Ryu's tools"
										checked={toolsChecked}
										id="agent-tool-bridge"
										onCheckedChange={(next) => {
											handleToolsToggle(next).catch(() => undefined);
										}}
									/>
								)
							}
							description={
								tools.takesEffect
									? `${tools.detail} ${tools.takesEffect}`
									: tools.detail
							}
							title="Let this agent use Ryu's tools"
						/>
					</SettingsGroup>
				</SettingsSection>
			) : null}
			<GatewayRoutingConfigView
				enabled={enabled}
				limitedNotice={limitedNotice}
				loaded={loaded}
				onToggle={handleToggle}
			/>
		</div>
	);
}
