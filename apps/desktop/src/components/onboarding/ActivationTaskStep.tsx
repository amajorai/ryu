import {
	OnboardingActions,
	OnboardingCta,
} from "@ryu/blocks/desktop/onboarding-shell.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useState } from "react";
import { ConnectionPermissionDialog } from "@/src/components/marketplace/ConnectionPermissionDialog.tsx";
import type { ConnectionAccessLevel } from "@/src/lib/connection-permissions.ts";
import type { ActivationTaskDraft } from "@/src/lib/onboarding-activation.ts";
import { ActivationStepShell } from "./ActivationStepShell.tsx";

export function ActivationTaskStep({
	draft,
	connected,
	subscribed,
	error,
	onStart,
	onBack,
	onConnect,
	onUseOwnModel,
	pending = false,
}: {
	draft: ActivationTaskDraft;
	connected: boolean;
	subscribed: boolean;
	error?: string | null;
	onStart: () => void;
	onBack: () => void;
	onConnect: (accessLevel: ConnectionAccessLevel) => Promise<void>;
	onUseOwnModel: () => void;
	pending?: boolean;
}) {
	const tl = useLiteralMessages();
	const [permissionOpen, setPermissionOpen] = useState(false);
	const needsConnection = Boolean(draft.appSlug && !connected);
	return (
		<ActivationStepShell
			subtitle="Task preview. Nothing has run, and no credits have been used."
			title="See what Ryu will work on"
			width="wide"
		>
			<section className="flex flex-col gap-3">
				<h2 className="font-semibold text-sm">{draft.title}</h2>
				<p className="whitespace-pre-wrap text-pretty rounded-xl bg-muted px-4 py-3 text-muted-foreground text-sm">
					{draft.prompt}
				</p>
				<p className="text-detail text-muted-foreground">
					{draft.appName
						? connected
							? tl("Uses {appName} for this task.", {
									appName: draft.appName,
								})
							: tl("Requires a connection to {appName} for this task.", {
									appName: draft.appName,
								})
						: "Uses the context you provide."}{" "}
					Ryu-managed execution needs an active subscription before work starts.
				</p>
				{error ? (
					<p className="text-sm text-status-destructive" role="alert">
						{error}
					</p>
				) : null}
			</section>
			<OnboardingActions className="justify-between">
				<OnboardingCta disabled={pending} onClick={onBack} tone="secondary">
					Choose another task
				</OnboardingCta>
				<div className="flex flex-wrap items-center gap-2">
					<OnboardingCta
						disabled={pending}
						onClick={onUseOwnModel}
						tone="secondary"
					>
						Choose my own model
					</OnboardingCta>
					<OnboardingCta
						disabled={pending}
						loading={pending}
						onClick={needsConnection ? () => setPermissionOpen(true) : onStart}
					>
						{needsConnection
							? tl("Connect {appName} for this task", {
									appName: draft.appName ?? tl("app"),
								})
							: subscribed
								? "Start managed task"
								: "See managed pricing"}
					</OnboardingCta>
				</div>
			</OnboardingActions>
			<ConnectionPermissionDialog
				connectionName={draft.appName ?? "this integration"}
				connectionType="Composio"
				onConfirm={async (accessLevel) => {
					await onConnect(accessLevel);
					setPermissionOpen(false);
				}}
				onOpenChange={setPermissionOpen}
				open={permissionOpen}
			/>
		</ActivationStepShell>
	);
}
