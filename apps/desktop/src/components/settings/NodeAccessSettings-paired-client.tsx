import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	canRevokePairedClient,
	describePairingConstraints,
	formatPairingTimestamp,
	getPairedClientStatus,
	type PairedClient,
} from "./NodeAccessSettings.model.ts";
import { ScopeList } from "./NodeAccessSettings-scope-list.tsx";

export function PairedClientItem({
	busy,
	client,
	revoke,
}: {
	busy: boolean;
	client: PairedClient;
	revoke: (client: PairedClient) => Promise<void>;
}) {
	const tl = useLiteralMessages();
	return (
		<li className="flex items-start justify-between gap-3 py-3" key={client.id}>
			<div className="min-w-0">
				<div className="flex flex-wrap items-center gap-2">
					<p className="truncate text-sm" title={client.name}>
						{client.name}
					</p>
					<span className="text-muted-foreground text-xs">
						{getPairedClientStatus(client)}
					</span>
				</div>
				<ScopeList
					emptyLabel={
						client.granted_scopes === undefined &&
						(client.schema_version ?? 0) < 2
							? "Legacy read-only access"
							: "No capabilities granted"
					}
					label="Granted access"
					scopes={client.granted_scopes}
				/>
				<p className="mt-2 text-muted-foreground text-xs">
					{tl("Binding: {constraints}", {
						constraints: describePairingConstraints(client.constraints).join(
							", "
						),
					})}
				</p>
				<p className="text-muted-foreground text-xs">
					{client.expires_at == null
						? "Does not expire"
						: tl("Expires {time}", {
								time:
									formatPairingTimestamp(client.expires_at) ??
									tl("at an invalid time"),
							})}
					{client.revoked_at == null
						? ""
						: ` ${tl("· Revoked {time}", { time: formatPairingTimestamp(client.revoked_at) ?? tl("at an invalid time") })}`}
				</p>
			</div>
			{canRevokePairedClient(client) ? (
				<Button
					aria-label={tl("Revoke {name}", { name: client.name })}
					disabled={busy}
					onClick={() => void revoke(client)}
					size="sm"
					variant="ghost"
				>
					Revoke
				</Button>
			) : null}
		</li>
	);
}
