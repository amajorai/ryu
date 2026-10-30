import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { CSSProperties as LayoutCSSProperties } from "react";
import { WEB_URL } from "@/lib/app-urls.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { cn } from "@/lib/utils.ts";
import { isLocalNode, type Node } from "@/src/store/useNodeStore.ts";

/**
 * Deep-link out to the web org page to provision / manage managed (Ryu Cloud)
 * servers. Server CRUD is web-only (WS4/WS7); the desktop only links out. The
 * `Node` record carries no orgId, so this targets the org list, not a per-server
 * page — the web app resolves the active org and its servers table from there.
 */
export function openManageCloudServers() {
	openExternal(`${WEB_URL}/organizations`).catch(() => undefined);
}

export type Tone = "green" | "amber" | "red" | "pending";

export function resolveTone(
	loading: boolean,
	coreReachable: boolean,
	gatewayReachable: boolean,
	shadowReachable: boolean | null,
	meshReachable: boolean | null
): Tone {
	if (loading) {
		return "pending";
	}
	if (!coreReachable) {
		return "red";
	}
	// Mesh is null-neutral: only `enabled && !reachable` (=== false) contributes
	// amber. A disabled/absent mesh (null) is ignored so a vanilla install never
	// shows a permanent amber dot. Mirrors shadowReachable's null semantics.
	if (
		!gatewayReachable ||
		shadowReachable === false ||
		meshReachable === false
	) {
		return "amber";
	}
	return "green";
}

export const TONE_DOT = {
	green: "bg-success",
	amber: "bg-warning",
	red: "bg-destructive",
	pending: "bg-muted-foreground/40",
} satisfies Record<Tone, string>;

export const displayName = (name: string) =>
	name.charAt(0).toUpperCase() + name.slice(1);

export const computerName = (node: Node) =>
	isLocalNode(node) ? "Your computer" : displayName(node.name);

export function StatusDot({ online }: { online: boolean | null }) {
	// The dot's hue is the only visual cue, so name the state for assistive tech
	// and expose it on hover.
	let status = "Offline";
	if (online === null) {
		status = "Checking status";
	} else if (online) {
		status = "Online";
	}
	return (
		<span
			aria-label={status}
			className={cn(
				"size-2 shrink-0 rounded-full",
				online === null && "bg-muted-foreground/40",
				online === true && "bg-success",
				online === false && "bg-warning"
			)}
			role="img"
			title={status}
		/>
	);
}

export function NodeStatusIcon({
	borderClassName,
	icon,
	subdued = false,
	tone,
}: {
	borderClassName: string;
	icon: IconSvgElement;
	subdued?: boolean;
	tone?: Tone;
}) {
	return (
		<span
			aria-hidden
			className="relative inline-flex size-3.5 shrink-0"
			data-slot="node-status-icon"
		>
			<HugeiconsIcon
				className={cn(
					"size-3.5",
					subdued ? "text-muted-foreground/70" : "text-muted-foreground/70"
				)}
				icon={icon}
				size={14}
			/>
			{tone && (
				<span
					className={cn(
						"absolute -right-0.5 -bottom-0.5 size-2 rounded-full border-2",
						borderClassName,
						TONE_DOT[tone]
					)}
					data-slot="node-status-dot"
				/>
			)}
		</span>
	);
}

export interface LayoutCssVariables extends LayoutCSSProperties {
	"--desktop-inline1-width"?: string | number;
	"--desktop-inline2-width"?: string | number;
}
