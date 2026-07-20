import { Button } from "@ryu/ui/components/button";
import { memo, useMemo, useState } from "react";

export interface ToolApproval {
	approveLabel?: string;
	onApprove?: () => void;
	onReject?: () => void;
	rejectLabel?: string;
}

export type ToolApprovalFooterProps = ToolApproval & {
	isPending?: boolean;
};

export const ToolApprovalFooter = memo(function ToolApprovalFooter({
	isPending,
	approveLabel,
	rejectLabel,
	onApprove,
	onReject,
}: ToolApprovalFooterProps) {
	const [decision, setDecision] = useState<"approved" | "rejected" | null>(
		null
	);

	const approveText =
		decision === "approved" ? "Approved" : (approveLabel ?? "Next");
	const rejectText =
		decision === "rejected" ? "Skipped" : (rejectLabel ?? "Skip");

	const handleApprove = () => {
		if (decision) {
			return;
		}
		setDecision("approved");
		onApprove?.();
	};

	const handleReject = () => {
		if (decision) {
			return;
		}
		setDecision("rejected");
		onReject?.();
	};

	const statusConfig = useMemo(() => {
		if (decision === "approved") {
			return { label: "Waiting", dots: true };
		}
		if (decision === "rejected") {
			return { label: "Canceled", dots: false };
		}
		if (isPending) {
			return { label: "Starting", dots: true };
		}
		// Default "ready" state — buttons themselves communicate the affordance,
		// an extra "Ready" label just adds noise. Render an empty spacer so the
		// buttons stay right-aligned via justify-between.
		return null;
	}, [decision, isPending]);

	return (
		<div className="flex items-center justify-between bg-muted py-1 pr-2 pl-3">
			{statusConfig ? (
				<span className="text-muted-foreground text-xs">
					{statusConfig.label}
					{statusConfig.dots && (
						<span aria-hidden="true" className="inline-flex">
							<span className="animate-[loading-dots_1.4s_infinite_0.2s] text-muted-foreground">
								.
							</span>
							<span className="animate-[loading-dots_1.4s_infinite_0.4s] text-muted-foreground">
								.
							</span>
							<span className="animate-[loading-dots_1.4s_infinite_0.6s] text-muted-foreground">
								.
							</span>
						</span>
					)}
				</span>
			) : (
				<span aria-hidden="true" />
			)}
			<div className="flex gap-1">
				<Button
					className="h-5 px-1.5 text-muted-foreground text-xs hover:text-foreground"
					disabled={Boolean(decision)}
					onClick={handleReject}
					size="sm"
					type="button"
					variant="ghost"
				>
					{rejectText}
				</Button>
				<Button
					className="h-5 px-1.5 text-xs"
					disabled={Boolean(decision)}
					onClick={handleApprove}
					size="sm"
					type="button"
				>
					{approveText}
				</Button>
			</div>
		</div>
	);
});
