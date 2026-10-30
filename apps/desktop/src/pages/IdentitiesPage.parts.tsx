import {
	Delete02Icon,
	Key01Icon,
	RefreshIcon,
	SquareLock01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useState } from "react";
import type { Connection, ConnectionStatus } from "@/src/lib/api/identities.ts";

/** Status badge for a connection's durable authentication state. */
export function StatusBadge({ status }: { status: ConnectionStatus }) {
	if (status === "AUTHENTICATED") {
		return (
			<Badge variant="secondary">
				<HugeiconsIcon className="size-3" icon={SquareLock01Icon} />
				Authenticated
			</Badge>
		);
	}
	return (
		<Badge variant="outline">
			<HugeiconsIcon className="size-3" icon={Key01Icon} />
			Needs auth
		</Badge>
	);
}

/** The create form: profile id (grouping key) + domain. */
export function CreateConnectionForm({
	creating,
	existingProfileIds,
	onCreate,
	onCancel,
}: {
	creating: boolean;
	existingProfileIds: string[];
	onCreate: (input: { profile_id: string; domain: string }) => Promise<void>;
	onCancel: () => void;
}) {
	const [profileId, setProfileId] = useState("");
	const [domain, setDomain] = useState("");

	const canSubmit = profileId.trim() !== "" && domain.trim() !== "";

	return (
		<div className="mx-auto max-w-xl space-y-4">
			<h2 className="font-medium text-lg">New connection</h2>
			<p className="text-muted-foreground text-sm">
				A profile groups every domain an agent should be logged in to. Reuse an
				existing profile name or create a new one.
			</p>
			<div className="space-y-1.5">
				<Label htmlFor="conn-profile">Profile</Label>
				<Input
					id="conn-profile"
					list="identity-profile-ids"
					onChange={(e) => setProfileId(e.target.value)}
					placeholder="personal"
					value={profileId}
				/>
				<datalist id="identity-profile-ids">
					{existingProfileIds.map((id) => (
						<option key={id} value={id} />
					))}
				</datalist>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="conn-domain">Domain</Label>
				<Input
					id="conn-domain"
					onChange={(e) => setDomain(e.target.value)}
					placeholder="app.example.com"
					value={domain}
				/>
			</div>
			<div className="flex gap-2">
				<Button
					disabled={!canSubmit}
					loading={creating}
					onClick={() => {
						onCreate({
							profile_id: profileId.trim(),
							domain: domain.trim(),
						});
					}}
					variant="mono"
				>
					Create
				</Button>
				<Button onClick={onCancel} variant="ghost">
					Cancel
				</Button>
			</div>
		</div>
	);
}

/** The detail pane for one connection: status, start-login, manual import, delete. */
export function ConnectionDetail({
	connection,
	deleting,
	importing,
	loggingIn,
	onDelete,
	onImport,
	onLogin,
	onRefresh,
	polling,
}: {
	connection: Connection;
	deleting: boolean;
	importing: boolean;
	loggingIn: boolean;
	onDelete: () => void;
	onImport: (state: string) => Promise<boolean>;
	onLogin: () => Promise<void>;
	onRefresh: () => void;
	polling: boolean;
}) {
	const [manualState, setManualState] = useState("");
	const [confirmDelete, setConfirmDelete] = useState(false);

	return (
		<div className="mx-auto max-w-xl space-y-5">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 space-y-1">
					<h2
						className="truncate font-medium text-lg"
						title={connection.domain}
					>
						{connection.domain}
					</h2>
					<p className="text-muted-foreground text-sm">
						Profile{" "}
						<span className="font-medium text-foreground">
							{connection.profile_id}
						</span>
					</p>
				</div>
				<StatusBadge status={connection.status} />
			</div>

			<div className="flex flex-wrap gap-2">
				<Button loading={loggingIn} onClick={onLogin} variant="mono">
					Start login
				</Button>
				<Button loading={polling} onClick={onRefresh} variant="ghost">
					{!polling && <HugeiconsIcon className="size-4" icon={RefreshIcon} />}
					Check status
				</Button>
				<Button
					loading={deleting}
					onClick={() => setConfirmDelete(true)}
					variant="destructive"
				>
					{!deleting && (
						<HugeiconsIcon className="size-4" icon={Delete02Icon} />
					)}
					Delete
				</Button>
				<AlertDialog onOpenChange={setConfirmDelete} open={confirmDelete}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Delete this connection?</AlertDialogTitle>
							<AlertDialogDescription>
								This permanently deletes the connection to{" "}
								<span className="font-medium text-foreground">
									{connection.domain}
								</span>{" "}
								and its saved sign-in. This cannot be undone.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction
								disabled={deleting}
								onClick={(e) => {
									// Keep the dialog open while the request runs.
									e.preventDefault();
									onDelete();
									setConfirmDelete(false);
								}}
								variant="destructive"
							>
								{deleting ? "Deleting…" : "Delete"}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</div>

			<div className="space-y-2 rounded-lg bg-card p-4">
				<Label htmlFor="manual-state">Manual import</Label>
				<p className="text-muted-foreground text-xs">
					Paste a cookie, token, or session blob to authenticate this connection
					directly. It is sealed before it touches disk and is never returned or
					shown to the model.
				</p>
				<Textarea
					className="min-h-28"
					id="manual-state"
					onChange={(e) => setManualState(e.target.value)}
					placeholder="session=…; token=…"
					value={manualState}
					variant="code-caption"
				/>
				<Button
					disabled={manualState.trim() === ""}
					loading={importing}
					onClick={async () => {
						if (await onImport(manualState.trim())) {
							setManualState("");
						}
					}}
					size="sm"
					variant="mono"
				>
					Import credentials
				</Button>
			</div>
		</div>
	);
}
