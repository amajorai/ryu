import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReportDialog } from "../../../../packages/marketplace/src/report/report-dialog.tsx";
import type { SubmitReportInput } from "../../../../packages/marketplace/src/report/types.ts";
import "../../src/index.css";

function Story() {
	const [open, setOpen] = useState(true);
	const [submitted, setSubmitted] = useState<SubmitReportInput | null>(null);

	useEffect(() => {
		document.body.dataset.harnessReady = "1";
	}, []);

	return (
		<main className="min-h-screen bg-background p-6 text-foreground sm:p-10">
			<div className="mx-auto flex max-w-2xl flex-col gap-6">
				<header className="flex flex-col gap-3 border-b pb-5 sm:flex-row sm:items-start sm:justify-between">
					<div>
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
							React verification artifact
						</p>
						<h1 className="mt-2 font-semibold text-3xl tracking-tight">
							Report dialog reason dropdown
						</h1>
						<p className="mt-2 text-muted-foreground text-sm leading-6">
							The shipping marketplace dialog is mounted below with a local
							submit handler for end-to-end interaction proof.
						</p>
					</div>
					<span
						className="rounded-full border border-success/30 bg-success/10 px-3 py-1.5 font-medium text-success text-xs"
						data-testid="proof-status"
					>
						LIVE COMPONENT PROOF
					</span>
				</header>

				<div className="rounded-2xl border border-dashed p-4 text-sm">
					<p className="font-medium">Expected behavior</p>
					<p className="mt-1 text-muted-foreground">
						Reason choices stay inside one dropdown; choosing one reveals its
						explanation below the trigger.
					</p>
				</div>

				<ReportDialog
					onOpenChange={setOpen}
					onSubmit={async (input) => {
						setSubmitted(input);
						return undefined;
					}}
					open={open}
					target={{ id: "example-app", itemName: "Example app", kind: "app" }}
				/>

				{submitted ? (
					<output
						className="rounded-xl border bg-card p-3 text-sm"
						data-testid="submitted-report"
					>
						Submitted reason: {submitted.reason}
					</output>
				) : null}
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
