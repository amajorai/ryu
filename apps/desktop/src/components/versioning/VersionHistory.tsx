// apps/desktop/src/components/versioning/VersionHistory.tsx
//
// A reusable, server-backed version-history control modelled on Prompt Studio's
// snapshot/diff/restore UI, but transport-agnostic: the caller injects a
// `VersionSource` (list / getValue / snapshot / restore) so the same control
// drives page (Spaces document) and workflow versioning against their own Core
// endpoints. Unlike Prompt Studio's localStorage history, versions here are
// durable and shared across devices.

import { Clock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Spinner } from "@ryu/ui/components/spinner";
import { useCallback, useEffect, useState } from "react";

/** Metadata for one saved version (no diffable body — fetched lazily). */
export interface VersionMeta {
	/** Unix milliseconds. */
	createdAt: number;
	id: string;
	/** Optional user label for a manual snapshot. */
	label?: string | null;
	/** Display title (page title / workflow name) captured at snapshot time. */
	title?: string;
}

/** The data operations a concrete feature wires up for its versions. */
export interface VersionSource {
	/** Fetch the diffable text of one version (markdown / pretty JSON). */
	getValue: (versionId: string) => Promise<string>;
	/** List versions, newest first. */
	list: () => Promise<VersionMeta[]>;
	/** Restore a version as the current content. */
	restore: (versionId: string) => Promise<void>;
	/** Snapshot the current content as a new version. */
	snapshot: (label?: string) => Promise<void>;
}

interface VersionHistoryProps {
	/** Current diffable text, compared against a version in the diff view. */
	currentValue: string;
	/** When true, snapshot/restore are hidden (read-only). */
	disabled?: boolean;
	/** Called after a successful restore so the parent can reload its content. */
	onRestored?: () => void;
	/** The feature-specific data operations. */
	source: VersionSource;
}

/** A per-line diff between a saved version and the current draft. */
function VersionDiff({
	snapshot,
	current,
}: {
	snapshot: string;
	current: string;
}) {
	const snapLines = snapshot.split("\n");
	const curLines = current.split("\n");
	const max = Math.max(snapLines.length, curLines.length);
	const rows: { id: string; tone: string; text: string }[] = [];
	for (let i = 0; i < max; i++) {
		const s = snapLines[i];
		const c = curLines[i];
		if (s === c) {
			rows.push({
				id: `eq-${i}`,
				tone: "text-muted-foreground",
				text: ` ${s ?? ""}`,
			});
		} else {
			if (s !== undefined) {
				rows.push({ id: `del-${i}`, tone: "text-destructive", text: `- ${s}` });
			}
			if (c !== undefined) {
				rows.push({
					id: `add-${i}`,
					tone: "text-success dark:text-success",
					text: `+ ${c}`,
				});
			}
		}
	}
	return (
		<pre className="max-h-48 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
			{rows.map((r) => (
				<div className={r.tone} key={r.id}>
					{r.text}
				</div>
			))}
		</pre>
	);
}

export function VersionHistory({
	currentValue,
	source,
	disabled = false,
	onRestored,
}: VersionHistoryProps) {
	const [open, setOpen] = useState(false);
	const [versions, setVersions] = useState<VersionMeta[]>([]);
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The version currently expanded for diffing, plus its fetched body.
	const [diffId, setDiffId] = useState<string | null>(null);
	const [diffValue, setDiffValue] = useState<string | null>(null);

	const reload = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setVersions(await source.list());
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to load versions");
		} finally {
			setLoading(false);
		}
	}, [source]);

	// Load the list whenever the panel opens.
	useEffect(() => {
		if (open) {
			void reload();
		}
	}, [open, reload]);

	const handleSnapshot = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			await source.snapshot();
			await reload();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to save version");
		} finally {
			setBusy(false);
		}
	}, [source, reload]);

	const handleToggleDiff = useCallback(
		async (versionId: string) => {
			if (diffId === versionId) {
				setDiffId(null);
				setDiffValue(null);
				return;
			}
			setDiffId(versionId);
			setDiffValue(null);
			try {
				setDiffValue(await source.getValue(versionId));
			} catch (e) {
				setError(e instanceof Error ? e.message : "Failed to load version");
			}
		},
		[diffId, source]
	);

	const handleRestore = useCallback(
		async (versionId: string) => {
			setBusy(true);
			setError(null);
			try {
				await source.restore(versionId);
				setOpen(false);
				setDiffId(null);
				setDiffValue(null);
				onRestored?.();
			} catch (e) {
				setError(e instanceof Error ? e.message : "Failed to restore version");
			} finally {
				setBusy(false);
			}
		},
		[source, onRestored]
	);

	return (
		<div className="relative">
			<div className="flex items-center gap-1">
				{disabled ? null : (
					<Button
						className="text-xs"
						disabled={busy}
						onClick={handleSnapshot}
						size="sm"
						variant="ghost"
					>
						{busy ? <Spinner className="size-3" /> : null}
						Save version
					</Button>
				)}
				<Button
					className="text-xs"
					onClick={() => setOpen((p) => !p)}
					size="sm"
					variant="ghost"
				>
					<HugeiconsIcon className="size-3" icon={Clock01Icon} />
					History
					{versions.length > 0 ? (
						<Badge className="ml-1 text-[10px]" variant="secondary">
							{versions.length}
						</Badge>
					) : null}
				</Button>
			</div>

			{open ? (
				<div className="absolute right-0 z-20 mt-1 max-h-96 w-80 overflow-auto rounded-lg border bg-popover p-2 shadow-md">
					{error ? (
						<p className="p-2 text-destructive text-xs">{error}</p>
					) : null}
					{loading ? (
						<div className="flex items-center gap-2 p-2 text-muted-foreground text-xs">
							<Spinner className="size-3" />
							Loading versions…
						</div>
					) : versions.length === 0 ? (
						<p className="p-2 text-muted-foreground text-xs">
							No versions yet. Save one to keep a history you can restore.
						</p>
					) : (
						<ul className="flex flex-col gap-1">
							{versions.map((v) => (
								<li
									className="flex flex-col gap-1 rounded-md border p-2"
									key={v.id}
								>
									<div className="flex items-center gap-2">
										{v.label ? (
											<Badge className="text-[10px]" variant="secondary">
												{v.label}
											</Badge>
										) : null}
										<span className="text-muted-foreground text-xs">
											{new Date(v.createdAt).toLocaleString()}
										</span>
										<div className="ml-auto flex items-center gap-1">
											<Button
												className="text-[11px]"
												onClick={() => handleToggleDiff(v.id)}
												size="sm"
												variant="ghost"
											>
												Diff
											</Button>
											{disabled ? null : (
												<Button
													className="text-[11px]"
													disabled={busy}
													onClick={() => handleRestore(v.id)}
													size="sm"
													variant="ghost"
												>
													Restore
												</Button>
											)}
										</div>
									</div>
									{diffId === v.id ? (
										diffValue === null ? (
											<div className="flex items-center gap-2 p-1 text-[11px] text-muted-foreground">
												<Spinner className="size-3" />
												Loading diff…
											</div>
										) : (
											<VersionDiff
												current={currentValue}
												snapshot={diffValue}
											/>
										)
									) : null}
								</li>
							))}
						</ul>
					)}
				</div>
			) : null}
		</div>
	);
}
