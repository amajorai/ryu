// apps/desktop/src/components/agents/AgentUpdateControl.tsx
//
// The per-agent "check for updates" control on the Agents page, hosted in the
// footer of each Library agent badge card (`AgentBadgeCard`'s `footer`). One instance per agent runs `useAgentUpdate`
// (mirroring the Engines page). It shows:
//   - "Update available (vX.Y.Z)" + an Update button when both versions are
//     known and differ (the flagship `ryu` agent's managed Pi path);
//   - a subtle installed/latest version chip otherwise (npx agents only expose
//     `latestVersion`, shown as info with no update prompt).
// The update itself runs in Core (10-60s) and toasts success/error.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useAgentUpdate } from "@/src/hooks/useAgentUpdate.ts";

export function AgentUpdateControl({ agentId }: { agentId: string }) {
	const { check, update, updating } = useAgentUpdate(agentId);
	const tl = useLiteralMessages();

	// Nothing to show until the check resolves for a non-npm-backed agent.
	if (!(check && (check.updateAvailable || check.installedVersion))) {
		// npx agents: surface the latest version as info (no update prompt).
		if (check?.latestVersion && !check.installedVersion) {
			return (
				<span className="shrink-0 text-muted-foreground/70 text-xs group-hover/row:hidden">
					{tl("latest v{latestVersion}", {
						latestVersion: check.latestVersion,
					})}
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
						? tl("Now on v{installedVersion}.", {
								installedVersion: res.installedVersion,
							})
						: "The runtime was refreshed.",
				});
			} else if (res.hint) {
				// Not a failure — the runtime is real, it just isn't Ryu's to move.
				toast.info("Update it where it was installed", {
					description: res.hint,
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
				<Badge size="compact" variant="secondary">
					{check.latestVersion
						? tl("Update available (v{latestVersion})", {
								latestVersion: check.latestVersion,
							})
						: "Update available"}
				</Badge>
				<Button
					loading={updating}
					onClick={(e) => {
						e.stopPropagation();
						handleUpdate().catch(() => undefined);
					}}
					// The host card opens the agent on Enter/Space; keep the key on the
					// button so activating Update never also opens the editor.
					onKeyDown={(e) => e.stopPropagation()}
					size="tiny"
					variant="ghost"
				>
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
