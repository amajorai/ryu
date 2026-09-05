// apps/desktop/src/components/downloads/AvailableUpdates.tsx
//
// "Available updates" — the promoted, suggested-download section the download
// center shows when any installed artifact (the app, an agent, engine, tool,
// plugin, …) has a newer version. Rendered both in the compact tray and on the
// full DownloadsPage from the same `useAvailableUpdates` aggregate, so the two
// surfaces never drift.
//
// `compact` renders it as a tray section: the shared TrayRow, so an update sits
// in the same rhythm as a download or an approval, with a default "Update"
// button. The full page keeps a heading, description and roomier rows.
//
// Renders nothing when there are no updates, so it can be dropped in
// unconditionally.

import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { useState } from "react";
import {
	TrayRow,
	TrayRowIcon,
	TraySectionLabel,
	TrayTextButton,
	trayMeta,
} from "@/src/components/shell/TrayPopover.tsx";
import {
	type AvailableUpdate,
	useAvailableUpdates,
} from "@/src/hooks/useAvailableUpdates.ts";
import { kindIcon } from "./kindIcons.ts";

/** Short human label for the artifact family. */
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

/** Tray form: the shared row, with the kind demoted into the meta line. */
function CompactUpdateRow({
	applying,
	onApply,
	update,
}: {
	applying: boolean;
	onApply: () => void;
	update: AvailableUpdate;
}) {
	return (
		<TrayRow
			actions={
				<Button loading={applying} onClick={onApply} size="xs">
					Update
				</Button>
			}
			icon={kindIcon(update.kind)}
			meta={trayMeta(KIND_LABEL[update.kind], versionText(update))}
			title={update.name}
		/>
	);
}

/** Page form: roomier, with the kind as a badge and a full-width button. */
function PageUpdateRow({
	applying,
	onApply,
	update,
}: {
	applying: boolean;
	onApply: () => void;
	update: AvailableUpdate;
}) {
	const version = versionText(update);
	return (
		<div className="flex items-center gap-2.5 rounded-xl px-3 py-2.5">
			<TrayRowIcon icon={kindIcon(update.kind)} />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex items-center gap-1.5">
					<span className="truncate font-medium text-[13px] leading-tight">
						{update.name}
					</span>
					<Badge className="shrink-0 text-[10px]" variant="secondary">
						{KIND_LABEL[update.kind]}
					</Badge>
				</div>
				{version && (
					<span className="truncate text-[11px] text-muted-foreground tabular-nums leading-tight">
						{version}
					</span>
				)}
			</div>
			<Button
				className="shrink-0"
				loading={applying}
				onClick={onApply}
				size="sm"
			>
				Update
			</Button>
		</div>
	);
}

export function AvailableUpdates({ compact = false }: { compact?: boolean }) {
	const { updates, applyingKeys, applyUpdate, refresh } = useAvailableUpdates();
	// A single flag for the "Update all" run (applies sequentially so a shared
	// Core install queue isn't overwhelmed and each row can still show state).
	const [updatingAll, setUpdatingAll] = useState(false);

	if (updates.length === 0) {
		return null;
	}

	// Failures are reported by `useAvailableUpdates` (one toast per outcome, for
	// every kind), so callers only need to keep a rejection from escaping.
	const runOne = (update: AvailableUpdate) => {
		applyUpdate(update).catch(() => undefined);
	};

	const runAll = async () => {
		setUpdatingAll(true);
		try {
			for (const update of updates) {
				// Sequential on purpose — see note above. One failure must not abort
				// the rest of the run, so each is caught individually.
				await applyUpdate(update).catch(() => undefined);
			}
		} finally {
			setUpdatingAll(false);
			refresh();
		}
	};

	const startAll = () => {
		runAll().catch(() => undefined);
	};

	if (compact) {
		return (
			<>
				<TraySectionLabel
					count={updates.length}
					trailing={
						updates.length > 1 ? (
							<TrayTextButton disabled={updatingAll} onClick={startAll}>
								{updatingAll ? "Updating…" : "Update all"}
							</TrayTextButton>
						) : undefined
					}
				>
					Updates
				</TraySectionLabel>
				{updates.map((update) => (
					<CompactUpdateRow
						applying={updatingAll || applyingKeys.has(update.key)}
						key={update.key}
						onApply={() => runOne(update)}
						update={update}
					/>
				))}
			</>
		);
	}

	return (
		<section className="flex flex-col gap-2">
			<div className="flex items-center justify-between gap-2 px-3 py-2">
				<div className="flex flex-col">
					<span className="font-medium text-sm">
						Available updates
						<span className="ml-1.5 text-muted-foreground tabular-nums">
							{updates.length}
						</span>
					</span>
					<span className="text-muted-foreground text-xs">
						Newer versions of installed agents, engines, tools, and plugins.
					</span>
				</div>
				<Button loading={updatingAll} onClick={startAll} size="sm">
					Update all
				</Button>
			</div>
			<div className="flex flex-col p-1">
				{updates.map((update) => (
					<PageUpdateRow
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
