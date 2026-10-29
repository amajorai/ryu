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
import { passwordValidationMessage } from "@ryuhq/protocol/password-policy";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import { useStepUp } from "../../StepUpDialog.tsx";

interface PasswordChangeDialogProps {
	hasPassword: boolean;
}

export function PasswordChangeDialog({
	hasPassword,
}: PasswordChangeDialogProps) {
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const stepUp = useStepUp();

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (newPassword !== confirmPassword) {
			sileo.error({ title: "Passwords do not match" });
			return;
		}
		// The rules sign-up and the set-password route hold a password to.
		const reason = passwordValidationMessage(newPassword);
		if (reason) {
			sileo.error({ title: reason });
			return;
		}
		setIsSubmitting(true);
		try {
			const result = await stepUp.guard("account.security", () =>
				settingsApi.user.setPassword(newPassword)
			);
			if (result === null) {
				return;
			}
			sileo.success({
				title: hasPassword ? "Password updated" : "Password set",
			});
			queryClient.invalidateQueries({ queryKey: ["password-status"] });
			setOpen(false);
			setNewPassword("");
			setConfirmPassword("");
		} catch (error) {
			sileo.error({
				title:
					error instanceof Error ? error.message : "Failed to update password",
			});
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<>
			<Dialog onOpenChange={setOpen} open={open}>
				<DialogTrigger render={<Button size="sm" variant="ghost" />}>
					{hasPassword ? "Change Password" : "Set Password"}
				</DialogTrigger>
				<DialogContent className="sm:max-w-[400px]">
					<DialogHeader>
						<DialogTitle>
							{hasPassword ? "Change Password" : "Set Password"}
						</DialogTitle>
						<DialogDescription>
							{hasPassword
								? "Confirm your identity, then choose a new password."
								: "Set a password to sign in with email and password."}
						</DialogDescription>
					</DialogHeader>
					<form className="space-y-4" onSubmit={handleSubmit}>
						<div className="space-y-2">
							<Label htmlFor="pw-new">New Password</Label>
							<Input
								autoComplete="new-password"
								id="pw-new"
								minLength={8}
								onChange={(e) => setNewPassword(e.target.value)}
								placeholder="At least 8 characters"
								required
								type="password"
								value={newPassword}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="pw-confirm">Confirm New Password</Label>
							<Input
								autoComplete="new-password"
								id="pw-confirm"
								onChange={(e) => setConfirmPassword(e.target.value)}
								required
								type="password"
								value={confirmPassword}
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
								disabled={isSubmitting || !newPassword || !confirmPassword}
								type="submit"
							>
								{isSubmitting
									? "Saving…"
									: hasPassword
										? "Update Password"
										: "Set Password"}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
			{stepUp.dialog}
		</>
	);
}
