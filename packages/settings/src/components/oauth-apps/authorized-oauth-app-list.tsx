import { AppWindowIcon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { formatDistanceToNow } from "date-fns";
import type { OAuthApp } from "../../utils/api-client.ts";
import {
	SETTINGS_ROW_REVEAL_CLASS,
	SettingsGroup,
	SettingsItem,
} from "../shared/settings-rows.tsx";
import { scopeLabel } from "./shared.ts";

export function AuthorizedOAuthAppList({
	apps,
	confirmRevoke,
	isRevoking,
	onConfirmRevoke,
	onRevoke,
	onStartRevoke,
}: {
	apps: OAuthApp[];
	confirmRevoke: string | null;
	isRevoking: boolean;
	onConfirmRevoke: () => void;
	onRevoke: (clientId: string) => void;
	onStartRevoke: (clientId: string) => void;
}) {
	if (apps.length === 0) {
		return (
			<p className="py-3 text-muted-foreground text-sm">No authorized apps.</p>
		);
	}

	return (
		<SettingsGroup>
			{apps.map((app) => {
				const isConfirming = confirmRevoke === app.clientId;
				const scopeList = app.scopes
					.split(/[,\s]+/)
					.filter(Boolean)
					.map(scopeLabel)
					.join(", ");

				return (
					<SettingsItem
						actions={
							isConfirming ? (
								<div className="flex flex-wrap items-center justify-end gap-2">
									<span className="text-detail text-muted-foreground">
										Revoke access?
									</span>
									<Button
										disabled={isRevoking}
										onClick={() => onRevoke(app.clientId)}
										size="sm"
										variant="destructive"
									>
										Revoke
									</Button>
									<Button
										disabled={isRevoking}
										onClick={onConfirmRevoke}
										size="sm"
										variant="ghost"
									>
										Cancel
									</Button>
								</div>
							) : (
								<Button
									aria-label={`Revoke access for ${app.clientName}`}
									className={SETTINGS_ROW_REVEAL_CLASS}
									disabled={isRevoking}
									onClick={() => onStartRevoke(app.clientId)}
									size="icon-sm"
									variant="ghost-muted"
								>
									<HugeiconsIcon icon={Delete02Icon} size={16} />
								</Button>
							)
						}
						description={
							<>
								{scopeList || "No scopes"} · Authorized{" "}
								{formatDistanceToNow(new Date(app.grantedAt), {
									addSuffix: true,
								})}
							</>
						}
						key={app.clientId}
						title={
							<span className="flex min-w-0 items-center gap-2">
								<HugeiconsIcon
									className="shrink-0 text-muted-foreground"
									icon={AppWindowIcon}
									size={16}
								/>
								<span className="truncate" title={app.clientName}>
									{app.clientName}
								</span>
							</span>
						}
					/>
				);
			})}
		</SettingsGroup>
	);
}
