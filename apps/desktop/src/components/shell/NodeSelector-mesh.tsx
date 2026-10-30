import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@/lib/utils.ts";
import type { ConnectedClient } from "@/src/lib/api/connections.ts";
import type {
	MeshPeerEntry,
	MeshPeersResult,
	MeshStatus,
} from "@/src/lib/api/mesh.ts";
import {
	BEARER_SOURCE_NONE,
	ingressLabel,
	MESH_BACKEND_CLOUDFLARED,
	MESH_BACKEND_OPENTUNNEL,
	MESH_BACKEND_PLUGIN,
	MESH_BACKEND_TAILCAT,
	type WebhookIngressStatus,
} from "@/src/lib/api/mesh.ts";
import {
	connectionDisplayName,
	connectionSurfaceMeta,
} from "@/src/lib/connection-surface.ts";
import { AutoScrollText } from "./AutoScrollText.tsx";

/**
 * One reachable mesh peer, rendered as an "Add" row. When a candidate bearer is
 * available (`bearerAvailable`), the whole row is a button that registers the
 * peer WITH that token, so its protected routes don't 401. When no bearer exists
 * (`bearer_source: "none"`), the row is inert and shows an honest "needs token"
 * label — we never silently add a tokenless node that would 401.
 */
function MeshPeerRow({
	peer,
	onAddPeer,
}: {
	peer: MeshPeerEntry;
	onAddPeer: (peer: MeshPeerEntry) => void;
}) {
	const dot = (
		<span
			aria-hidden
			className={cn(
				"size-1.5 shrink-0 rounded-full",
				peer.online ? "bg-success" : "bg-muted-foreground/30"
			)}
		/>
	);
	const label = peer.name || peer.hostOrDns;

	if (!peer.bearerAvailable) {
		// Honest state: no usable node-admittance token, so adding this peer would
		// 401. Show it as non-addable with a clear reason instead.
		return (
			<div className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs opacity-70">
				{dot}
				<span
					className="flex-1 truncate text-left text-muted-foreground"
					title={label}
				>
					{label}
				</span>
				<span className="shrink-0 text-status-warning text-xs">
					needs token
				</span>
			</div>
		);
	}

	return (
		<button
			className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent"
			onClick={() => onAddPeer(peer)}
			type="button"
		>
			{dot}
			<span
				className="flex-1 truncate text-left text-muted-foreground"
				title={label}
			>
				{label}
			</span>
			<HugeiconsIcon
				className="shrink-0 text-muted-foreground/70"
				icon={Add01Icon}
				size={11}
			/>
		</button>
	);
}

/**
 * Mesh section in the node dropdown. Renders nothing when mesh is not relevant
 * (`status === null` — disabled/absent), so a vanilla install shows no mesh row.
 * When enabled it shows the reachability dot, this node's MagicDNS name, an
 * optional ingress caption, and a mesh-peer Add picker.
 *
 * The peer list comes from `GET /api/mesh/peers` ({@link MeshPeersResult}), which
 * carries a candidate node-admittance bearer per peer. Adding a peer attaches
 * that token so the added node no longer 401s. When no bearer is available
 * (`bearerSource: "none"`) every peer renders as an honest "needs token" state
 * and the endpoint's provisioning `note` is surfaced.
 */
