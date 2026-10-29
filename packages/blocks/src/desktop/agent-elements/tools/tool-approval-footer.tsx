import {
	ToolApprovalActions,
	type ToolApprovalChoice,
	type ToolApprovalStatus,
} from "@ryu/ui/components/agents/tool-approval";
import { cn } from "@ryu/ui/lib/utils";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import { memo, useMemo, useState } from "react";

/** One choice the agent offered, straight off the ACP permission request. */
export interface ToolApprovalOption {
	/** `allow_once` | `allow_always` | `reject_once` | `reject_always`. */
	kind: string;
	name: string;
	optionId: string;
}

export interface ToolApproval {
	/**
	 * The agent's own options. Present whenever the footer is driven by a real
	 * `session/request_permission` — one button per option, answered by id.
	 */
	onSelect?: (optionId: string | null) => void;
	options?: ToolApprovalOption[];
}

export type ToolApprovalFooterProps = ToolApproval & {
	isPending?: boolean;
};

const ALLOW_KINDS = new Set(["allow_once", "allow_always"]);

/** Map an ACP option kind onto the emphasis its button should carry. */
function toneForKind(kind: string): ToolApprovalChoice["tone"] {
	if (kind === "allow_once") {
		return "primary";
	}
	if (kind === "allow_always") {
		return "secondary";
	}
	return "ghost";
}

/**
 * The approval strip on a tool row. Renders the agent's OWN options — every one
 * of them, in the order it sent them — rather than a fixed allow/deny pair, so
 * an agent offering `allow_once` / `allow_always` / `reject_once` /
 * `reject_always` does not lose two buttons on the way to the screen.
 *
 * The card shell lives in the tool renderer around this; only the decision row
 * comes from `@ryu/ui/components/agents/tool-approval`, since nesting that
 * component's full border inside a tool card would draw a box in a box.
 */
export const ToolApprovalFooter = memo(function ToolApprovalFooter({
	isPending,
	options,
	onSelect,
}: ToolApprovalFooterProps) {
	const [decision, setDecision] = useState<"approved" | "rejected" | null>(
		null
	);

	const choices = useMemo<ToolApprovalChoice[] | null>(() => {
		if (!options?.length) {
			return null;
		}
		return options.map((option) => ({
			id: option.optionId,
			label: option.name,
			tone: toneForKind(option.kind),
			onSelect: () => {
				if (decision) {
					return;
				}
				setDecision(ALLOW_KINDS.has(option.kind) ? "approved" : "rejected");
				onSelect?.(option.optionId);
			},
		}));
	}, [decision, onSelect, options]);

	const status = useMemo<ToolApprovalStatus>(() => {
		if (decision === "approved") {
			return "approving";
		}
		if (decision === "rejected") {
			return "denied";
		}
		return "pending";
	}, [decision]);

	const statusLabel = useMemo(() => {
		if (decision === "approved") {
			return { label: "Waiting", busy: true };
		}
		if (decision === "rejected") {
			return { label: "Canceled", busy: false };
		}
		if (isPending) {
			return { label: "Starting", busy: true };
		}
		// The agent is blocked on this answer — say so, rather than leaving the
		// buttons to imply it.
		return { label: "Approval required", busy: false };
	}, [decision, isPending]);

	// No options means no live request to answer. Rendering the strip anyway is
	// the old bug: a decision affordance for something nothing is waiting on.
	if (!choices) {
		return null;
	}

	return (
		<div className="flex items-center justify-between gap-2 bg-muted py-1 pr-2 pl-2.5">
			<span
				className={cn(
					"type-caption inline-flex items-center gap-1.5 font-medium",
					decision === "rejected"
						? "text-status-destructive"
						: "text-muted-foreground"
				)}
			>
				{statusLabel.busy ? (
					<LoaderCircle className="size-3 animate-spin" />
				) : (
					<ShieldCheck className="size-3" />
				)}
				{statusLabel.label}
			</span>
			<ToolApprovalActions choices={choices} status={status} />
		</div>
	);
});
