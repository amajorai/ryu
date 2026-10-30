import { useLiteralMessages } from "@ryu/i18n/react";
import { useQuery } from "@tanstack/react-query";
import { type ComponentProps, useEffect, useState } from "react";
import { useNodeSystemInfo } from "@/src/hooks/useNodeSystemInfo.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { fetchGatewayStatus } from "@/src/lib/api/gateway.ts";
import { NodeStats } from "./NodeSelector-hardware.tsx";
import { ServiceRow } from "./NodeSelector-service-row.tsx";
import type { Tone } from "./NodeSelector-status.tsx";

export function NodeMenuHardware({
	target,
	enabled,
}: {
	target: ApiTarget;
	enabled: boolean;
}) {
	const { data: info } = useNodeSystemInfo(target, enabled);
	return info ? (
		<div className="px-3 pt-1 pb-1.5">
			<NodeStats info={info} />
		</div>
	) : null;
}

export function NodeMenuGateway({
	coreReachable,
	target,
	...props
}: Omit<ComponentProps<typeof ServiceRow>, "label" | "target"> & {
	coreReachable: boolean;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const { data } = useQuery({
		queryKey: [
			"node-gateway-status",
			target.url,
			target.token ?? null,
			target.userJwt ?? null,
		],
		queryFn: ({ signal }) => fetchGatewayStatus(target, signal),
		enabled: coreReachable,
		refetchInterval: 30_000,
		retry: false,
	});
	const count = data?.health?.providers.length ?? 0;
	const label =
		props.running && count > 0
			? tl("Gateway · {count, plural, one {# provider} other {# providers}}", {
					count,
				})
			: "Gateway";
	return <ServiceRow {...props} label={label} target={target} />;
}

/** How long Core may miss status polls before the dialog's Core-backed pages
 *  treat it as gone. Covers a couple of polls of a reconnect blip. */
const CORE_BLIP_GRACE_MS = 12_000;

/**
 * `reachable`, but a drop only counts once it has lasted
 * {@link CORE_BLIP_GRACE_MS}. Recovery counts at once, and a new `key` (another
 * computer) starts from its own reading instead of inheriting the last one's.
 */
export function useSteadyReachable(reachable: boolean, key: string): boolean {
	const [steady, setSteady] = useState({ key, reachable });
	if (steady.key !== key) {
		setSteady({ key, reachable });
	}
	useEffect(() => {
		if (reachable) {
			setSteady({ key, reachable: true });
			return;
		}
		const timer = setTimeout(
			() => setSteady({ key, reachable: false }),
			CORE_BLIP_GRACE_MS
		);
		return () => clearTimeout(timer);
	}, [reachable, key]);
	return reachable || (steady.key === key && steady.reachable);
}

export const TONE_LABEL = {
	green: "Online",
	amber: "Online · some services need attention",
	red: "Unreachable",
	pending: "Checking…",
} satisfies Record<Tone, string>;
