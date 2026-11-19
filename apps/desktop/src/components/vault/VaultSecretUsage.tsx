// The broker services that use a vault value: a "Used by" section in the
// value's detail dialog and a warning in the delete confirmation, so a value
// a service depends on is not deleted by surprise. A caller who may not list
// broker services sees neither (the query fails quietly).

import { useLiteralMessages } from "@ryu/i18n/react";
import { useQuery } from "@tanstack/react-query";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { listVaultBrokerUsage } from "@/src/lib/api/vault-broker-usage.ts";

export function useVaultSecretUsage(
	target: ApiTarget,
	name: string | null
): string[] {
	const query = useQuery({
		enabled: name !== null,
		queryFn: () => listVaultBrokerUsage(target, name ?? ""),
		queryKey: ["vault", "broker-usage", target.url, name],
		retry: false,
	});
	return query.data ?? [];
}

/** "Used by" section for a value's detail dialog. */
export function VaultUsedBy({
	name,
	target,
}: {
	name: string;
	target: ApiTarget;
}) {
	const services = useVaultSecretUsage(target, name);
	return (
		<section aria-labelledby="vault-detail-used-by" className="space-y-2">
			<h3 className="font-semibold text-sm" id="vault-detail-used-by">
				Used by
			</h3>
			{services.length === 0 ? (
				<p className="text-muted-foreground text-xs">
					No broker service uses this value.
				</p>
			) : (
				<ul className="flex flex-wrap gap-1.5">
					{services.map((service) => (
						<li
							className="rounded-md border border-border px-2 py-0.5 font-mono text-xs"
							key={service}
						>
							{service}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

/** Warning in the delete confirmation when broker services use the value. */
export function VaultDeleteUsageWarning({
	name,
	target,
}: {
	name: string | null;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const services = useVaultSecretUsage(target, name);
	if (services.length === 0) {
		return null;
	}
	return (
		<p className="text-sm text-status-warning" role="alert">
			{tl(
				"Broker services use this value ({services}). They will fail until you point them at another value.",
				{ services: services.join(", ") }
			)}
		</p>
	);
}
