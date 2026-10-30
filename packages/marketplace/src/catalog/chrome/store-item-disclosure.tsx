import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { useState } from "react";
import { PublisherHealthCard } from "../detail/publisher-health-card.tsx";
import type { PublisherInstallDisclosureProps } from "./store-item-action-props.ts";

/** The shared two-step disclosure for a publisher without identity verification. */
export function PublisherInstallDisclosure({
	onInstall,
	onOpenChange,
	open,
	publisherHealth,
	publisherTrust,
}: PublisherInstallDisclosureProps) {
	const [step, setStep] = useState<"review" | "confirm">("review");
	const handleOpenChange = (nextOpen: boolean) => {
		if (!nextOpen) {
			setStep("review");
		}
		onOpenChange(nextOpen);
	};

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{step === "review"
							? "This publisher is not verified"
							: "Install community package?"}
					</DialogTitle>
					<DialogDescription>
						{step === "review"
							? "Anyone can publish a community package. Ryu has not verified this publisher's identity."
							: "This package is from a publisher without verified identity. You are responsible for reviewing the source and requested access."}
					</DialogDescription>
				</DialogHeader>
				{step === "review" ? (
					<PublisherHealthCard
						publisherTrust={publisherTrust}
						{...publisherHealth}
					/>
				) : (
					<div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
						<p className="font-medium">Review the source before continuing.</p>
						<p className="mt-1 text-muted-foreground">
							The health score is only a summary of reported signals and is not
							a guarantee of safety.
						</p>
					</div>
				)}
				<DialogFooter>
					{step === "review" ? (
						<Button onClick={() => setStep("confirm")} variant="secondary">
							Review risk and continue
						</Button>
					) : (
						<Button
							onClick={() => {
								handleOpenChange(false);
								onInstall();
							}}
							variant="destructive"
						>
							I understand the risk, install
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
