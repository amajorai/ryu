"use client";

// Presentational layer for a sub-agent delegation fan-out (delegate rows, caps,
// streamed progress). The standalone desktop Delegation page was removed —
// delegation is now an agent-native tool (`delegate__fanout`, Core
// `sidecar/mcp/delegate.rs`) the model calls itself, not a screen a human drives.
// This view is retained for the storyboard (which catalogs the historical screen
// with mock data) and as a reusable building block for any future delegation UI.

import { HierarchyIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Spinner } from "@ryu/ui/components/spinner";
import { Textarea } from "@ryu/ui/components/textarea";

export type DelegateStatus = "pending" | "running" | "done" | "failed";

/** One delegate row in the editor, as the view needs it. */
export interface DelegateRowView {
	id: string;
	preset: string;
	task: string;
}

export interface DelegateProgressView {
	preset: string;
	status: DelegateStatus;
}

export interface DelegateResultView {
	error?: string | null;
	id: string;
	output?: string | null;
}

export interface DelegationCapsView {
	max_concurrent: number;
	max_tokens: number;
	wall_time_secs: number;
}

export interface DelegationViewProps {
	canSubmit?: boolean;
	caps: DelegationCapsView;
	depth: number;
	maxConcurrent: number;
	maxDepth: number;
	onAddRow?: () => void;
	onCancel?: () => void;
	onRemoveRow?: (id: string) => void;
	onSubmit?: () => void;
	onUpdateCaps?: (patch: Partial<DelegationCapsView>) => void;
	onUpdateDepth?: (depth: number) => void;
	onUpdateRow?: (id: string, patch: Partial<DelegateRowView>) => void;
	presetOptions: { value: string; label: string }[];
	/** Per-row progress, keyed by row id. */
	progress?: Record<string, DelegateProgressView>;
	results?: DelegateResultView[] | null;
	rows: DelegateRowView[];
	runError?: string | null;
	running?: boolean;
}

const STATUS_LABEL: Record<DelegateStatus, string> = {
	pending: "Queued",
	running: "Running",
	done: "Done",
	failed: "Failed",
};

const STATUS_VARIANT: Record<
	DelegateStatus,
	"secondary" | "default" | "destructive" | "outline"
> = {
	pending: "outline",
	running: "secondary",
	done: "default",
	failed: "destructive",
};

