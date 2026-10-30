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
//
// Updating an enabled skill can rewrite its name and description in the skills
// block of every thread that loads skills, so those updates ask first through
// the shared skill-set confirmation. "Update all" asks once, and cancelling it
// applies nothing.

import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { useRef, useState } from "react";
import {
	TrayRow,
	TrayRowIcon,
	TraySectionLabel,
	TrayTextButton,
	trayMeta,
} from "@/src/components/shell/TrayPopover.tsx";
import { useSkillDistributionFlow } from "@/src/components/skills/SkillDistributionProvider.tsx";
import { skillUpdateChanges } from "@/src/components/skills/skill-set-change.ts";
import { withAppUpdateLast } from "@/src/hooks/available-updates-policy.ts";
import {
	type AvailableUpdate,
	useAvailableUpdates,
} from "@/src/hooks/useAvailableUpdates.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { kindIcon } from "./kindIcons.ts";

/** Short human label for the artifact family. */
const KIND_LABEL = {
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
} satisfies Record<AvailableUpdate["kind"], string>;

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
					<span
						className="text-(length:--text-detail) truncate font-medium leading-tight"
						title={update.name}
					>
						{update.name}
					</span>
					<Badge className="shrink-0" size="compact" variant="secondary">
						{KIND_LABEL[update.kind]}
					</Badge>
				</div>
				{version && (
					<span className="truncate text-muted-foreground text-xs tabular-nums leading-tight">
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

/** `startOnce` key for the "Update all" run; row keys are `<kind>:<id>`. */
const UPDATE_ALL_KEY = "update-all";

export function AvailableUpdates({ compact = false }: { compact?: boolean }) {
	const { updates, applyingKeys, applyUpdate, refresh } = useAvailableUpdates();
	const { confirmSkillSetChange } = useSkillDistributionFlow();
	const getActiveNode = useNodeStore((s) => s.getActiveNode);
	// A single flag for the "Update all" run (applies sequentially so a shared
	// Core install queue isn't overwhelmed and each row can still show state).
	const [updatingAll, setUpdatingAll] = useState(false);
	// Runs still reading the installed list or waiting on the confirmation, so a
	// second click in that window cannot start the same update twice.
	const startingRef = useRef(new Set<string>());

	if (updates.length === 0) {
		return null;
	}

	// Resolves false when the user cancels; true at once when no enabled skill
	// is among the updates.
	const confirmSkillUpdates = async (
		batch: readonly AvailableUpdate[]
	): Promise<boolean> => {
		const skills = batch.filter((update) => update.kind === "skill");
		if (skills.length === 0) {
			return true;
		}
		const names = await skillUpdateChanges(toTarget(getActiveNode()), skills);
		return confirmSkillSetChange(names);
	};

	// Runs `run` unless a run under the same key is already starting.
	const startOnce = async (key: string, run: () => Promise<void>) => {
		if (startingRef.current.has(key)) {
			return;
		}
		startingRef.current.add(key);
		try {
			await run();
		} finally {
			startingRef.current.delete(key);
		}
	};

	const applyOne = (update: AvailableUpdate) =>
		startOnce(update.key, async () => {
			if (await confirmSkillUpdates([update])) {
				await applyUpdate(update);
			}
		});

	// Failures are reported by `useAvailableUpdates` (one toast per outcome, for
	// every kind), so callers only need to keep a rejection from escaping.
	const runOne = (update: AvailableUpdate) => {
		applyOne(update).catch(() => undefined);
	};

	const runAll = () =>
		startOnce(UPDATE_ALL_KEY, async () => {
			const batch = withAppUpdateLast(updates);
			if (!(await confirmSkillUpdates(batch))) {
				return;
			}
			setUpdatingAll(true);
			try {
				// The app update goes LAST: on a local node it installs the bundle and
				// exits the app, which would cut every update queued behind it.
				for (const update of batch) {
					// Sequential on purpose — see note above. One failure must not abort
					// the rest of the run, so each is caught individually.
					await applyUpdate(update).catch(() => undefined);
				}
			} finally {
				setUpdatingAll(false);
				refresh();
			}
		});

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
