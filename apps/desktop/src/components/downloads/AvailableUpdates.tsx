// apps/desktop/src/components/downloads/AvailableUpdates.tsx
//
// "Available updates" — the promoted, suggested-download section the download
// center shows when any installed artifact (the app, an agent, engine, tool,
// plugin, …) has a newer version. Rendered both in the compact popup and on the
// full DownloadsPage from the same `useAvailableUpdates` aggregate, so the two
// surfaces never drift.

import { ArrowUp01Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Spinner } from "@ryu/ui/components/spinner";
import { cn } from "@ryu/ui/lib/utils";
import { useState } from "react";
import {
	type AvailableUpdate,
	useAvailableUpdates,
} from "@/src/hooks/useAvailableUpdates.ts";

/** Short human label for the artifact family, shown as a badge on each row. */
const KIND_LABEL: Record<AvailableUpdate["kind"], string> = {
	app: "App",
	agent: "Agent",
	engine: "Engine",
	tool: "Tool",
	voice: "Voice",
	media: "Media",
	plugin: "Plugin",
	skill: "Skill",
	mcp: "MCP",
	model: "Model",
};

function versionText(update: AvailableUpdate): string | null {
	if (update.currentVersion && update.latestVersion) {
		return `${update.currentVersion} → ${update.latestVersion}`;
	}
	if (update.latestVersion) {
		return `v${update.latestVersion}`;
	}
	return null;
}

/** One suggested-update row with its own Update button + spinner. */
function UpdateRow({
	update,
	applying,
	onApply,
}: {
	update: AvailableUpdate;
	applying: boolean;
	onApply: () => void;
}) {
	const version = versionText(update);
	return (
		<div className="flex items-center gap-2 px-3 py-2.5">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex items-center gap-1.5">
					<span className="truncate font-medium text-sm">{update.name}</span>
					<Badge className="shrink-0 text-[10px]" variant="secondary">
						{KIND_LABEL[update.kind]}
					</Badge>
				</div>
				{version && (
					<span className="truncate text-muted-foreground text-xs tabular-nums">
						{version}
					</span>
				)}
			</div>
			<Button
				className="shrink-0"
				disabled={applying}
				onClick={onApply}
				size="sm"
				variant="outline"
			>
				{applying ? (
					<Spinner className="size-4" />
				) : (
					<HugeiconsIcon className="size-4" icon={ArrowUp01Icon} />
				)}
				Update
			</Button>
		</div>
	);
}

/**
 * The available-updates block. `compact` trims the header for the popup; the
 * full page passes `compact={false}` for a heading + description. Renders
 * nothing when there are no updates so it can be dropped in unconditionally.
 */
export function AvailableUpdates({ compact = false }: { compact?: boolean }) {
	const { updates, applyingKeys, applyUpdate, refresh } = useAvailableUpdates();
	// A single flag for the "Update all" run (applies sequentially so a shared
	// Core install queue isn't overwhelmed and each row can still show state).
	const [updatingAll, setUpdatingAll] = useState(false);

	if (updates.length === 0) {
		return null;
	}

	const runOne = (update: AvailableUpdate) => {
		applyUpdate(update).catch(() => undefined);
	};

	const runAll = async () => {
		setUpdatingAll(true);
		try {
			for (const update of updates) {
				// Sequential on purpose — see note above.
				await applyUpdate(update).catch(() => undefined);
			}
		} finally {
			setUpdatingAll(false);
			refresh();
		}
	};

	return (
		<section className={cn("flex flex-col", compact ? "" : "gap-2")}>
			<div className="flex items-center justify-between gap-2 px-3 py-2">
				<div className="flex flex-col">
					<span className="font-semibold text-sm">
						Available updates
						<span className="ml-1.5 text-muted-foreground tabular-nums">
							{updates.length}
						</span>
					</span>
					{!compact && (
						<span className="text-muted-foreground text-xs">
							Newer versions of installed agents, engines, tools, and plugins.
						</span>
					)}
				</div>
				<Button
					disabled={updatingAll}
					onClick={() => {
						runAll().catch(() => undefined);
					}}
					size="sm"
				>
					{updatingAll ? (
						<Spinner className="size-4" />
					) : (
						<HugeiconsIcon className="size-4" icon={Refresh01Icon} />
					)}
					Update all
				</Button>
			</div>
			<div className="divide-y">
				{updates.map((update) => (
					<UpdateRow
						applying={updatingAll || applyingKeys.has(update.key)}
						key={update.key}
						onApply={() => runOne(update)}
						update={update}
					/>
				))}
			</div>
		</section>
	);
}
