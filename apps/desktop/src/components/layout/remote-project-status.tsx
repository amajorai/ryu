import {
	type ConnectionDotState,
	ConnectionStatusDot,
} from "@ryu/ui/components/connection-status.tsx";

/** Resolve the compact status state from the shared active-node probe. */
export function remoteProjectStatusState(
	online: boolean | null
): ConnectionDotState {
	if (online === null) {
		return "checking";
	}
	return online ? "online" : "offline";
}

/**
 * Metadata shown on a sidebar project row when its folder lives on a remote
 * Ryu node. The node label is intentionally visible alongside the dot so an
 * offline project is attributable when multiple remote nodes are configured.
 */
export function RemoteProjectStatus({
	nodeName,
	online,
}: {
	nodeName: string;
	online: boolean | null;
}) {
	const label = nodeName.replace(/^cloud-/, "").trim() || "Remote node";
	const state = remoteProjectStatusState(online);
	const stateLabel =
		state === "online"
			? "online"
			: state === "offline"
				? "offline"
				: "checking";
	return (
		<span
			className="flex min-w-0 max-w-24 shrink-0 items-center gap-1.5 text-muted-foreground text-xs"
			data-project-connection-status={state}
			data-project-node-name={label}
		>
			<span className="truncate" title={label}>
				{label}
			</span>
			<ConnectionStatusDot label={`${label}: ${stateLabel}`} state={state} />
		</span>
	);
}