export function DelegationView({
	rows,
	caps,
	depth,
	presetOptions,
	maxConcurrent,
	maxDepth,
	running = false,
	canSubmit = false,
	progress = {},
	results = null,
	runError = null,
	onAddRow,
	onRemoveRow,
	onUpdateRow,
	onUpdateCaps,
	onUpdateDepth,
	onSubmit,
	onCancel,
}: DelegationViewProps) {
	const hasProgress = Object.keys(progress).length > 0;

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="scroll-fade-effect-y flex-1 overflow-auto p-6">
				<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
					<div className="flex flex-col gap-4">
						<Card>
							<CardHeader>
								<CardTitle>Delegates</CardTitle>
								<CardDescription>
									Each delegate runs with a clean context under its permission
									preset. Empty tasks are skipped.
								</CardDescription>
							</CardHeader>
							<CardContent className="flex flex-col gap-4">
								{rows.map((row, index) => (
									<div className="flex flex-col gap-2" key={row.id}>
										<div className="flex items-center justify-between">
											<Label className="text-muted-foreground text-xs">
												Delegate {index + 1}
											</Label>
											<Button
												disabled={rows.length <= 1 || running}
												onClick={() => onRemoveRow?.(row.id)}
												size="sm"
												type="button"
												variant="ghost"
											>
												Remove
											</Button>
										</div>
										<Textarea
											className="min-h-20"
											disabled={running}
											onChange={(e) =>
												onUpdateRow?.(row.id, { task: e.target.value })
											}
											placeholder="Self-contained task for this sub-agent..."
											value={row.task}
										/>
										<Select
											disabled={running}
											items={presetOptions}
											onValueChange={(value) =>
												value && onUpdateRow?.(row.id, { preset: value })
											}
											value={row.preset}
										>
											<SelectTrigger className="w-full">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{presetOptions.map((opt) => (
													<SelectItem key={opt.value} value={opt.value}>
														{opt.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
								))}
								<Button
									disabled={running}
									onClick={onAddRow}
									type="button"
									variant="ghost"
								>
									Add delegate
								</Button>
							</CardContent>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle>Caps</CardTitle>
								<CardDescription>
									Safety limits applied to the fan-out. Concurrency and depth
									are clamped server-side to their hard maximums.
								</CardDescription>
							</CardHeader>
							<CardContent className="grid grid-cols-2 gap-4">
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="cap-concurrency">
										Concurrency (max {maxConcurrent})
									</Label>
									<Input
										disabled={running}
										id="cap-concurrency"
										max={maxConcurrent}
										min={1}
										onChange={(e) =>
											onUpdateCaps?.({ max_concurrent: Number(e.target.value) })
										}
										type="number"
										value={caps.max_concurrent}
									/>
								</div>
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="cap-depth">Depth (max {maxDepth})</Label>
									<Input
										disabled={running}
										id="cap-depth"
										max={maxDepth}
										min={1}
										onChange={(e) => onUpdateDepth?.(Number(e.target.value))}
										type="number"
										value={depth}
									/>
								</div>
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="cap-tokens">Token budget</Label>
									<Input
										disabled={running}
										id="cap-tokens"
										min={1}
										onChange={(e) =>
											onUpdateCaps?.({ max_tokens: Number(e.target.value) })
										}
										type="number"
										value={caps.max_tokens}
									/>
								</div>
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="cap-walltime">Wall-time (s)</Label>
									<Input
										disabled={running}
										id="cap-walltime"
										min={1}
										onChange={(e) =>
											onUpdateCaps?.({ wall_time_secs: Number(e.target.value) })
										}
										type="number"
										value={caps.wall_time_secs}
									/>
								</div>
							</CardContent>
						</Card>

						<div className="flex gap-2">
							<Button disabled={!canSubmit} onClick={onSubmit} type="button">
								{running ? <Spinner /> : null}
								{running ? "Delegating..." : "Run delegation"}
							</Button>
							{running ? (
								<Button onClick={onCancel} type="button" variant="ghost">
									Cancel
								</Button>
							) : null}
						</div>
					</div>

					<div className="flex flex-col gap-4">
						{runError ? (
							<Card className="border-destructive">
								<CardHeader>
									<CardTitle className="text-destructive">
										Delegation error
									</CardTitle>
									<CardDescription className="break-words text-destructive">
										{runError}
									</CardDescription>
								</CardHeader>
							</Card>
						) : null}

						<Card>
							<CardHeader>
								<CardTitle>Live progress</CardTitle>
								<CardDescription>
									Per-delegate status streamed as the fan-out runs.
								</CardDescription>
							</CardHeader>
							<CardContent className="flex flex-col gap-3">
								{hasProgress ? (
									rows
										.filter((r) => progress[r.id])
										.map((row, index) => {
											const p = progress[row.id];
											return (
												<div
													className="flex flex-col gap-1 rounded-md border p-3"
													key={row.id}
												>
													<div className="flex items-center justify-between gap-2">
														<span className="font-medium text-sm">
															Delegate {index + 1}
														</span>
														<div className="flex items-center gap-2">
															<Badge variant="secondary">{p.preset}</Badge>
															<Badge variant={STATUS_VARIANT[p.status]}>
																{p.status === "running" ? (
																	<Spinner className="mr-1 size-3" />
																) : null}
																{STATUS_LABEL[p.status]}
															</Badge>
														</div>
													</div>
													<p className="truncate text-muted-foreground text-xs">
														{row.task.trim()}
													</p>
												</div>
											);
										})
								) : (
									<Empty>
										<EmptyHeader>
											<EmptyMedia variant="icon">
												<HugeiconsIcon icon={HierarchyIcon} />
											</EmptyMedia>
											<EmptyTitle>No active run</EmptyTitle>
											<EmptyDescription>
												Add delegates and run a delegation to see live progress.
											</EmptyDescription>
										</EmptyHeader>
									</Empty>
								)}
							</CardContent>
						</Card>

						{results ? (
							<Card>
								<CardHeader>
									<CardTitle>Results</CardTitle>
									<CardDescription>
										Ordered results from the completed delegation run.
									</CardDescription>
								</CardHeader>
								<CardContent className="flex flex-col gap-3">
									{results.map((result, index) => (
										<div
											className="flex flex-col gap-1.5 rounded-md border p-3"
											key={result.id}
										>
											<div className="flex items-center justify-between gap-2">
												<span className="font-medium text-sm">
													Result {index + 1}
												</span>
												<Badge
													variant={result.error ? "destructive" : "default"}
												>
													{result.error ? "Failed" : "Done"}
												</Badge>
											</div>
											{result.error ? (
												<p className="break-words text-destructive text-xs">
													{result.error}
												</p>
											) : (
												<p className="whitespace-pre-wrap break-words text-sm">
													{result.output ?? "(no output)"}
												</p>
											)}
										</div>
									))}
								</CardContent>
							</Card>
						) : null}
					</div>
				</div>
			</div>
		</div>
	);
}
