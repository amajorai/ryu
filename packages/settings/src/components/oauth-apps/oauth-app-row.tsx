import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { formatDistanceToNow } from "date-fns";
import { KeyRound, RefreshCw, Trash2 } from "lucide-react";
import type { OwnedOAuthApp } from "../../utils/api-client.ts";
import { SettingsItem } from "../shared/settings-rows.tsx";
import { type PendingAction, scopeLabel } from "./shared.ts";

export function OAuthAppRow({
	app,
	pendingAction,
	onAction,
	onCancelAction,
}: {
	app: OwnedOAuthApp;
	pendingAction: PendingAction;
	onAction: (action: PendingAction) => void;
	onCancelAction: () => void;
}) {
	const isDeleting =
		pendingAction?.kind === "delete" && pendingAction.clientId === app.clientId;
	const isRotating =
		pendingAction?.kind === "rotate" && pendingAction.clientId === app.clientId;
	const isPending = isDeleting || isRotating;

	return (
		<SettingsItem
			actions={
				<>
					{app.clientType === "confidential" ? (
						<Button
							aria-label={`Rotate secret for ${app.clientName}`}
							disabled={isPending}
							onClick={() =>
								onAction({ clientId: app.clientId, kind: "rotate" })
							}
							size="icon"
							variant="ghost"
						>
							<RefreshCw className="size-4" />
						</Button>
					) : null}
					<Button
						aria-label={`Delete ${app.clientName}`}
						disabled={isPending}
						onClick={() => onAction({ clientId: app.clientId, kind: "delete" })}
						size="icon"
						variant="ghost"
					>
						<Trash2 className="size-4 text-status-destructive" />
					</Button>
				</>
			}
			title={
				<span className="flex min-w-0 items-center gap-2">
					<KeyRound className="size-4 shrink-0 text-muted-foreground" />
					<span className="truncate">{app.clientName}</span>
					<Badge className="shrink-0" variant="secondary">
						{app.clientType === "public" ? "Public" : "Confidential"}
					</Badge>
					<Badge className="shrink-0" variant="outline">
						{app.applicationType}
					</Badge>
				</span>
			}
		>
			<div className="space-y-1 text-muted-foreground text-xs">
				<p className="break-all font-mono">{app.clientId}</p>
				<p>
					Created{" "}
					{app.createdAt
						? formatDistanceToNow(new Date(app.createdAt), {
								addSuffix: true,
							})
						: "recently"}
				</p>
				<p>
					<strong className="font-medium text-foreground">
						Redirect URIs:
					</strong>{" "}
					{app.redirectUris.join(", ")}
				</p>
				<p>
					<strong className="font-medium text-foreground">
						Allowed scopes:
					</strong>{" "}
					{app.scopes.map(scopeLabel).join(", ") || "None"}
				</p>
			</div>

			{isPending ? (
				<div className="flex flex-wrap items-center gap-2 pt-1">
					<span className="text-muted-foreground text-xs">
						{isDeleting
							? "Delete this OAuth app and revoke its tokens?"
							: "Rotate the secret now? The old secret stops working immediately."}
					</span>
					<Button
						onClick={() => onAction(pendingAction)}
						size="sm"
						variant={isDeleting ? "destructive" : "default"}
					>
						{isDeleting ? "Delete" : "Rotate"}
					</Button>
					<Button onClick={onCancelAction} size="sm" variant="ghost">
						Cancel
					</Button>
				</div>
			) : null}
		</SettingsItem>
	);
}
