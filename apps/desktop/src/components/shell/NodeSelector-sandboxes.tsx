import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import { useNodeSandboxes } from "@/src/hooks/useNodeSandboxes.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	createSandbox,
	destroySandbox,
	type SandboxRun,
	type SandboxSpec,
} from "@/src/lib/api/sandboxes.ts";
import { AutoScrollText } from "./AutoScrollText.tsx";

/** `4 vCPU · 16 GiB · H100` from a sandbox spec; omits fields the node didn't
 *  report, falling back to the guest OS (or a bare "sandbox") if it reported
 *  nothing quantitative. */
function summarizeSandboxSpec(spec: SandboxSpec): string {
	const parts: string[] = [];
	if (spec.vcpu !== null) {
		parts.push(`${spec.vcpu} vCPU`);
	}
	if (spec.memGib !== null) {
		parts.push(`${spec.memGib} GiB`);
	}
	if (spec.gpu) {
		parts.push(spec.gpu);
	}
	return parts.join(" · ") || spec.os || "sandbox";
}

/** `mm:ss` elapsed from a whole-seconds duration (any hours fold into minutes). */
function formatElapsed(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const mins = Math.floor(s / 60);
	const secs = s % 60;
	return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * "Running Sandboxes" block in the node dropdown: the compute runs currently
 * executing on the active node (wasmtime / Docker / a managed-node GPU box),
 * each with its resource summary (`4 vCPU · 16 GiB · H100`) and a live mm:ss
 * age. Polls the node directly on a short cadence so the set + ages feel live.
 *
 * Sandbox membership is org-scoped upstream (a managed node is org-bound), so no
 * client-side filter is applied. The query THROWS on an unreachable node / older
 * Core without the surface, leaving `data` undefined → the whole section hides;
 * an empty array (surface present, nothing running) instead shows an explicit
 * "No sandboxes running", so an absent endpoint never masquerades as "idle".
 */
/** One running-sandbox row with an inline "Stop" button that destroys the
 *  persistent Daytona workspace. Mirrors ServiceRow's local-`pending` idiom:
 *  the button relabels to "Stopping…" while the DELETE is in flight, and the
 *  list is invalidated on success so the row drops immediately. */
function SandboxRow({
	target,
	run,
	onDestroyed,
}: {
	target: ApiTarget;
	run: SandboxRun;
	onDestroyed: () => void;
}) {
	const [stopping, setStopping] = useState(false);

	const handleStop = async () => {
		setStopping(true);
		try {
			await destroySandbox(target, run.runId);
			sileo.success({ title: "Sandbox stopped" });
			onDestroyed();
		} catch (e) {
			sileo.error({
				title: e instanceof Error ? e.message : "Failed to stop sandbox",
			});
		} finally {
			setStopping(false);
		}
	};

	return (
		<div className="flex items-center gap-2 px-2 py-1 text-xs">
			<span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
			<AutoScrollText
				className="flex-1 text-muted-foreground"
				title={run.runId}
			>
				{summarizeSandboxSpec(run.spec)}
			</AutoScrollText>
			{run.spec.gpu && (
				<span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 font-medium text-accent-foreground text-xs">
					GPU
				</span>
			)}
			<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
				{formatElapsed(run.elapsedSeconds)}
			</span>
			<button
				className="shrink-0 rounded-md px-1.5 py-0.5 text-muted-foreground text-xs hover:bg-accent hover:text-status-destructive disabled:opacity-50"
				disabled={stopping}
				onClick={handleStop}
				type="button"
			>
				{stopping ? "Stopping…" : "Stop"}
			</button>
		</div>
	);
}

export function SandboxesSection({
	target,
	enabled,
}: {
	target: ApiTarget;
	enabled: boolean;
}) {
	const queryClient = useQueryClient();
	const tl = useLiteralMessages();
	const { data: sandboxes } = useNodeSandboxes(target, enabled);
	const [creating, setCreating] = useState(false);

	const invalidate = () => {
		Promise.resolve(
			queryClient.invalidateQueries({
				queryKey: ["node-sandboxes", target.url],
			})
		).catch(() => undefined);
	};

	if (!sandboxes) {
		return null;
	}

	const handleCreate = async () => {
		setCreating(true);
		try {
			await createSandbox(target);
			sileo.success({ title: "Sandbox created" });
			invalidate();
		} catch (e) {
			sileo.error({
				title: e instanceof Error ? e.message : "Failed to create sandbox",
			});
		} finally {
			setCreating(false);
		}
	};

	return (
		<div className="px-1 py-0.5">
			<div className="flex items-center justify-between px-2 pt-0.5 pb-1">
				<p className="font-medium text-muted-foreground/70 text-xs">
					{tl("Running sandboxes · {count}", { count: sandboxes.length })}
				</p>
				<button
					className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground text-xs hover:bg-accent hover:text-foreground disabled:opacity-50"
					disabled={creating}
					onClick={handleCreate}
					type="button"
				>
					<HugeiconsIcon className="size-3" icon={Add01Icon} />
					{creating ? "Creating…" : "New sandbox"}
				</button>
			</div>
			{sandboxes.length === 0 ? (
				<p className="px-2 pb-0.5 text-muted-foreground/70 text-xs">
					No sandboxes running
				</p>
			) : (
				sandboxes.map((run) => (
					<SandboxRow
						key={run.runId}
						onDestroyed={invalidate}
						run={run}
						target={target}
					/>
				))
			)}
		</div>
	);
}
