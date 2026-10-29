import { Button } from "@ryu/ui/components/button.tsx";
import { formatDistanceToNow } from "date-fns";
import { AppWindow, Trash2 } from "lucide-react";
import type { OAuthApp } from "../../utils/api-client.ts";
import {
	SettingsCard,
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
			<SettingsCard>
				<p className="text-center text-muted-foreground text-sm">
					No authorized apps.
				</p>
			</SettingsCard>
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
									<span className="text-muted-foreground text-xs">
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
									className="size-8 shrink-0"
									disabled={isRevoking}
									onClick={() => onStartRevoke(app.clientId)}
									size="icon"
									variant="ghost"
								>
									<Trash2 className="size-4" />
								</Button>
							)
						}
						key={app.clientId}
						title={
							<span className="flex min-w-0 items-center gap-2">
								<AppWindow className="size-4 shrink-0 text-muted-foreground" />
								<span className="truncate" title={app.clientName}>
									{app.clientName}
								</span>
							</span>
						}
					>
						<p className="text-muted-foreground text-xs">
							{scopeList || "No scopes"} · Authorized{" "}
							{formatDistanceToNow(new Date(app.grantedAt), {
								addSuffix: true,
							})}
						</p>
					</SettingsItem>
				);
			})}
		</SettingsGroup>
	);
}
