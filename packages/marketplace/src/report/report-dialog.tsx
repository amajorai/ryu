// packages/marketplace/src/report/report-dialog.tsx
//
// Controlled dialog for filing a marketplace/app report. Reason dropdown +
// optional details. Submit is injected so desktop (bearer) and web (cookie) stay outside.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useEffect, useState } from "react";
import { sileo } from "sileo";
import {
	REPORT_REASON_OPTIONS,
	type ReportReason,
	type ReportTarget,
	type SubmitReportInput,
	type SubmitReportResult,
} from "./types.ts";

const MAX_DETAILS = 2000;

export interface ReportDialogProps {
	onOpenChange: (open: boolean) => void;
	/** Surface-provided submit (desktop/web API client). */
	onSubmit: (
		input: SubmitReportInput
	) => Promise<SubmitReportResult | undefined>;
	open: boolean;
	target: ReportTarget | null;
}

export function ReportDialog({
	open,
	onOpenChange,
	target,
	onSubmit,
}: ReportDialogProps) {
	const tl = useLiteralMessages();
	const [reason, setReason] = useState<ReportReason | null>(null);
	const [details, setDetails] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (open) {
			setReason(null);
			setDetails("");
			setBusy(false);
		}
	}, [open, target?.id, target?.kind]);

	const name = target?.itemName?.trim() || target?.id || "this item";
	const selectedOption = REPORT_REASON_OPTIONS.find(
		(option) => option.value === reason
	);
	const detailsRequired = reason === "other";
	const canSubmit =
		Boolean(target && reason) &&
		!(detailsRequired && details.trim().length === 0) &&
		!busy;

	const handleSubmit = async () => {
		if (!(target && reason)) {
			return;
		}
		setBusy(true);
		try {
			const result = await onSubmit({
				...target,
				reason,
				details: details.trim() || null,
			});
			onOpenChange(false);
			const issuesUrl = result?.suggestIssuesUrl?.trim() || null;
			if (issuesUrl && reason === "broken") {
				sileo.success({
					title: "Report submitted",
					description: issuesUrl
						? tl("Also consider filing upstream: {issuesUrl}", { issuesUrl })
						: "Thanks — we'll look into it.",
				});
			} else {
				sileo.success({
					title: "Report submitted",
					description:
						reason === "malicious" ||
						reason === "spam" ||
						reason === "inappropriate" ||
						reason === "ip"
							? "Our team will review this shortly."
							: "Thanks — we'll look into it.",
				});
			}
		} catch (e) {
			const message =
				e instanceof Error ? e.message : "Could not submit report.";
			sileo.error({ title: message });
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{tl("Report {name}", { name })}</DialogTitle>
					<DialogDescription>
						Tell us what's wrong. Security and abuse reports go to Ryu; quality
						issues on hosted listings also reach the publisher.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="report-reason">Reason</Label>
						<Select
							items={REPORT_REASON_OPTIONS}
							onValueChange={(value) => {
								setReason(
									REPORT_REASON_OPTIONS.find((option) => option.value === value)
										?.value ?? null
								);
							}}
							value={reason}
						>
							<SelectTrigger className="w-full" id="report-reason">
								<SelectValue placeholder="Select a reason" />
							</SelectTrigger>
							<SelectContent>
								{REPORT_REASON_OPTIONS.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{selectedOption ? (
							<span className="text-muted-foreground text-xs">
								{selectedOption.description}
							</span>
						) : null}
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="report-details">
							{detailsRequired
								? tl("Details (required)")
								: tl("Details (optional)")}
						</Label>
						<Textarea
							id="report-details"
							maxLength={MAX_DETAILS}
							onChange={(e) => setDetails(e.target.value)}
							placeholder="What happened? Include steps to reproduce if it's broken."
							rows={4}
							value={details}
						/>
						<span className="text-muted-foreground text-xs">
							{details.length}/{MAX_DETAILS}
						</span>
					</div>
				</div>

				<DialogFooter>
					<Button
						disabled={busy}
						onClick={() => onOpenChange(false)}
						type="button"
						variant="ghost"
					>
						Cancel
					</Button>
					<Button
						disabled={!canSubmit}
						onClick={() => {
							void handleSubmit();
						}}
						type="button"
					>
						{busy ? "Submitting…" : "Submit report"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
