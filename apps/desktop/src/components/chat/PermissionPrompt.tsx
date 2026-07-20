"use client";

import { Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import { memo, useMemo } from "react";
import type { AcpPermissionOption } from "@/src/lib/api/acp.ts";

export interface ActivePermission {
	options: AcpPermissionOption[];
	requestId: string;
	toolCall: unknown;
}

export interface PermissionPromptProps {
	onRespond: (optionId: string | null) => void;
	permission: ActivePermission;
}

/** Best-effort human label for the tool the agent wants to run. */
function toolTitle(toolCall: unknown): string {
	const tc = toolCall as
		| { title?: string; fields?: { title?: string }; kind?: string }
		| null
		| undefined;
	return tc?.title ?? tc?.fields?.title ?? "run a tool";
}

const ALLOW_KINDS = new Set(["allow_once", "allow_always"]);

/**
 * Inline allow/reject prompt shown above the composer when an ACP agent in a
 * permission-gating mode asks to run a tool (Zed-style). One button per
 * agent-reported option, colored by `kind` (allow = green, reject = red). The
 * chosen option id is sent back to Core to unblock the awaiting turn.
 */
export const PermissionPrompt = memo(function PermissionPrompt({
	permission,
	onRespond,
}: PermissionPromptProps) {
	const title = useMemo(
		() => toolTitle(permission.toolCall),
		[permission.toolCall]
	);

	return (
		<div className="mx-auto mb-1 w-full max-w-[720px] px-3">
			<div className="flex flex-col gap-2 rounded-2xl bg-muted px-3.5 py-3">
				<div className="text-foreground text-sm">
					<span className="font-medium">Permission required</span>
					<span className="text-muted-foreground">
						{" "}
						— allow the agent to {title}?
					</span>
				</div>
				<div className="flex flex-wrap items-center gap-1.5">
					{permission.options.map((opt) => {
						const isAllow = ALLOW_KINDS.has(opt.kind);
						return (
							<Button
								className={cn(
									"h-7 gap-1.5 px-2.5 text-xs",
									isAllow
										? "text-success dark:text-success"
										: "text-destructive"
								)}
								key={opt.optionId}
								onClick={() => onRespond(opt.optionId)}
								size="sm"
								type="button"
								variant="ghost"
							>
								<HugeiconsIcon
									icon={isAllow ? Tick02Icon : Cancel01Icon}
									size={14}
									strokeWidth={2}
								/>
								{opt.name}
							</Button>
						);
					})}
				</div>
			</div>
		</div>
	);
});
