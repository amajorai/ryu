import { settingsApi } from "@ryu/settings";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import { useStepUp } from "../../StepUpDialog.tsx";

interface EmailChangeDialogProps {
	currentEmail: string;
}

export function EmailChangeDialog({ currentEmail }: EmailChangeDialogProps) {
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [newEmail, setNewEmail] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const stepUp = useStepUp();

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!newEmail) {
			return;
		}
		setIsSubmitting(true);
		try {
			const result = await stepUp.guard("account.security", () =>
				settingsApi.user.initiateEmailChange(newEmail)
			);
			if (result === null) {
				return;
			}
			sileo.success({ title: "Verification emails sent to both addresses" });
			queryClient.invalidateQueries({ queryKey: ["email-change-status"] });
			setOpen(false);
			setNewEmail("");
		} catch (error) {
			sileo.error({
				title:
					error instanceof Error
						? error.message
						: "Failed to initiate email change",
			});
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<>
			<Dialog onOpenChange={setOpen} open={open}>
				<DialogTrigger render={<Button size="sm" variant="ghost" />}>
					Change Email
				</DialogTrigger>
				<DialogContent className="sm:max-w-[400px]">
					<DialogHeader>
						<DialogTitle>Change Email Address</DialogTitle>
						<DialogDescription>
							We'll send verification links to both your current and new email
							address.
						</DialogDescription>
					</DialogHeader>
					<form className="space-y-4" onSubmit={handleSubmit}>
						<div className="space-y-2">
							<Label htmlFor="current-email">Current Email</Label>
							<Input
								disabled
								id="current-email"
								tone="muted"
								value={currentEmail}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="new-email">New Email</Label>
							<Input
								autoComplete="email"
								id="new-email"
								onChange={(e) => setNewEmail(e.target.value)}
								placeholder="new@example.com"
								required
								type="email"
								value={newEmail}
							/>
						</div>
						<DialogFooter>
							<Button
								onClick={() => setOpen(false)}
								type="button"
								variant="ghost"
							>
								Cancel
							</Button>
							<Button disabled={isSubmitting || !newEmail} type="submit">
								{isSubmitting ? "Sending…" : "Send Verification"}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
			{stepUp.dialog}
		</>
	);
}
