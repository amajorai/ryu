import { ArrowUp01Icon, Download04Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { sileo } from "sileo";
import {
	type SidecarDetail,
	startSidecar,
	stopSidecar,
} from "@/src/lib/api/plugins.ts";
import {
	type LayerAction,
	NodeLayerMenu,
	startStopAction,
} from "./NodeLayerMenu.tsx";

/** Compact "1.2 GB" / "340 MB" formatter for per-engine resident memory. */
function formatBytes(bytes: number): string {
	if (bytes <= 0) {
		return "0 B";
	}
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.min(
		Math.floor(Math.log(bytes) / Math.log(1024)),
		units.length - 1
	);
	const val = bytes / 1024 ** i;
	const rounded = val >= 100 || i === 0 ? Math.round(val) : val.toFixed(1);
	return `${rounded} ${units[i]}`;
}

/** A short "1.2 GB · 12%" usage caption, or null when no sample is available. */
export function usageCaption(detail: SidecarDetail | undefined): string | null {
	if (!detail || detail.memoryBytes == null) {
		return null;
	}
	const mem = formatBytes(detail.memoryBytes);
	if (detail.cpuPercent == null) {
		return mem;
	}
	return `${mem} · ${Math.round(detail.cpuPercent)}%`;
}

/**
 * One service layer (Core / Gateway / Shadow / Island) as a submenu: the trigger
 * carries the health dot, name, live usage and version; Start / Stop / Update /
 * Launch sit at the top of the submenu instead of crowding the row with inline
 * buttons. A service is a singleton — nothing to swap to — so it passes no
 * installed/available lists.
 */
export function ServiceRow({
	label,
	running,
	target,
	sidecarKey,
	onChanged,
	detail,
	readOnly = false,
	version,
	updateAvailable = false,
	onUpdate,
	onLaunch,
	currentLabel,
	icon,
	idleCaption,
	idleTone = "down",
}: {
	label: string;
	running: boolean | null;
	target: { url: string; token: string | null };
	sidecarKey: string;
	onChanged: () => Promise<void>;
	/** Optional resource sample; when running, renders a "1.2 GB · 12%" caption. */
	detail?: SidecarDetail;
	/** Submenu-header name of the thing behind this row, when it differs from the
	 *  row's own label ("Embeddings" is served by "llama.cpp"). Defaults to
	 *  `label`, which is right for a service that names itself (Core, Gateway). */
	currentLabel?: string;
	icon?: IconSvgElement;
	/** Caption for the stopped state. Defaults to "Stopped" — override for a
	 *  sidecar whose stopped state is normal rather than a fault. */
	idleCaption?: string;
	/** How "stopped" READS, which is not the same question as whether it is
	 *  stopped. `"down"` (default) paints the red dot: this thing is supposed to
	 *  be up, so down is a fault. `"neutral"` paints the grey dot for a lazily
	 *  started sidecar that is *designed* to sit stopped until first use — the
	 *  reranker only wakes on the first Space search, so a red dot there would
	 *  report a healthy fresh install as broken, permanently. The start/stop
	 *  action still reads the REAL state either way. */
	idleTone?: "down" | "neutral";
	/** Hide the start/stop toggle, showing status + usage only. Used for chat
	 *  engines, which are swap-managed (mutually exclusive) rather than
	 *  independently start/stoppable — toggling one here would desync the active
	 *  engine + gateway. */
	readOnly?: boolean;
	/** Installed version to surface as a `v1.2.3` badge. Hidden when absent. */
	version?: string | null;
	/** Whether a newer version is available — gates the inline "Update" action. */
	updateAvailable?: boolean;
	/** Run the update for this component. When set + `updateAvailable`, renders an
	 *  "Update" button that awaits this before reconciling. */
	onUpdate?: () => Promise<void>;
	/** Install-then-launch action for a component the shell can start but Core can't
	 *  (Island: a device-local Electron companion, not a Core sidecar). When set +
	 *  `running === false`, renders an "Install / Launch" button that awaits this
	 *  then re-probes. Independent of the start/stop toggle, so it coexists with
	 *  `readOnly`. */
	onLaunch?: () => Promise<void>;
}) {
	const handleUpdate = async () => {
		if (!onUpdate) {
			return;
		}
		await onUpdate();
		await onChanged();
	};

	const handleLaunch = async () => {
		if (!onLaunch) {
			return;
		}
		await onLaunch();
		// Electron cold start + binding :7989 takes a few seconds, so give it a
		// beat before re-probing; the 5s status poll flips the dot regardless.
		await new Promise<void>((resolve) => setTimeout(resolve, 1000));
		await onChanged();
	};

	const handleToggle = async (next: boolean) => {
		try {
			if (next) {
				await startSidecar(target, sidecarKey);
			} else {
				await stopSidecar(target, sidecarKey);
			}
		} catch (e) {
			// NodeLayerMenu swallows the rejection (it only owns the spinner), so a
			// refusal has to be surfaced here or the row just silently does nothing
			// — the live case being a reranker whose 438 MB model was never
			// downloaded.
			sileo.error({
				title:
					e instanceof Error
						? e.message
						: `Couldn't ${next ? "start" : "stop"} ${label}`,
			});
		}
		// Give the process a moment to settle before re-polling status.
		await new Promise<void>((resolve) => setTimeout(resolve, 1000));
		await onChanged();
	};

	const usage = running ? usageCaption(detail) : null;
	const actions: LayerAction[] = [];
	if (running !== null && !readOnly) {
		actions.push(startStopAction(running, handleToggle));
	}
	if (updateAvailable && onUpdate) {
		actions.push({
			id: "update",
			label: "Update",
			busyLabel: "Updating…",
			icon: ArrowUp01Icon,
			tone: "warning",
			run: handleUpdate,
		});
	}
	if (onLaunch && running === false) {
		actions.push({
			id: "launch",
			label: "Install / Launch",
			busyLabel: "Launching…",
			icon: Download04Icon,
			run: handleLaunch,
		});
	}

	const idle = idleTone === "neutral";
	let caption: string;
	if (running === null) {
		caption = "Status unknown";
	} else if (running) {
		caption = usage ? `Running · ${usage}` : "Running";
	} else {
		caption = idleCaption ?? "Stopped";
	}

	return (
		<NodeLayerMenu
			actions={actions}
			caption={caption}
			currentLabel={currentLabel ?? label}
			icon={icon}
			label={label}
			// The dot reports the READING, not the raw state — see `idleTone`.
			running={idle && running === false ? null : running}
			trailing={
				usage ?? (running === false ? (idle ? "idle" : "stopped") : null)
			}
			version={version}
		/>
	);
}
