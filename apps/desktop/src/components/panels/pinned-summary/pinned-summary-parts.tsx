import {
	ArrowUpRight01Icon,
	ComputerTerminal01Icon,
	GitBranchIcon,
	GithubIcon,
	StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { safeHttpUrl } from "@ryu/marketplace/catalog/safe-url";
import { Button } from "@ryu/ui/components/button.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import type { GitProgressPhase } from "@/src/components/panels/GitActionDialogs.tsx";
import type { BackgroundProcess } from "@/src/lib/api/background-processes.ts";

export type GitOperationState =
	| { status: "idle" }
	| { phase: GitProgressPhase; status: "loading" }
	| { label: string; status: "done"; url?: string }
	| { status: "error"; message: string };

export function defaultRepositoryName(folder: string | null): string {
	return folder?.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

export function repositoryUrlFromName(
	repository: string | null
): string | null {
	const normalized = repository?.trim();
	if (!normalized) {
		return null;
	}
	if (/^https:\/\//i.test(normalized)) {
		return normalized;
	}
	return `https://github.com/${normalized.replace(/^\/+/, "")}`;
}

function formatBackgroundElapsed(elapsedMs: number): string {
	const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${seconds % 60}s`;
}

/** The provider-facing compare action shown only when the current branch can be compared. */
export function CompareBranchLink({ href }: { href: string }) {
	const safeHref = safeHttpUrl(href);
	if (!safeHref) {
		return null;
	}
	return (
		<a
			aria-label="Compare branch"
			className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-muted-foreground text-sm transition-colors duration-150 hover:bg-muted hover:text-foreground hover:duration-0"
			data-testid="compare-branch-link"
			href={safeHref}
			rel="noopener noreferrer"
			target="_blank"
		>
			<HugeiconsIcon
				aria-hidden
				className="size-4 shrink-0"
				icon={GithubIcon}
			/>
			<span className="min-w-0 flex-1 truncate">Compare branch</span>
			<HugeiconsIcon
				aria-hidden
				className="size-3.5 shrink-0"
				icon={ArrowUpRight01Icon}
			/>
		</a>
	);
}

/** Ryu Work's only Git affordance for a folder that is not a repository yet. */
export function CreateLocalGitButton({
	busy,
	onClick,
}: {
	busy: boolean;
	onClick: () => void;
}) {
	return (
		<Button
			aria-label="Create local Git"
			className="w-full"
			disabled={busy}
			onClick={onClick}
			size="sm"
			variant="outline"
		>
			<HugeiconsIcon aria-hidden className="size-4" icon={GitBranchIcon} />
			Create local Git
		</Button>
	);
}

export function BackgroundProcessRow({
	process,
	stopping,
	onStop,
}: {
	onStop: (processId: string) => void;
	process: BackgroundProcess;
	stopping: boolean;
}) {
	const tl = useLiteralMessages();
	const label = process.label?.trim() || process.command;
	return (
		<div className="group flex min-h-8 min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-sm transition-colors duration-150 hover:bg-muted hover:duration-0">
			<span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
				<HugeiconsIcon
					aria-hidden
					className="size-3.5"
					icon={ComputerTerminal01Icon}
				/>
			</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate" title={process.command}>
					{label}
				</span>
				<span className="block truncate text-muted-foreground text-xs">
					{process.cwd} · {formatBackgroundElapsed(process.elapsed_ms)}
				</span>
			</span>
			<button
				aria-label={tl("Stop {label}", { label })}
				className="grid size-6 shrink-0 place-items-center rounded-lg text-muted-foreground opacity-0 transition-opacity duration-150 hover:bg-destructive/10 hover:text-status-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-100 group-hover:opacity-100 group-hover:duration-0"
				disabled={stopping}
				onClick={(event) => {
					event.stopPropagation();
					onStop(process.process_id);
				}}
				title={stopping ? "Stopping…" : "Stop process"}
				type="button"
			>
				{stopping ? (
					<Spinner className="size-3.5" />
				) : (
					<HugeiconsIcon aria-hidden className="size-3.5" icon={StopIcon} />
				)}
			</button>
		</div>
	);
}
