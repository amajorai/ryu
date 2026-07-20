import { settingsApi } from "@ryu/settings";
import { Button } from "@ryu/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ryu/ui/components/dialog";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";

interface EmailChangeDialogProps {
	currentEmail: string;
}

export function EmailChangeDialog({ currentEmail }: EmailChangeDialogProps) {
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [currentPassword, setCurrentPassword] = useState("");
	const [newEmail, setNewEmail] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!(currentPassword && newEmail)) {
			return;
		}
		setIsSubmitting(true);
		try {
			await settingsApi.user.initiateEmailChange(currentPassword, newEmail);
			sileo.success({ title: "Verification emails sent to both addresses" });
			queryClient.invalidateQueries({ queryKey: ["email-change-status"] });
			setOpen(false);
			setCurrentPassword("");
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
						<Label>Current Email</Label>
						<Input className="bg-muted" disabled value={currentEmail} />
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
					<div className="space-y-2">
						<Label htmlFor="email-change-password">Current Password</Label>
						<Input
							autoComplete="current-password"
							id="email-change-password"
							onChange={(e) => setCurrentPassword(e.target.value)}
							placeholder="Enter your password to confirm"
							required
							type="password"
							value={currentPassword}
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
						<Button
							disabled={isSubmitting || !currentPassword || !newEmail}
							type="submit"
						>
							{isSubmitting ? "Sending…" : "Send Verification"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
