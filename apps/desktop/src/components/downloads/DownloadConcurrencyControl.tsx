// apps/desktop/src/components/downloads/DownloadConcurrencyControl.tsx
//
// "How many at once" for the download center — a node-scoped Core setting
// (GET/PUT /api/downloads/settings), surfaced right where the queue is visible
// rather than buried in a settings tab, because "why is this taking so long" and
// "can it go faster" are the same moment.
//
// Auto is the default and is not a euphemism for a fixed number: Core hill-climbs
// the slot count against measured throughput (see the `autotune` module), so the
// row reports what it currently resolves to and the speed it reasoned from. The
// manual option exists for the two cases the tuner cannot see — a metered or
// shared connection the user wants to keep headroom on, and a server that starts
// refusing parallel connections.

import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import {
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { type ApiTarget, apiUrl } from "@/src/lib/api/client.ts";
import {
	type ConcurrencyMode,
	type DownloadSettings,
	getDownloadSettings,
	setDownloadSettings,
} from "@/src/lib/api/downloads.ts";
import { formatBytes } from "./DownloadRow.tsx";

const AUTO_VALUE = "auto";
interface Resource {
	id: number;
	pending: Promise<void> | null;
}
const resources = new WeakMap<QueryClient, Map<string, Resource>>();
let nextResource = 0;
let nextOwner = 0;
function resourceFor(client: QueryClient, target: ApiTarget): Resource {
	let map = resources.get(client);
	if (!map) {
		map = new Map();
		resources.set(client, map);
	}
	// Core concurrency is shared by the physical endpoint, independent of credentials.
	// UI/query ownership remains a separate opaque full-authority generation.
	const identity = target.url.replace(/\/$/, "")
		? apiUrl(target, "/api/downloads/settings")
		: "unconfigured-download-endpoint";
	let resource = map.get(identity);
	if (!resource) {
		resource = { id: ++nextResource, pending: null };
		map.set(identity, resource);
	}
	return resource;
}
function describe(settings: DownloadSettings, tl: LiteralMessage): string {
	const slotCount = String(settings.effective_slots);
	if (settings.mode === "manual") {
		return tl("{slotCount} at a time", { slotCount });
	}
	return settings.measured_bps > 0
		? tl("{slotCount} at a time · tuned for {measuredSpeed}/s", {
				measuredSpeed: formatBytes(settings.measured_bps),
				slotCount,
			})
		: tl("{slotCount} at a time · measuring your connection", { slotCount });
}
export function DownloadConcurrencyControl() {
	const node = useActiveNode();
	const client = useQueryClient();
	const scope = useMemo(() => {
		const target = {
			url: node.url,
			token: node.token ?? null,
			userJwt: node.userJwt ?? null,
		};
		return {
			target,
			resource: resourceFor(client, target),
			owner: ++nextOwner,
		};
	}, [client, node.url, node.token, node.userJwt]);
	return <ScopedDownloadConcurrencyControl key={scope.owner} {...scope} />;
}
function ScopedDownloadConcurrencyControl({
	target,
	resource,
	owner,
}: {
	target: ApiTarget;
	resource: Resource;
	owner: number;
}) {
	const tl = useLiteralMessages();
	const client = useQueryClient();
	const mounted = useRef(true);
	const pending = useRef(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const queryKey = ["downloads", "settings", resource.id, owner] as const;
	const query = useQuery({
		queryKey,
		queryFn: async ({ signal }) => {
			await resource.pending;
			if (signal.aborted) {
				throw new Error("Download settings read retired");
			}
			return getDownloadSettings(target);
		},
		retry: false,
		refetchInterval: 10_000,
	});
	const mutation = useMutation({
		mutationFn: async ({
			mode,
			slots,
			ack,
		}: {
			mode: ConcurrencyMode;
			slots?: number;
			ack: { promise: Promise<void>; release: () => void };
		}) => {
			try {
				await client.cancelQueries({ queryKey, exact: true });
				return await setDownloadSettings(target, mode, slots);
			} finally {
				if (resource.pending === ack.promise) {
					resource.pending = null;
				}
				ack.release();
			}
		},
		onSuccess: (next) => {
			if (mounted.current) {
				client.setQueryData(queryKey, next);
				setSaveError(null);
			}
		},
		onError: (error) => {
			if (mounted.current) {
				setSaveError(error instanceof Error ? error.message : String(error));
			}
		},
		onSettled: () => {
			if (mounted.current) {
				pending.current = false;
			}
		},
	});
	const data = query.data;
	if (!data) {
		if (query.isError) {
			return (
				<div className="text-right">
					<p className="text-destructive text-sm" role="alert">
						Could not load download settings.
					</p>
					<button
						disabled={query.isFetching}
						onClick={() => {
							void query.refetch();
						}}
						type="button"
					>
						Retry
					</button>
				</div>
			);
		}
		return (
			<span className="text-muted-foreground text-xs" role="status">
				Loading download settings…
			</span>
		);
	}
	const options = [
		{ label: "Auto", value: AUTO_VALUE },
		...Array.from(
			{ length: data.max_slots - data.min_slots + 1 },
			(_, i) => data.min_slots + i
		).map((n) => ({
			label:
				n === 1
					? "1 at a time"
					: tl("{slotCount} at a time", { slotCount: String(n) }),
			value: String(n),
		})),
	];
	return (
		<div className="flex flex-col items-end gap-1">
			<Select
				disabled={data.env_locked || mutation.isPending}
				items={options}
				onValueChange={(next) => {
					if (next === null || data.env_locked || pending.current) {
						return;
					}
					if (resource.pending) {
						setSaveError(
							"A download setting is already pending for this connection."
						);
						return;
					}
					pending.current = true;
					setSaveError(null);
					let release = () => {};
					const promise = new Promise<void>((resolve) => {
						release = resolve;
					});
					// Install the shared barrier synchronously, before Tanstack schedules the mutation.
					resource.pending = promise;
					const ack = { promise, release };
					mutation.mutate(
						next === AUTO_VALUE
							? { mode: "auto", ack }
							: { mode: "manual", slots: Number(next), ack }
					);
				}}
				value={data.mode === "auto" ? AUTO_VALUE : String(data.manual_slots)}
			>
				<SelectTrigger
					aria-label="Concurrent downloads"
					className="h-8 w-40 text-sm"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{options.map((option) => (
						<SelectItem key={option.value} value={option.value}>
							{option.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<span className="type-caption text-muted-foreground">
				{data.env_locked
					? "Set by RYU_MAX_CONCURRENT_DOWNLOADS on this node"
					: describe(data, tl)}
			</span>
			{saveError && (
				<p className="text-destructive text-sm" role="alert">
					{tl(
						"Could not save download settings. {saveError} Try the same choice again.",
						{ saveError }
					)}
				</p>
			)}
		</div>
	);
}
