"use client";

import {
	Alert01Icon,
	AlertCircleIcon,
	CircleArrowUp01Icon,
	CircleIcon,
	Download01Icon,
	Loading01Icon,
	MinusSignIcon,
	PlayIcon,
	RotateClockwiseIcon,
	Square01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import type { ServiceRow } from "./services-types.ts";

function StatusDot({
	installing,
	installed,
	running,
}: {
	installing: boolean;
	installed: boolean;
	running: boolean;
}) {
	if (installing) {
		return (
			<HugeiconsIcon
				className="h-3.5 w-3.5 animate-spin text-muted-foreground"
				icon={Loading01Icon}
			/>
		);
	}
	if (!installed) {
		return (
			<HugeiconsIcon
				className="h-3.5 w-3.5 text-muted-foreground/50"
				icon={MinusSignIcon}
			/>
		);
	}
	if (running) {
		return (
			<HugeiconsIcon
				className="h-3 w-3 fill-success text-status-success"
				icon={CircleIcon}
			/>
		);
	}
	return (
		<HugeiconsIcon
			className="h-3 w-3 text-muted-foreground"
			icon={CircleIcon}
		/>
	);
}

/** A single sidecar row (mirrors the live `SidecarRow` component). */
export function SidecarRowView({
	entry,
	onInstall,
	onStart,
	onStop,
	onRestart,
}: {
	entry: ServiceRow;
	onInstall?: (name: string) => void;
	onStart?: (name: string) => void;
	onStop?: (name: string) => void;
	onRestart?: (name: string) => void;
}) {
	const pending = entry.pending ?? null;
	const isInstalled = entry.installState === "installed";
	const isInstalling =
		entry.installState === "installing" || pending === "install";
	const isFailed = entry.installState === "failed";
	const hasUpdate =
		isInstalled &&
		entry.latestVersion != null &&
		entry.installedVersion != null &&
		entry.latestVersion !== entry.installedVersion &&
		!entry.deprecated;

	return (
		<div className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/40">
			<div className="flex w-4 flex-shrink-0 items-center justify-center">
				<StatusDot
					installed={isInstalled}
					installing={isInstalling}
					running={entry.running}
				/>
			</div>

			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span
						className={cn(
							"truncate font-medium text-sm",
							!isInstalled && "text-muted-foreground"
						)}
						title={entry.displayName}
					>
						{entry.displayName}
					</span>
					{entry.deprecated ? (
						<span className="flex items-center gap-1 font-medium text-status-warning text-xs">
							<HugeiconsIcon className="h-3 w-3" icon={Alert01Icon} />
							Deprecated
						</span>
					) : null}
				</div>
				{entry.description ? (
					<p
						className="truncate text-muted-foreground text-xs"
						title={entry.description}
					>
						{entry.description}
					</p>
				) : null}
			</div>

			<div className="flex flex-shrink-0 items-center gap-1.5">
				{isInstalling ? (
					<span className="text-muted-foreground text-xs">Installing…</span>
				) : isFailed ? (
					<Button
						appearance="service-retry"
						disabled={pending !== null}
						onClick={() => onInstall?.(entry.name)}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon
							className="mr-1 h-3.5 w-3.5"
							icon={AlertCircleIcon}
						/>
						Retry
					</Button>
				) : isInstalled || entry.deprecated ? (
					isInstalled ? (
						<>
							{hasUpdate ? (
								<Button
									appearance="service-update"
									disabled={pending !== null}
									onClick={() => onInstall?.(entry.name)}
									size="sm"
									variant="ghost"
								>
									<HugeiconsIcon
										className="mr-1 h-3.5 w-3.5"
										icon={CircleArrowUp01Icon}
									/>
									Update
								</Button>
							) : null}
							{entry.running ? (
								<>
									<Button
										appearance="service-action"
										disabled={pending !== null}
										onClick={() => onStop?.(entry.name)}
										size="sm"
										variant="ghost"
									>
										<HugeiconsIcon
											className="mr-1 h-3.5 w-3.5"
											icon={Square01Icon}
										/>
										Stop
									</Button>
									<Button
										appearance="service-action"
										disabled={pending !== null}
										onClick={() => onRestart?.(entry.name)}
										size="sm"
										variant="ghost"
									>
										<HugeiconsIcon
											className="mr-1 h-3.5 w-3.5"
											icon={RotateClockwiseIcon}
										/>
										Restart
									</Button>
								</>
							) : (
								<Button
									appearance="service-action"
									disabled={pending !== null}
									onClick={() => onStart?.(entry.name)}
									size="sm"
									variant="ghost"
								>
									<HugeiconsIcon className="mr-1 h-3.5 w-3.5" icon={PlayIcon} />
									Start
								</Button>
							)}
						</>
					) : null
				) : (
					<Button
						appearance="service-action"
						disabled={pending !== null}
						onClick={() => onInstall?.(entry.name)}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon className="mr-1 h-3.5 w-3.5" icon={Download01Icon} />
						Install
					</Button>
				)}
			</div>
		</div>
	);
}
