import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
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
	const tl = useLiteralMessages();
	const [state, setState] = useState<NodeOnboardingSnapshot | null>(null);
	const [loading, setLoading] = useState(true);
	const [resetting, setResetting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [loadAttempt, setLoadAttempt] = useState(0);

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
			.catch((reason) => {
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
	}, [loadAttempt, target.token, target.url, target.userJwt]);

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
	const ready = !(loading || error);

	return (
		<SettingsSection
			caption="Node onboarding controls the context shared by every desktop that connects here. It does not reset chats, memories, themes, or other data."
			title="This node"
		>
			{/* Every row is a direct child of the group (never a fragment), so each
			    row's description renders as the iOS footer under its own card. */}
			<SettingsGroup>
				{loading ? (
					<SettingsItem
						actions={<Spinner className="size-4" />}
						description="Reading this node's setup state"
						title="Node setup"
					/>
				) : null}
				{!loading && error ? (
					// A plain sentence plus Retry; the raw failure (often a schema issue
					// list) is kept on the title attribute rather than printed.
					<SettingsItem
						actions={
							<Button
								onClick={() => setLoadAttempt((attempt) => attempt + 1)}
								size="sm"
								variant="outline"
							>
								Retry
							</Button>
						}
						description="Check that this node is running and reachable, then try again."
						title={
							<span title={error}>Couldn’t load this node’s setup state.</span>
						}
					/>
				) : null}
				{ready ? (
					<SettingsItem
						actions={<Badge variant="secondary">{statusLabel}</Badge>}
						description={
							state?.completed
								? tl("{setupLabel} context is active on this node.", {
										setupLabel,
									})
								: "Choose personal or team context from onboarding."
						}
						title={
							state?.completed
								? tl("Node setup · {setupLabel}", { setupLabel })
								: "Node setup"
						}
					/>
				) : null}
				{ready ? (
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
				) : null}
			</SettingsGroup>
		</SettingsSection>
	);
}
