import {
	ConnectionStatusToast as ConnectionStatusToastPrimitive,
	type ConnectionStatusToastProps,
} from "@ryu/ui/components/connection-status.tsx";
import { useEffect, useRef, useState } from "react";
import { useSystemStatusContext } from "@/src/contexts/SystemStatusContext.tsx";
import {
	type ConnectionPhase,
	isConnectionUnavailable,
} from "@/src/lib/connectivity.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

export type ConnectionStatusToastViewProps = ConnectionStatusToastProps;

/** The Desktop host adapter for the shared fixed connection surface. */
export function ConnectionStatusToastView(
	props: ConnectionStatusToastViewProps
) {
	return <ConnectionStatusToastPrimitive {...props} />;
}

/**
 * Connect the presentational status to the app-wide node/network status spine.
 * The shell mounts it as the inline `strip` under the header; the OS desktop,
 * which has no header, keeps the floating toast.
 */
export function ConnectionStatusToast({
	layout = "strip",
}: {
	layout?: ConnectionStatusToastProps["layout"];
} = {}) {
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
			layout={layout}
			nodeName={nodeName}
			onRetry={() => void handleRetry()}
			phase={connectionPhase}
			restored={restored}
			retrying={retrying}
		/>
	);
}
