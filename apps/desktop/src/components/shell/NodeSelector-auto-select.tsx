import {
	SettingsGroup,
	SettingsItem,
} from "@ryu/blocks/desktop/settings-items.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { cn } from "@/lib/utils.ts";
import {
	isLocalNode,
	LOCAL_FALLBACK,
	type Node,
	useNodeStore,
} from "@/src/store/useNodeStore.ts";
import { displayName } from "./NodeSelector-status.tsx";

/** The policy, in one line — used for both the OFF-state hint and the a11y label. */
const AUTO_SELECT_POLICY =
	"Prefer a reachable remote computer, else use your computer";

/**
 * Subline under the auto-select switch: what the setting is actually DOING right
 * now, never a promise the store does not keep. `picked` is the node the probe
 * landed on (already resolved from `autoSelectedNode`), or null before it has run.
 */
function autoSelectSubline(autoSelect: boolean, picked: Node | null): string {
	if (!autoSelect) {
		return "Always use your default computer";
	}
	if (!picked) {
		return AUTO_SELECT_POLICY;
	}
	// Branch on the URL, not the name: a remote node someone named "local" must not
	// be reported as local compute.
	if (isLocalNode(picked)) {
		return "No remote computer reachable — using your computer";
	}
	return `Using ${displayName(picked.name)}`;
}

/**
 * The auto-select switch (M10: "a client prefers a reachable REMOTE node, else
 * local compute"). The store models this as a PERSISTED flag; the probe only ever
 * considers REMOTE nodes (an explicitly-chosen default remote is ranked first) and
 * fails over to local compute when none answers, and `getActiveNode` prefers that
 * pick while the flag is on.
 *
 * A persistent toggle, deliberately NOT a port of the one-shot "Auto-select best
 * node" BUTTON on mobile (`apps/native/components/node-selector.tsx`): the desktop
 * store re-probes on an interval and on node changes, so the choice is a standing
 * preference, not a single decision. OFF (the default) keeps selection byte-
 * identical to the manual path — a picked tab override still always wins.
 */
export function AutoSelectRow({
	compact = false,
	variant = "menu",
}: {
	compact?: boolean;
	/** `settings`: the computer dialog's App Settings switch row + caption. */
	variant?: "menu" | "settings";
}) {
	const autoSelect = useNodeStore((s) => s.autoSelect);
	const setAutoSelect = useNodeStore((s) => s.setAutoSelect);
	const autoSelectedNode = useNodeStore((s) => s.autoSelectedNode);
	const nodes = useNodeStore((s) => s.nodes);

	// Resolve the pick defensively: the probe can name the local fallback even when
	// the user renamed their local node, so an unresolved name degrades to local.
	let picked: Node | null = null;
	if (autoSelectedNode) {
		picked = nodes.find((n) => n.name === autoSelectedNode) ?? LOCAL_FALLBACK;
	}

	if (variant === "settings") {
		return (
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							aria-label={AUTO_SELECT_POLICY}
							checked={autoSelect}
							onCheckedChange={setAutoSelect}
						/>
					}
					description={autoSelectSubline(autoSelect, picked)}
					title="Auto-select computer"
				/>
			</SettingsGroup>
		);
	}

	return (
		<div className={cn(compact ? "px-1 py-0.5" : "mt-1")}>
			<div className="flex items-center gap-2 rounded-lg px-2 py-1.5">
				<div className="min-w-0 flex-1">
					<p className="truncate font-medium text-xs">Auto-select computer</p>
					<p
						className="truncate text-muted-foreground text-xs"
						title={autoSelectSubline(autoSelect, picked)}
					>
						{autoSelectSubline(autoSelect, picked)}
					</p>
				</div>
				<Switch
					aria-label={AUTO_SELECT_POLICY}
					checked={autoSelect}
					className="shrink-0"
					onCheckedChange={setAutoSelect}
				/>
			</div>
		</div>
	);
}
