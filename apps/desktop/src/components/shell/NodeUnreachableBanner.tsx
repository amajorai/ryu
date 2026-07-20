import { Button } from "@ryu/ui/components/button";
import { useEffect, useState } from "react";
import { WEB_URL } from "@/lib/app-urls.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { isLocalNode, useNodeStore } from "@/src/store/useNodeStore.ts";

/**
 * How often the active node's reachability is re-checked. Reachability is not a
 * one-shot fact — a local node is killed, a laptop leaves the LAN — so a node
 * that dies mid-session has to surface without a reload.
 */
const PROBE_INTERVAL_MS = 15_000;

/**
 * Persistent banner for an unreachable active node.
 *
 * Before this, nothing in the app answered "is the active node up?": pages just
 * failed or span individually, and the only node-level signal (the status dot)
 * was invisible unless the user opened the node picker. `PreflightPage` looks
 * like it covers this but is gated on `coreStatus === "stopped"`, which on the
 * webapp means the HOSTED core — not the user's own node.
 *
 * The CTA is surface-aware: a dead LOCAL node on the webapp means the user has
 * no local node at all, and the only way to get one is the desktop app.
 */
export function NodeUnreachableBanner() {
	const activeNodeOnline = useNodeStore((s) => s.activeNodeOnline);
	const probeActiveNode = useNodeStore((s) => s.probeActiveNode);
	const getActiveNode = useNodeStore((s) => s.getActiveNode);
	const [retrying, setRetrying] = useState(false);

	useEffect(() => {
		let cancelled = false;
		const tick = () => {
			if (!cancelled) {
				probeActiveNode().catch(() => undefined);
			}
		};
		tick();
		const timer = setInterval(tick, PROBE_INTERVAL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [probeActiveNode]);

	// `null` is "not probed yet" — stay silent rather than flashing on boot.
	if (activeNodeOnline !== false) {
		return null;
	}

	const node = getActiveNode();
	const isWebappLocal =
		import.meta.env.VITE_RYU_SURFACE === "webapp" && isLocalNode(node);

	const handleRetry = () => {
		setRetrying(true);
		probeActiveNode()
			.catch(() => undefined)
			.finally(() => setRetrying(false));
	};

	return (
		<output
			aria-live="polite"
			className="flex w-full items-center gap-3 border-border border-b bg-muted/60 px-4 py-2 text-sm"
		>
			<span className="font-medium">Can't reach {node.name}</span>
			<span className="text-muted-foreground">
				{isWebappLocal
					? "Ryu needs a local node running on this machine. Install the desktop app, or switch to another node."
					: "This node isn't responding. Features that need it will fail until it's back."}
			</span>
			<div className="ml-auto flex items-center gap-2">
				{isWebappLocal ? (
					<Button
						onClick={() =>
							openExternal(`${WEB_URL}/download`).catch(() => undefined)
						}
						size="sm"
						variant="mono"
					>
						Download the desktop app
					</Button>
				) : null}
				<Button
					disabled={retrying}
					onClick={handleRetry}
					size="sm"
					variant="outline"
				>
					{retrying ? "Checking…" : "Retry"}
				</Button>
			</div>
		</output>
	);
}
