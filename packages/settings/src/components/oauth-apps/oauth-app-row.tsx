import {
	Delete02Icon,
	Key01Icon,
	RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { formatDistanceToNow } from "date-fns";
import type { OwnedOAuthApp } from "../../utils/api-client.ts";
import {
	SETTINGS_ROW_REVEAL_CLASS,
	SettingsItem,
} from "../shared/settings-rows.tsx";
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
	const tl = useLiteralMessages();
	const isDeleting =
		pendingAction?.kind === "delete" && pendingAction.clientId === app.clientId;
	const isRotating =
		pendingAction?.kind === "rotate" && pendingAction.clientId === app.clientId;
	const isPending = isDeleting || isRotating;

	const created = app.createdAt
		? formatDistanceToNow(new Date(app.createdAt), { addSuffix: true })
		: tl("recently");

	return (
		<SettingsItem
			actions={
				// Two revealed icon buttons rather than a menu: both stay plain
				// buttons so their accessible names keep working for keyboard and
				// assistive tech, and the slot reserves its width while hidden.
				<div className={SETTINGS_ROW_REVEAL_CLASS}>
					{app.clientType === "confidential" ? (
						<Button
							aria-label={tl("Rotate secret for {clientName}", {
								clientName: app.clientName,
							})}
							disabled={isPending}
							onClick={() =>
								onAction({ clientId: app.clientId, kind: "rotate" })
							}
							size="icon-sm"
							variant="ghost-muted"
						>
							<HugeiconsIcon icon={RefreshIcon} size={16} />
						</Button>
					) : null}
					<Button
						aria-label={tl("Delete {clientName}", {
							clientName: app.clientName,
						})}
						disabled={isPending}
						onClick={() => onAction({ clientId: app.clientId, kind: "delete" })}
						size="icon-sm"
						variant="ghost-muted"
					>
						<HugeiconsIcon icon={Delete02Icon} size={16} />
					</Button>
				</div>
			}
			description={tl("{clientType} · {applicationType} · Created {created}", {
				clientType:
					app.clientType === "public" ? tl("Public") : tl("Confidential"),
				applicationType: app.applicationType,
				created,
			})}
			title={
				<span className="flex min-w-0 items-center gap-2">
					<HugeiconsIcon
						className="shrink-0 text-muted-foreground"
						icon={Key01Icon}
						size={16}
					/>
					<span className="truncate">{app.clientName}</span>
				</span>
			}
		>
			<details className="group/details text-detail text-muted-foreground">
				<summary className="w-fit cursor-pointer select-none rounded-lg hover:text-foreground">
					Details
				</summary>
				<dl className="mt-2 flex flex-col gap-1">
					<div>
						<dt className="sr-only">Client ID</dt>
						<dd className="break-all font-mono">{app.clientId}</dd>
					</div>
					<div className="flex gap-1">
						<dt className="text-foreground">Redirect URIs:</dt>
						<dd className="min-w-0 break-all">{app.redirectUris.join(", ")}</dd>
					</div>
					<div className="flex gap-1">
						<dt className="text-foreground">Allowed scopes:</dt>
						<dd className="min-w-0">
							{app.scopes.map(scopeLabel).join(", ") || "None"}
						</dd>
					</div>
				</dl>
			</details>

			{isPending ? (
				<div className="flex flex-wrap items-center gap-2 pt-1">
					<span className="text-detail text-muted-foreground">
						{isDeleting
							? "Delete this OAuth app and revoke its tokens?"
							: "Rotate the secret now? The old secret stops working immediately."}
					</span>
					<Button
						onClick={() => onAction(pendingAction)}
						size="sm"
						variant={isDeleting ? "destructive" : "outline"}
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
