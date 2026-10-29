// apps/desktop/src/components/shell/SafeModeBanner.tsx
//
// A persistent marker while the node is booted in Safe Mode.
//
// Without it the mode is a trap: apps are missing, skills stop firing and slash
// commands vanish, with nothing on screen connecting that to a switch the user
// flipped days ago. Every "my plugin disappeared" report would be this. So the
// banner is not decoration — it is the thing that makes a sticky diagnostic mode
// safe to ship.
//
// It reads Core, not a local preference: Safe Mode can also be forced on by
// `RYU_SAFE_MODE` or the `~/.ryu/state/safe-mode` sentinel, and a client-side flag would
// stay silent on exactly the nodes that most need the marker.

import { Alert01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useSafeMode } from "@/src/hooks/useSafeMode.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

/**
 * Re-read cadence. Slow on purpose: the state only changes across a Core restart,
 * so this is a correction for a node swap or an out-of-band flip, not a poll of
 * something live.
 */
const POLL_INTERVAL_MS = 60_000;

export function SafeModeBanner() {
	const tl = useLiteralMessages();
	// No tab context in the shell, so resolve the active node and derive the
	// target in the render body — same reason as `SupportAccessBanner`.
	const node = useNodeStore((s) => s.getActiveNode());
	const {
		state,
		busy: leaving,
		pending,
		apply,
		local,
	} = useSafeMode(node, POLL_INTERVAL_MS);
	const handleLeave = async () => {
		try {
			await apply(false);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Couldn't leave Safe Mode"
			);
		}
	};

	if (!state?.enabled) {
		return null;
	}

	const { mcpServers, plugins, skills } = state.suppressed;
	const restartPending =
		pending ??
		(state.preferenceEnabled === state.enabled
			? null
			: state.preferenceEnabled);

	return (
		<div className="pointer-events-auto fixed top-12 right-4 z-50 flex items-center gap-3 rounded-xl border border-warning/40 bg-warning/15 px-3 py-2 shadow-lg backdrop-blur-xl">
			<HugeiconsIcon
				className="size-4 shrink-0 text-status-warning dark:text-status-warning"
				icon={Alert01Icon}
			/>
			<div className="flex flex-col leading-tight">
				<span className="font-medium text-xs">Safe Mode</span>
				<span className="text-muted-foreground text-xs">
					{restartPending === false && !local
						? "Saved. Restart the remote node to leave Safe Mode. "
						: null}
					{tl(
						"{plugins, plural, one {# app} other {# apps}}, {skills, plural, one {# skill} other {# skills}} and {mcpServers, plural, one {# MCP server} other {# MCP servers}} aren't loaded",
						{ mcpServers, plugins, skills }
					)}
				</span>
			</div>
			{/* An env-forced node can only be cleared by unsetting the variable, so
			    offer the button only where it can actually work. */}
			{state.userClearable ? (
				<Button
					className="h-7"
					disabled={leaving || restartPending === false}
					onClick={handleLeave}
					size="sm"
					variant="ghost"
				>
					Leave
				</Button>
			) : null}
		</div>
	);
}
