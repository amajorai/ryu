// apps/desktop/src/components/agents/AgentUpdateControl.tsx
//
// The per-row "check for updates" control on the Agents page, hosted inside each
// AgentRow via its `updateSlot`. One instance per agent runs `useAgentUpdate`
// (mirroring the Engines page). It shows:
//   - "Update available (vX.Y.Z)" + an Update button when both versions are
//     known and differ (the flagship `ryu` agent's managed Pi path);
//   - a subtle installed/latest version chip otherwise (npx agents only expose
//     `latestVersion`, shown as info with no update prompt).
// The update itself runs in Core (10-60s) and toasts success/error.

import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { toast } from "@ryu/ui/components/sileo";
import { Spinner } from "@ryu/ui/components/spinner";
import { useAgentUpdate } from "@/src/hooks/useAgentUpdate.ts";

export function AgentUpdateControl({ agentId }: { agentId: string }) {
	const { check, update, updating } = useAgentUpdate(agentId);

	// Nothing to show until the check resolves for a non-npm-backed agent.
	if (!(check && (check.updateAvailable || check.installedVersion))) {
		// npx agents: surface the latest version as info (no update prompt).
		if (check?.latestVersion && !check.installedVersion) {
			return (
				<span className="shrink-0 text-muted-foreground/70 text-xs group-hover/row:hidden">
					latest v{check.latestVersion}
				</span>
			);
		}
		return null;
	}

	const handleUpdate = async () => {
		try {
			const res = await update();
			if (res.updated) {
				toast.success("Agent updated", {
					description: res.installedVersion
						? `Now on v${res.installedVersion}.`
						: "The runtime was refreshed.",
				});
			} else {
				toast.error("Update failed", {
					description: res.error ?? "The runtime could not be updated.",
				});
			}
		} catch (e) {
			toast.error("Update failed", {
				description:
					e instanceof Error ? e.message : "The update request failed.",
			});
		}
	};

	if (check.updateAvailable) {
		return (
			<div className="flex shrink-0 items-center gap-1.5">
				<Badge className="text-[10px]" variant="secondary">
					Update available
					{check.latestVersion ? ` (v${check.latestVersion})` : ""}
				</Badge>
				<Button
					className="h-6 px-2 text-xs"
					disabled={updating}
					onClick={(e) => {
						e.stopPropagation();
						handleUpdate().catch(() => undefined);
					}}
					size="sm"
					variant="outline"
				>
					{updating ? <Spinner className="size-3" /> : null}
					{updating ? "Updating…" : "Update"}
				</Button>
			</div>
		);
	}

	// Up to date with a known installed version — show it subtly.
	return (
		<span className="shrink-0 text-muted-foreground/70 text-xs group-hover/row:hidden">
			v{check.installedVersion}
		</span>
	);
}