export function MeshSection({
	status,
	reachable,
	ingress,
	peers,
	onAddPeer,
}: {
	status: MeshStatus | null;
	reachable: boolean | null;
	ingress: WebhookIngressStatus | null;
	peers: MeshPeersResult | null;
	onAddPeer: (peer: MeshPeerEntry) => void;
}) {
	const tl = useLiteralMessages();
	if (status === null) {
		return null;
	}
	const dotColor = reachable ? "bg-success" : "bg-warning";
	const peerList = peers?.peers ?? [];
	const noBearer =
		peers !== null &&
		peerList.length > 0 &&
		peers.bearerSource === BEARER_SOURCE_NONE;
	const networkLabel =
		status.backend === MESH_BACKEND_OPENTUNNEL ||
		status.backend === MESH_BACKEND_PLUGIN
			? status.publicUrl
				? "Public URL ready"
				: (status.backendError ?? "Tunnel starting…")
			: status.backend === MESH_BACKEND_CLOUDFLARED
				? status.cloudflaredUrl
					? "Cloudflare URL ready"
					: reachable
						? "Cloudflare connected"
						: "Cloudflare starting…"
				: status.backend === MESH_BACKEND_TAILCAT
					? status.tailcatAddress
						? "Tailcat address ready"
						: reachable
							? "Tailcat connected"
							: "Tailcat starting…"
					: (status.magicDnsName ?? (reachable ? "Connected" : "Connecting…"));
	return (
		<div className="px-1 py-0.5">
			<p className="px-2 pt-0.5 pb-1 font-medium text-muted-foreground/70 text-xs">
				Network
			</p>
			<div className="flex items-center gap-2 px-2 py-1 text-xs">
				<span
					aria-hidden
					className={cn("size-1.5 shrink-0 rounded-full", dotColor)}
				/>
				<span
					className="flex-1 truncate text-muted-foreground"
					title={networkLabel}
				>
					{networkLabel}
				</span>
				{status.backend && (
					<span className="shrink-0 text-muted-foreground/70 text-xs">
						{status.backend}
					</span>
				)}
			</div>
			{status.publicUrl && (
				<p className="truncate px-2 pb-0.5 text-muted-foreground/70 text-xs">
					<a
						className="underline-offset-2 hover:underline"
						href={status.publicUrl}
						rel="noopener noreferrer"
						target="_blank"
						title={status.publicUrl}
					>
						{status.publicUrl}
					</a>
				</p>
			)}
			{ingress?.up && ingress.kind && (
				// Through `ingressLabel`, not raw: Core serializes this as
				// `IngressKind::as_str()`, which is kebab-case (`own-relay`,
				// `tailscale-funnel`), and rendering that verbatim showed the wire
				// value in the UI. The same helper backs the Integrations tab picker,
				// so the two surfaces name a backend identically.
				<p className="px-2 pb-0.5 text-muted-foreground/70 text-xs">
					{tl("Ingress: {kind}", { kind: ingressLabel(ingress.kind) })}
				</p>
			)}
			{peerList.length > 0 && (
				<div className="space-y-0.5 pt-0.5">
					{peerList.map((peer) => (
						<MeshPeerRow
							key={peer.name || peer.hostOrDns}
							onAddPeer={onAddPeer}
							peer={peer}
						/>
					))}
				</div>
			)}
			{noBearer && (
				<p className="px-2 pt-0.5 pb-0.5 text-muted-foreground/70 text-xs">
					{peers?.note ??
						"Peer needs an enrollment token — provision the same RYU_TOKEN on both computers, or add the peer's own token by hand."}
				</p>
			)}
		</div>
	);
}

/** "active 5s ago" / "now" from a unix-seconds last-seen stamp. */
function relativeAge(lastSeen: number): string {
	const secs = Math.max(0, Math.floor(Date.now() / 1000) - lastSeen);
	if (secs < 10) {
		return "now";
	}
	if (secs < 60) {
		return `${secs}s ago`;
	}
	return `${Math.floor(secs / 60)}m ago`;
}

/**
 * "Connected" section in the node dropdown: the clients currently talking to
 * THIS node (desktop / CLI / mobile / extension), newest activity first. This is
 * presence/attribution behind the shared node token, NOT verified identity or
 * isolation (see apps/core/src/connections) — so it answers "who is here", never
 * "who can see what". Renders nothing when no client has declared a `client_id`
 * (e.g. only older clients connected), so it never shows an empty box.
 */
export function ConnectedSection({
	clients,
	selfClientId,
}: {
	clients: ConnectedClient[];
	selfClientId: string;
}) {
	const tl = useLiteralMessages();
	if (clients.length === 0) {
		return null;
	}
	return (
		<div className="px-1 py-0.5">
			<p className="px-2 pt-0.5 pb-1 font-medium text-muted-foreground/70 text-xs">
				{tl("Connected · {count}", { count: clients.length })}
			</p>
			{clients.map((c) => {
				const surface = connectionSurfaceMeta(c.surface);
				const displayName = connectionDisplayName(c);
				return (
					<div
						className="flex items-center gap-2 px-2 py-1 text-xs"
						key={c.clientId}
					>
						<span
							aria-hidden
							className="size-1.5 shrink-0 rounded-full bg-success"
						/>
						<HugeiconsIcon
							aria-hidden
							className="size-3.5 shrink-0 text-muted-foreground"
							icon={surface.icon}
						/>
						<AutoScrollText
							className="flex-1 text-muted-foreground"
							title={`${displayName}${c.clientId === selfClientId ? " (you)" : ""}`}
						>
							{displayName}
							{c.clientId === selfClientId && (
								<span className="text-muted-foreground/70"> (you)</span>
							)}
						</AutoScrollText>
						<span className="shrink-0 text-muted-foreground/70 text-xs">
							{surface.label}
						</span>
						<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
							{relativeAge(c.lastSeen)}
						</span>
					</div>
				);
			})}
		</div>
	);
}
