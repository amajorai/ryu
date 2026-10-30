// DesktopStreamPanel — the "Virtual Desktop" workspace panel.
//
// Live, INTERACTIVE stream of the active node's virtual desktop. The `@ryu/desktop`
// sidecar brings up headless Linux displays on the node, and this panel connects an
// RFB client (noVNC) to the authenticated Core WebSocket route for the selected Bot.
// Pixels come down the socket and mouse/keyboard go back up to the same selected
// Bot screen. The Virtual Desktop satellite owns those sessions end to end.
//
// Managed cloud nodes allocate one screen per Bot. Self-hosted and local Linux nodes
// retain the legacy single-screen lane. The stream rides Core's existing port — no
// new firewall rule, and no sidecar port is ever exposed. When the app is disabled or
// the sidecar reports no display, the panel degrades to a clear prompt instead of a
// dead canvas.

import {
	VncCanvas,
	type VncConnectionStatus,
} from "@ryu/blocks/session-box/vnc-canvas.tsx";
import { requestWebSocketTicket } from "@ryuhq/core-client/client.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import { realtimeJwtForTarget } from "@/src/lib/api/client.ts";
import { clearMediaSource, publishMediaSource } from "@/src/lib/media-pip.ts";

/** The node panel shows a dropped stream and waits for Reconnect, as before. */
const NO_AUTOMATIC_RECONNECT: readonly number[] = [];

const DESKTOP_PLUGIN_ID = "@ryu/desktop";

/** Build the exact Core ext-proxy path bound into a noVNC WebSocket ticket. */
export function desktopWsPath(agentId = "ryu"): string {
	const safeAgentId = agentId.trim();
	return safeAgentId
		? `/api/ext/ws/@ryu/desktop/bots/${encodeURIComponent(safeAgentId)}/ws`
		: "/api/ext/ws/@ryu/desktop/ws";
}

/** Build the noVNC WebSocket URL with an opaque one-use ticket. */
export function desktopWsUrl(
	url: string,
	ticket: string,
	agentId = "ryu"
): string {
	const wsUrl = new URL(desktopWsPath(agentId), url);
	wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
	wsUrl.searchParams.set("ticket", ticket);
	return wsUrl.toString();
}

export function DesktopStreamPanel({ active = true }: { active?: boolean }) {
	const { apps } = useApps();
	const { agents } = useAgents();
	const node = useActiveNode();
	const [status, setStatus] = useState<VncConnectionStatus>("idle");
	const [selectedAgentId, setSelectedAgentId] = useState("ryu");
	// Bumped by Connect/Reconnect: remounting the viewer starts a fresh attempt.
	const [connection, setConnection] = useState(0);
	const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
	const sourceId = `desktop:${node.url}:${selectedAgentId}`;
	const connected = status === "connected";

	useEffect(() => {
		if (agents.length === 0) {
			return;
		}
		setSelectedAgentId((current) => {
			if (agents.some((agent) => agent.id === current)) {
				return current;
			}
			return agents.find((agent) => agent.id === "ryu")?.id ?? agents[0].id;
		});
	}, [agents]);

	const enabled = apps.some((a) => a.id === DESKTOP_PLUGIN_ID && a.enabled);
	// Read at connect time so a rotating managed delegation does not rebuild
	// `connect`, which would drop the live stream.
	const nodeUserJwtRef = useRef(node.userJwt);
	nodeUserJwtRef.current = node.userJwt;

	// The node's own screen: a one-use Core ticket for the ext route, dialed
	// through Core's port. No subprotocols, and nothing secret in the URL but
	// the opaque ticket.
	const connect = useCallback(async () => {
		// The account JWT only goes to a node with a token or managed
		// delegation, reached over HTTPS or on this machine; otherwise the
		// ticket keeps the node's own managed delegation.
		const jwt = await realtimeJwtForTarget({
			url: node.url,
			token: node.token ?? null,
			userJwt: nodeUserJwtRef.current,
		});
		const ticket = await requestWebSocketTicket(
			{
				url: node.url,
				token: node.token ?? null,
				userJwt: jwt,
			},
			{ path: desktopWsPath(selectedAgentId), route: "ext" }
		);
		return {
			url: desktopWsUrl(node.url, ticket, selectedAgentId),
			protocols: [],
		};
	}, [node.token, node.url, selectedAgentId]);

	if (!enabled) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground text-xs">
				<p className="max-w-xs">
					Enable the <span className="font-medium">Virtual Desktop</span> app to
					stream this node's desktop live. Install the virtual-desktop toolchain
					(xvfb, a window manager, tigervnc) on the node when prompted.
				</p>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-10 shrink-0 items-center gap-2 border-border border-b px-2">
				<span
					className="min-w-0 truncate text-muted-foreground text-xs"
					title={node.name}
				>
					{node.name}
				</span>
				<label className="sr-only" htmlFor="desktop-agent-session">
					Bot screen
				</label>
				<select
					aria-label="Bot screen"
					className="max-w-32 rounded-lg border bg-background px-1.5 py-0.5 text-xs"
					id="desktop-agent-session"
					onChange={(event) => setSelectedAgentId(event.target.value)}
					value={selectedAgentId}
				>
					{agents.length === 0 ? (
						<option value="ryu">Ryu</option>
					) : (
						agents.map((agent) => (
							<option key={agent.id} value={agent.id}>
								{agent.name}
							</option>
						))
					)}
				</select>
				<span
					className={`size-1.5 shrink-0 rounded-full ${
						connected ? "bg-success" : "bg-muted-foreground/40"
					}`}
					title={status}
				/>
				<button
					className="rounded-lg px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-50"
					onClick={() => setConnection((value) => value + 1)}
					type="button"
				>
					{connected ? "Reconnect" : "Connect"}
				</button>
			</div>
			<div className="relative min-h-0 flex-1 bg-black">
				<VncCanvas
					active={active}
					connect={connect}
					key={`${sourceId}:${connection}`}
					mediaSourceId={sourceId}
					onPreviewClear={clearMediaSource}
					onPreviewFrame={(frame) =>
						publishMediaSource({ ...frame, kind: "desktop" })
					}
					onStatusChange={(next) => setStatus(next)}
					reconnectDelaysMs={NO_AUTOMATIC_RECONNECT}
					title={`${node.name || "Remote desktop"} · ${selectedAgent?.name ?? selectedAgentId}`}
				/>
			</div>
		</div>
	);
}
