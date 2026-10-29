import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card.tsx";
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
		>
			<Card
				appearance="onboarding"
				borderTone="subtle"
				className="w-full max-w-2xl"
			>
				<CardHeader>
					<CardTitle>{draft.title}</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="rounded-3xl bg-muted/60 p-5">
						<p className="whitespace-pre-wrap text-muted-foreground text-sm leading-6">
							{draft.prompt}
						</p>
					</div>
					<p className="mt-4 text-muted-foreground text-sm">
						{draft.appName
							? connected
								? tl("Uses {appName} for this task.", {
										appName: draft.appName,
									})
								: tl("Requires a connection to {appName} for this task.", {
										appName: draft.appName,
									})
							: "Uses the context you provide."}
					</p>
					<p className="mt-2 text-muted-foreground text-sm">
						Ryu-managed execution requires an active subscription before work
						starts. You can also open chat and choose your own model and
						context.
					</p>
					{error ? (
						<p className="mt-3 text-sm text-status-destructive" role="alert">
							{error}
						</p>
					) : null}
				</CardContent>
				<CardFooter
					appearance="onboarding-step"
					className="flex-wrap justify-between"
					spacing="choices"
				>
					<Button disabled={pending} onClick={onBack} variant="ghost">
						Choose another task
					</Button>
					<Button
						disabled={pending}
						onClick={onUseOwnModel}
						variant="secondary"
					>
						Choose my own model
					</Button>
					<Button
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
					</Button>
				</CardFooter>
			</Card>
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
