// apps/desktop/src/components/settings/SafeModeSettings.tsx
//
// The Safe Mode switch — the OS-style "boot with the extension layer off" mode,
// for isolating a performance problem in one step instead of disabling thirty
// things one at a time.
//
// Deliberately NOT behind Developer Mode. The user reaching for this is chasing a
// hang or a fan spinning up, and that user is usually not a developer; gating it
// would put the troubleshooting tool behind a switch nobody in trouble knows to
// find. It lives under General → Troubleshooting for that reason.
//
// Applying Safe Mode requires restarting the selected node. Suppression happens at
// Core's BOOT, before anything spawns; a live flip would leave every sidecar, MCP
// child and scheduler loop that already started still running, so the switch would
// report success while the CPU cost it exists to remove kept being paid. The copy
// says so rather than hiding it. The desktop can restart its local Core; a
// remote save remains pending until that node is restarted by its operator.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useSafeMode } from "@/src/hooks/useSafeMode.ts";
import type { SafeModeState } from "@/src/lib/api/safe-mode.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/** "3 apps, 12 skills and 2 MCP servers" — the empty parts are dropped. */
function describeSuppressed(state: SafeModeState): string {
	const { mcpServers, plugins, skills } = state.suppressed;
	const parts: string[] = [];
	if (plugins > 0) {
		parts.push(`${plugins} app${plugins === 1 ? "" : "s"}`);
	}
	if (skills > 0) {
		parts.push(`${skills} skill${skills === 1 ? "" : "s"}`);
	}
	if (mcpServers > 0) {
		parts.push(`${mcpServers} MCP server${mcpServers === 1 ? "" : "s"}`);
	}
	if (parts.length === 0) {
		return "nothing";
	}
	if (parts.length === 1) {
		return parts[0];
	}
	return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function statusLine(state: SafeModeState): string {
	const scope = describeSuppressed(state);
	if (state.enabled) {
		return state.source === "env"
			? `Active, forced on by the RYU_SAFE_MODE environment variable. Holding back ${scope}.`
			: `Active. Holding back ${scope}. Your apps are untouched; turning this off restores them exactly.`;
	}
	return `Off. Turning it on would start the node without ${scope}.`;
}

export function SafeModeSettings() {
	const tl = useLiteralMessages();
	const activeNode = useActiveNode();
	const { state, sentinel, pending, busy, apply, local } =
		useSafeMode(activeNode);
	const handleToggle = async (next: boolean) => {
		try {
			await apply(next);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Couldn't change Safe Mode"
			);
		}
	};

	// Show the saved next-boot choice, while status copy describes the running
	// process. An environment override always wins. Local offline recovery may
	// read the desktop sentinel; remote nodes never inherit that flag.
	const enabled =
		pending ??
		(state?.userClearable === false
			? state.enabled
			: state?.preferenceEnabled) ??
		sentinel ??
		false;
	// An env-forced node cannot be talked out of Safe Mode from here (Core answers
	// 409), so the switch is disabled rather than offered and then refused.
	const locked = busy || (enabled && state?.userClearable === false);

	return (
		<SettingsSection
			caption="Starts the node with apps, plugins, skills, your MCP servers and the scheduler switched off, so you can tell whether one of them is what's slow. Chat, agents and settings keep working. Nothing is uninstalled or reconfigured; this only changes what loads. Turning it on or off changes every thread's system prompt, so each thread's next message after the restart is sent without the prompt cache."
			title="Troubleshooting"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							checked={enabled}
							disabled={locked}
							id="safe-mode"
							onCheckedChange={handleToggle}
						/>
					}
					description={
						state
							? `${statusLine(state)} ${local ? "Applies on restart; the node restarts when you flip this." : pending !== null || state.preferenceEnabled !== state.enabled ? "Saved for this node. Restart the remote node to apply the change." : "Applies after you restart the remote node."}`
							: local
								? enabled
									? "The node isn't answering, so this reads the on-disk flag instead: Safe Mode is armed for its next boot."
									: "The node isn't answering, so this reads the on-disk flag instead: Safe Mode is off for its next boot."
								: "The remote node is not answering. Retry saving when it is reachable."
					}
					title="Safe Mode"
				/>
				{state?.enabled && state.source !== "env" ? (
					<SettingsItem
						actions={
							<Button
								disabled={busy || pending === false}
								onClick={() => handleToggle(false)}
								size="sm"
								variant="ghost"
							>
								Leave Safe Mode
							</Button>
						}
						description={`${tl(
							"{kernelPlugins, plural, one {# core plugin} other {# core plugins}} kept running so chat and retrieval still work.",
							{ kernelPlugins: state.suppressed.kernelPlugins }
						)} ${local ? "Leaving restarts the node and brings everything back." : "Restart the remote node after saving to bring everything back."}`}
						title="Back to a normal boot"
					/>
				) : null}
			</SettingsGroup>
		</SettingsSection>
	);
}
