import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { toast } from "@ryu/ui/components/sileo";
import { Spinner } from "@ryu/ui/components/spinner";
import { useEffect, useState } from "react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchNodeOnboardingState,
	type NodeOnboardingSnapshot,
	resetNodeOnboardingState,
} from "@/src/lib/api/onboarding-profile.ts";

export function NodeOnboardingSettings({
	canConfigure,
	target,
}: {
	canConfigure: boolean;
	target: ApiTarget;
}) {
	const [state, setState] = useState<NodeOnboardingSnapshot | null>(null);
	const [loading, setLoading] = useState(true);
	const [resetting, setResetting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		fetchNodeOnboardingState(target)
			.then((next) => {
				if (!cancelled) {
					setState(next);
					setError(null);
				}
			})
			.catch((reason: unknown) => {
				if (!cancelled) {
					setError(
						reason instanceof Error
							? reason.message
							: "The node onboarding state could not be loaded."
					);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [target.token, target.url, target.userJwt]);

	const handleReset = async () => {
		if (resetting || !canReset) {
			return;
		}
		setResetting(true);
		try {
			await resetNodeOnboardingState(target);
			toast.success("Node onboarding reset", {
				description: "The next launch will ask how this node should be set up.",
			});
			window.location.reload();
		} catch (reason: unknown) {
			toast.error("Couldn't reset node onboarding", {
				description:
					reason instanceof Error
						? reason.message
						: "Check your node permissions and try again.",
			});
		} finally {
			setResetting(false);
		}
	};

	const setupLabel =
		state?.setupKind === "team" ? "Team or company" : "Personal";
	const statusLabel = state?.completed ? "Complete" : "Needs setup";
	// The endpoint's decision is authoritative for this exact node. The parent
	// capability is only a loading fallback and may be broader than a personal
	// node owner's boundary.
	const canReset = state?.canConfigure ?? canConfigure;

	return (
		<SettingsSection
			caption="Node onboarding controls the context shared by every desktop that connects here. It does not reset chats, memories, themes, or other data."
			title="Onboarding"
		>
			<SettingsGroup>
				{loading ? (
					<SettingsItem
						actions={<Spinner className="size-4" />}
						description="Reading this node's setup state"
						title="Node setup"
					/>
				) : error ? (
					<SettingsItem description={error} title="Node setup unavailable" />
				) : (
					<>
						<SettingsItem
							actions={<Badge variant="secondary">{statusLabel}</Badge>}
							description={
								state?.completed
									? `${setupLabel} context is active on this node.`
									: "Choose personal or team context from onboarding."
							}
							title={
								state?.completed ? `Node setup · ${setupLabel}` : "Node setup"
							}
						/>
						<SettingsItem
							actions={
								<Button
									disabled={!canReset || resetting}
									onClick={() => {
										void handleReset();
									}}
									size="sm"
									variant="ghost"
								>
									{resetting ? "Resetting…" : "Reset onboarding"}
								</Button>
							}
							description={
								canReset
									? "Run the node setup step again. Existing data stays intact."
									: "Only a node administrator with gateway.configure can reset this."
							}
							title="Run setup again"
						/>
					</>
				)}
			</SettingsGroup>
		</SettingsSection>
	);
}
