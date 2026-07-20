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

interface PasswordChangeDialogProps {
	hasPassword: boolean;
}

export function PasswordChangeDialog({
	hasPassword,
}: PasswordChangeDialogProps) {
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [currentPassword, setCurrentPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (newPassword !== confirmPassword) {
			sileo.error({ title: "Passwords do not match" });
			return;
		}
		if (newPassword.length < 8) {
			sileo.error({ title: "Password must be at least 8 characters" });
			return;
		}
		setIsSubmitting(true);
		try {
			await settingsApi.user.setPassword(
				newPassword,
				hasPassword ? currentPassword : undefined
			);
			sileo.success({
				title: hasPassword ? "Password updated" : "Password set",
			});
			queryClient.invalidateQueries({ queryKey: ["password-status"] });
			setOpen(false);
			setCurrentPassword("");
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
							? "Enter your current password and a new one."
							: "Set a password to sign in with email and password."}
					</DialogDescription>
				</DialogHeader>
				<form className="space-y-4" onSubmit={handleSubmit}>
					{hasPassword && (
						<div className="space-y-2">
							<Label htmlFor="pw-current">Current Password</Label>
							<Input
								autoComplete="current-password"
								id="pw-current"
								onChange={(e) => setCurrentPassword(e.target.value)}
								required
								type="password"
								value={currentPassword}
							/>
						</div>
					)}
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
							disabled={
								isSubmitting ||
								!newPassword ||
								!confirmPassword ||
								(hasPassword && !currentPassword)
							}
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
	);
}
