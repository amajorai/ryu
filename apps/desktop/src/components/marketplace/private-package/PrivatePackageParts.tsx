import { Alert02Icon, LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import type { PackageConnectionRequirement } from "@/src/lib/api/marketplace.ts";
import {
	type ConnectionStatus,
	statusIcon,
	statusLabel,
} from "./private-package-setup.tsx";

export function ConnectionRow({
	connecting,
	onConnect,
	requirement,
	status,
}: {
	connecting: boolean;
	onConnect: () => void;
	requirement: PackageConnectionRequirement;
	status?: ConnectionStatus;
}) {
	const state = status?.state ?? "checking";
	const canConnect =
		requirement.required &&
		(state === "needs_connection" ||
			state === "unavailable" ||
			state === "error");
	return (
		<div className="flex items-center gap-3 rounded-lg bg-muted px-3 py-3">
			<HugeiconsIcon
				className={
					state === "connected"
						? "size-4 shrink-0 text-status-success"
						: "size-4 shrink-0 text-muted-foreground"
				}
				icon={statusIcon(state)}
			/>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="font-medium text-sm">{requirement.displayName}</span>
					{requirement.required ? (
						<Badge size="compact" variant="outline">
							Required
						</Badge>
					) : (
						<Badge size="compact" variant="secondary">
							Optional
						</Badge>
					)}
				</div>
				<p className="mt-0.5 text-muted-foreground text-xs">
					{status?.message ?? "Checking this node…"}
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				<span className="hidden text-muted-foreground text-xs sm:inline">
					{statusLabel(state)}
				</span>
				{canConnect ? (
					<Button
						disabled={connecting}
						onClick={onConnect}
						size="sm"
						variant="outline"
					>
						{connecting ? (
							<Spinner className="size-3.5" />
						) : (
							<HugeiconsIcon className="size-3.5" icon={LinkSquare02Icon} />
						)}
						{state === "unavailable" ? "Configure" : "Connect"}
					</Button>
				) : null}
			</div>
		</div>
	);
}

export function ErrorNotice({ message }: { message: string }) {
	return (
		<div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-3 text-sm text-status-destructive">
			<HugeiconsIcon className="mt-0.5 size-4 shrink-0" icon={Alert02Icon} />
			<span>{message}</span>
		</div>
	);
}
