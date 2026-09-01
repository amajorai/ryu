"use client";

import {
	type ConnectionPhase,
	isConnectionUnavailable,
} from "@ryuhq/protocol/connection-status";
import { Check, ServerOff, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils.ts";
import { Button } from "./button.tsx";
import { Spinner } from "./spinner.tsx";

interface ConnectionStatusCopy {
	detail: string;
	title: string;
}

/** Controlled inputs for the shared web/extension connection status surface. */
export interface ConnectionStatusToastProps {
	/** Allows a host to add a class without taking over the component geometry. */
	className?: string;
	/** The selected node shown in the node-unreachable and reconnecting copy. */
	nodeName?: string;
	/** Optional manual retry action. It is only shown for node-unreachable. */
	onRetry?: () => void;
	phase: ConnectionPhase;
	/** Brief success state shown after the host moves from unavailable to online. */
	restored?: boolean;
	retrying?: boolean;
}

/** Backwards-compatible name for callers that use the presentational view. */
export type ConnectionStatusToastViewProps = ConnectionStatusToastProps;

function copyForPhase(
	phase: ConnectionPhase,
	nodeName: string,
	restored: boolean
): ConnectionStatusCopy {
	if (restored) {
		return {
			detail: `Reconnected to ${nodeName}.`,
			title: "Connection restored",
		};
	}
	if (phase === "offline") {
		return {
			detail: "Waiting for connectivity…",
			title: "Offline mode",
		};
	}
	if (phase === "node-unreachable") {
		return {
			detail: `Can’t reach ${nodeName}. Reconnecting automatically…`,
			title: "Node offline",
		};
	}
	return {
		detail: "Checking the node and keeping this window available…",
		title: `Connecting to ${nodeName}`,
	};
}

function phaseIcon(phase: ConnectionPhase, restored: boolean): ReactNode {
	if (restored) {
		return <Check aria-hidden="true" className="size-4" />;
	}
	if (phase === "offline") {
		return <WifiOff aria-hidden="true" className="size-4" />;
	}
	if (phase === "node-unreachable") {
		return <ServerOff aria-hidden="true" className="size-4" />;
	}
	return <Spinner aria-hidden="true" className="size-4" />;
}

/**
 * Compact fixed status surface for web hosts.
 *
 * It intentionally owns no network calls or node state. A host supplies the
 * same four-phase contract and can therefore use this in the shell, Gateway,
 * Spaces, databases, multiplayer, or a standalone app surface.
 */
export function ConnectionStatusToast({
	className,
	nodeName = "Ryu",
	onRetry,
	phase,
	restored = false,
	retrying = false,
}: ConnectionStatusToastProps) {
	if (phase === "online" && !restored) {
		return null;
	}

	const copy = copyForPhase(phase, nodeName, restored);
	const isWarning = isConnectionUnavailable(phase) && !restored;

	return (
		<div
			className={cn(
				"pointer-events-none fixed inset-x-0 top-12 z-[100] flex justify-center px-3 sm:px-4",
				className
			)}
			data-connection-phase={phase}
			data-connection-restored={restored ? "true" : undefined}
			data-testid="connection-status-toast"
		>
			<div
				aria-live="polite"
				className="pointer-events-auto flex w-full max-w-[34rem] items-center gap-2.5 rounded-full border border-border/70 bg-popover/95 px-3 py-2 text-popover-foreground shadow-black/10 shadow-lg backdrop-blur-xl"
				role="status"
			>
				<span
					aria-hidden="true"
					className={
						isWarning
							? "flex size-7 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning"
							: "flex size-7 shrink-0 items-center justify-center rounded-full bg-success/15 text-success"
					}
				>
					{phaseIcon(phase, restored)}
				</span>
				<span className="min-w-0 flex-1 truncate text-xs leading-5">
					<span className="font-medium">{copy.title}</span>
					<span className="ml-1.5 text-muted-foreground">{copy.detail}</span>
				</span>
				{phase === "node-unreachable" && onRetry ? (
					<Button
						className="h-7 shrink-0 rounded-full px-3 text-xs"
						disabled={retrying}
						onClick={onRetry}
						size="sm"
						variant="ghost"
					>
						{retrying ? "Checking…" : "Retry"}
					</Button>
				) : null}
			</div>
		</div>
	);
}

/** Explicit alias for hosts that distinguish the view from their adapter. */
export const ConnectionStatusToastView = ConnectionStatusToast;

export type { ConnectionPhase } from "@ryuhq/protocol/connection-status";
