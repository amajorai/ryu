// External audit devices (file, syslog, socket, HTTP) and their delivery
// health, read-only. Devices are configured with `ryu secrets audit-device`
// or the declarative init file; the route needs `admin` on `sys/audit`, so the
// section hides itself for anyone else.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useQuery } from "@tanstack/react-query";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	listVaultAuditDevices,
	type VaultAuditDeviceListing,
} from "@/src/lib/api/vault-admin.ts";
import { isForbidden, vaultErrorMessage } from "./vault-errors.ts";

function deviceTarget(device: VaultAuditDeviceListing): string {
	const options = device.options;
	if (options === null || typeof options !== "object") {
		return "";
	}
	const record = options as Record<string, unknown>;
	const value = record.path ?? record.address ?? record.url;
	return typeof value === "string" ? value : "";
}

export function VaultAuditDevices({ target }: { target: ApiTarget }) {
	const tl = useLiteralMessages();
	const devicesQuery = useQuery({
		queryKey: ["vault", "audit-devices", target.url],
		queryFn: () => listVaultAuditDevices(target),
	});

	if (isForbidden(devicesQuery.error)) {
		return null;
	}
	const listing = devicesQuery.data;

	return (
		<SettingsSection
			caption="Every audit row is also sent to these devices, without values. Add or change them with ryu secrets audit-device."
			title="Audit devices"
		>
			{listing?.failClosed ? (
				<p className="px-3.5 text-muted-foreground text-xs" role="status">
					Fail-closed is on: an operation fails when no file or syslog device
					records it.
				</p>
			) : null}
			<SettingsCard className="divide-y p-0">
				{devicesQuery.isLoading ? (
					<SkeletonRows inset="panel" rows={2} />
				) : devicesQuery.error ? (
					<p className="p-4 text-sm text-status-destructive">
						{vaultErrorMessage(
							devicesQuery.error,
							"Could not load the audit devices.",
							tl
						)}
					</p>
				) : listing?.devices.length ? (
					<ul className="divide-y">
						{listing.devices.map((device) => (
							<li
								className="flex items-start justify-between gap-4 px-4 py-3"
								key={device.id}
							>
								<div className="min-w-0">
									<p className="flex flex-wrap items-center gap-2 text-sm">
										<code className="font-mono">{device.id}</code>
										<Badge variant="outline">{device.kind}</Badge>
										{device.enabled ? null : (
											<Badge variant="secondary">Disabled</Badge>
										)}
									</p>
									<p className="mt-0.5 truncate text-muted-foreground text-xs">
										{deviceTarget(device)}
									</p>
									{device.health.failing && device.health.lastError ? (
										<p className="mt-0.5 truncate text-status-destructive text-xs">
											{device.health.lastError}
										</p>
									) : null}
								</div>
								{device.health.failing ? (
									<Badge variant="destructive">Failing</Badge>
								) : (
									<Badge variant="outline">Healthy</Badge>
								)}
							</li>
						))}
					</ul>
				) : (
					<p className="p-6 text-center text-muted-foreground text-sm">
						No audit devices. Rows stay in the vault's own chained log.
					</p>
				)}
			</SettingsCard>
		</SettingsSection>
	);
}
