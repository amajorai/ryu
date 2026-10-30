import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { type AppInfo, setPluginGrants } from "@/src/lib/api/plugins.ts";
import {
	grantDescription,
	grantLabel,
} from "@/src/lib/plugins/grant-labels.ts";

// The per-app permissions editor: one row per grant the app DECLARED. When the app
// is enabled each row is a Switch reflecting whether the grant is currently in the
// app's APPROVED set; toggling it POSTs the new subset to `/api/plugins/:id/grants`.
// When disabled the grants are read-only (grant editing requires an enabled app).
export function AppPermissionsEditor({
	app,
	target,
	onGrantsChanged,
}: {
	app: Pick<
		AppInfo,
		| "id"
		| "name"
		| "enabled"
		| "approvedGrants"
		| "permissionGrants"
		| "optionalPermissionGrants"
	>;
	target: ApiTarget;
	onGrantsChanged: () => void;
}) {
	const tl = useLiteralMessages();
	const [pending, setPending] = useState<string | null>(null);
	const approved = new Set(app.approvedGrants);
	const optional = new Set(
		(app.optionalPermissionGrants ?? []).filter(
			(grant) => !app.permissionGrants.includes(grant)
		)
	);
	const declared = Array.from(new Set([...app.permissionGrants, ...optional]));

	const setGrant = async (grant: string, on: boolean) => {
		setPending(grant);
		const next = new Set(app.approvedGrants);
		if (on) {
			next.add(grant);
		} else {
			next.delete(grant);
		}
		try {
			await setPluginGrants(target, app.id, Array.from(next));
			onGrantsChanged();
		} catch (e) {
			toast.error("Couldn't update permissions", {
				description: e instanceof Error ? e.message : "Please try again.",
			});
		} finally {
			setPending(null);
		}
	};

	return (
		<section className="flex flex-col gap-2">
			<h3 className="font-medium text-sm">Permissions</h3>
			<div className="flex flex-col gap-1.5">
				{declared.map((grant) => {
					const description = grantDescription(grant);
					const on = approved.has(grant);
					return (
						<div
							className="flex items-center justify-between gap-3 rounded-lg border px-3 py-1.5"
							key={grant}
						>
							<div className="min-w-0">
								<div className="font-medium text-sm">
									{grantLabel(grant)}
									{optional.has(grant) ? (
										<span className="ml-2 font-normal text-muted-foreground text-xs">
											Optional
										</span>
									) : null}
								</div>
								{description ? (
									<div className="text-muted-foreground text-xs">
										{description}
									</div>
								) : null}
							</div>
							{app.enabled ? (
								<Switch
									aria-label={
										on
											? tl('Revoke "{grantName}" for {appName}', {
													appName: app.name,
													grantName: grantLabel(grant),
												})
											: tl('Grant "{grantName}" for {appName}', {
													appName: app.name,
													grantName: grantLabel(grant),
												})
									}
									checked={on}
									disabled={pending !== null}
									onCheckedChange={(checked) => {
										setGrant(grant, checked).catch(() => {
											// Errors surfaced via toast in setGrant.
										});
									}}
								/>
							) : (
								<Badge variant="secondary">{on ? "Granted" : "Off"}</Badge>
							)}
						</div>
					);
				})}
			</div>
			{app.enabled ? null : (
				<p className="text-muted-foreground text-xs">
					Enable this app to change its permissions.
				</p>
			)}
		</section>
	);
}
