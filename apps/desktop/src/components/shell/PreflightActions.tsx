import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { copyDiagnostics, reportIssue } from "@/src/lib/preflight.ts";

export function PreflightActionButton({
	label,
	busyLabel,
	onRun,
	variant = "outline",
}: {
	label: string;
	busyLabel: string;
	onRun: () => Promise<void>;
	variant?: "default" | "outline";
}) {
	const [busy, setBusy] = useState(false);
	return (
		<Button
			disabled={busy}
			onClick={async () => {
				setBusy(true);
				try {
					await onRun();
				} catch (error) {
					toast.error(`${label} failed`, {
						description:
							error instanceof Error ? error.message : "Please try again.",
					});
				} finally {
					setBusy(false);
				}
			}}
			size="sm"
			variant={variant}
		>
			{busy ? busyLabel : label}
		</Button>
	);
}

export function PreflightDiagnosticsActions({ target }: { target: ApiTarget }) {
	return (
		<div className="flex gap-2">
			<PreflightActionButton
				busyLabel="Reporting…"
				label="Report issue"
				onRun={async () => {
					await reportIssue(target);
					toast.info("Issue report queued", {
						description:
							"Delivery to the reporting service has not been confirmed.",
					});
				}}
				variant="default"
			/>
			<PreflightActionButton
				busyLabel="Copying…"
				label="Copy diagnostics"
				onRun={async () => {
					await copyDiagnostics(target);
					toast.success("Diagnostics copied to clipboard");
				}}
			/>
		</div>
	);
}
