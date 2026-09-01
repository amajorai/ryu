import { Button } from "@ryu/ui/components/button";
import { Spinner } from "@ryu/ui/components/spinner";
import { Check, ServerOff, WifiOff } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useSystemStatusContext } from "@/src/contexts/SystemStatusContext.tsx";
import {
	type ConnectionPhase,
	isConnectionUnavailable,
} from "@/src/lib/connectivity.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

interface ConnectionStatusCopy {
	detail: string;
	title: string;
}

export interface ConnectionStatusToastViewProps {
	nodeName: string;
	onRetry?: () => void;
	phase: ConnectionPhase;
	restored?: boolean;
	retrying?: boolean;
}

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

/** The compact, fixed shell status surface shared by the real app and proof story. */
export function ConnectionStatusToastView({
	nodeName,
	onRetry,
	phase,
	restored = false,
	retrying = false,
}: ConnectionStatusToastViewProps) {
	if (phase === "online" && !restored) {
		return null;
	}

	const copy = copyForPhase(phase, nodeName, restored);
	const isWarning = !restored;

	return (
		<div
			className="pointer-events-none fixed inset-x-0 top-12 z-50 flex justify-center px-3 sm:px-4"
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

/** Connect the presentational toast to the app-wide node/network status spine. */
export function ConnectionStatusToast() {
	const { connectionPhase, coreReachable, refresh } = useSystemStatusContext();
	const nodeName = useNodeStore((state) => state.getActiveNode().name);
	const [retrying, setRetrying] = useState(false);
	const [restored, setRestored] = useState(false);
	const previousPhaseRef = useRef<ConnectionPhase | null>(null);

	useEffect(() => {
		const previousPhase = previousPhaseRef.current;
		previousPhaseRef.current = connectionPhase;

		if (isConnectionUnavailable(connectionPhase) || !coreReachable) {
			setRestored(false);
			return;
		}
		if (
			connectionPhase !== "online" ||
			previousPhase === null ||
			previousPhase === "online"
		) {
			return;
		}

		setRestored(true);
		const timer = window.setTimeout(() => setRestored(false), 3000);
		return () => window.clearTimeout(timer);
	}, [connectionPhase, coreReachable]);

	const handleRetry = async () => {
		setRetrying(true);
		try {
			await refresh();
		} finally {
			setRetrying(false);
		}
	};

	return (
		<ConnectionStatusToastView
			nodeName={nodeName}
			onRetry={() => void handleRetry()}
			phase={connectionPhase}
			restored={restored}
			retrying={retrying}
		/>
	);
}
