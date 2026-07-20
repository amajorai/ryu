// apps/desktop/src/components/chat/WorkspaceHeader.tsx
//
// Composer branch selector. Reads the active workspace folder from
// useWorkspaceStore, polls Core's GET /api/git/status?cwd=<path> for the current
// branch + dirty state, and on click opens a popover listing local branches
// (GET /api/git/branches) that can be switched to (POST /api/git/checkout).
// Renders nothing when no folder is selected or the folder is not a git repo.

import { Tick02Icon, WorkflowCircle06Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { Spinner } from "@ryu/ui/components/spinner";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { cn } from "@ryu/ui/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	WORKSPACE_SELECT_ITEM,
	WORKSPACE_SELECT_LABEL,
	WORKSPACE_SELECT_POPOVER,
	WORKSPACE_SELECT_TRIGGER,
} from "@/components/agent-elements/input/composer-select.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	checkoutBranch,
	fetchGitBranches,
	fetchGitStatus,
} from "@/src/lib/api/git.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";

interface WorkspaceHeaderProps {
	target: ApiTarget;
}

const POLL_INTERVAL_MS = 5000;

export function WorkspaceHeader({ target }: WorkspaceHeaderProps) {
	const folder = useWorkspaceStore((s) => s.folder);
	const [branch, setBranch] = useState<string | null>(null);
	const [dirty, setDirty] = useState(false);
	const [open, setOpen] = useState(false);
	const [branches, setBranches] = useState<string[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [switching, setSwitching] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);

	const poll = useCallback(async () => {
		if (!folder) {
			return;
		}
		const status = await fetchGitStatus(target, folder);
		if (status.is_repo) {
			setBranch(status.branch);
			setDirty(status.dirty);
		} else {
			setBranch(null);
			setDirty(false);
		}
	}, [folder, target]);

	useEffect(() => {
		if (!folder) {
			setBranch(null);
			setDirty(false);
			return;
		}

		let active = true;

		const run = async () => {
			abortRef.current?.abort();
			const controller = new AbortController();
			abortRef.current = controller;

			const status = await fetchGitStatus(target, folder, controller.signal);
			if (!active) {
				return;
			}

			if (status.is_repo) {
				setBranch(status.branch);
				setDirty(status.dirty);
			} else {
				setBranch(null);
				setDirty(false);
			}
		};

		run();
		const id = setInterval(run, POLL_INTERVAL_MS);

		return () => {
			active = false;
			clearInterval(id);
			abortRef.current?.abort();
		};
	}, [folder, target]);

	const loadBranches = useCallback(async () => {
		if (!folder) {
			return;
		}
		setLoading(true);
		setError(null);
		const result = await fetchGitBranches(target, folder);
		setBranches(result.branches);
		if (result.current) {
			setBranch(result.current);
		}
		setLoading(false);
	}, [folder, target]);

	const onOpenChange = useCallback(
		(next: boolean) => {
			setOpen(next);
			if (next) {
				setError(null);
				loadBranches().catch(() => undefined);
			}
		},
		[loadBranches]
	);

	const handleSwitch = useCallback(
		async (nextBranch: string) => {
			if (!folder || nextBranch === branch) {
				setOpen(false);
				return;
			}
			setSwitching(nextBranch);
			setError(null);
			const result = await checkoutBranch(target, folder, nextBranch);
			setSwitching(null);
			if (result.success) {
				setBranch(result.branch ?? nextBranch);
				setOpen(false);
				poll().catch(() => undefined);
			} else {
				setError(result.error ?? "Failed to switch branch");
			}
		},
		[branch, folder, target, poll]
	);

	if (!(folder && branch)) {
		return null;
	}

	return (
		<Popover onOpenChange={onOpenChange} open={open}>
			<PopoverTrigger
				render={
					<Button
						aria-label="Switch branch"
						className={WORKSPACE_SELECT_TRIGGER}
						size="sm"
						type="button"
						variant="ghost"
					/>
				}
			>
				<HugeiconsIcon
					className="size-3.5 shrink-0"
					icon={WorkflowCircle06Icon}
				/>
				<Tooltip>
					<TooltipTrigger
						render={<span className="max-w-32 truncate">{branch}</span>}
					/>
					<TooltipContent>{branch}</TooltipContent>
				</Tooltip>
				{dirty && (
					<Tooltip>
						<TooltipTrigger
							render={
								<span
									aria-label="Uncommitted changes"
									className="size-1.5 shrink-0 rounded-full bg-warning"
								/>
							}
						/>
						<TooltipContent>Uncommitted changes</TooltipContent>
					</Tooltip>
				)}
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className={cn(WORKSPACE_SELECT_POPOVER, "min-w-[220px] max-w-[320px]")}
				side="top"
				sideOffset={6}
			>
				<div className={WORKSPACE_SELECT_LABEL}>Switch branch</div>
				{loading ? (
					<div className="flex justify-center py-4">
						<Spinner />
					</div>
				) : branches.length === 0 ? (
					<p className="px-2 py-1.5 text-muted-foreground text-sm">
						No branches found.
					</p>
				) : (
					branches.map((b) => {
						const isActive = b === branch;
						return (
							<Button
								className={cn(WORKSPACE_SELECT_ITEM, isActive && "bg-accent")}
								disabled={switching !== null}
								key={b}
								onClick={() => handleSwitch(b)}
								type="button"
								variant="ghost"
							>
								<HugeiconsIcon
									className="size-4 shrink-0 text-muted-foreground"
									icon={WorkflowCircle06Icon}
								/>
								<Tooltip>
									<TooltipTrigger
										render={
											<span className="min-w-0 flex-1 truncate font-mono text-[13px]">
												{b}
											</span>
										}
									/>
									<TooltipContent>{b}</TooltipContent>
								</Tooltip>
								{switching === b ? (
									<Spinner className="size-4 shrink-0" />
								) : (
									isActive && (
										<HugeiconsIcon
											className="shrink-0 text-muted-foreground"
											icon={Tick02Icon}
											size={16}
											strokeWidth={2}
										/>
									)
								)}
							</Button>
						);
					})
				)}
				{error && (
					<p className="mt-1 px-2 py-1.5 text-[12px] text-destructive">
						{error}
					</p>
				)}
			</PopoverContent>
		</Popover>
	);
}
