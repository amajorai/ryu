import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { useState } from "react";
import { ScrollFadeEffect } from "@/src/components/ui/scroll-fade-effect.tsx";

export function AddIdentityDialog({
	open,
	onOpenChange,
	existingProfileIds,
	onCreate,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	existingProfileIds: string[];
	onCreate: (input: { profile_id: string; domain: string }) => Promise<void>;
}) {
	const [profileId, setProfileId] = useState("");
	const [domain, setDomain] = useState("");
	const [creating, setCreating] = useState(false);

	const canSubmit = profileId.trim() !== "" && domain.trim() !== "";

	const handleCreate = async () => {
		setCreating(true);
		try {
			await onCreate({ profile_id: profileId.trim(), domain: domain.trim() });
			setProfileId("");
			setDomain("");
			onOpenChange(false);
		} finally {
			setCreating(false);
		}
	};

	return (
		<Dialog
			onOpenChange={(v) => {
				if (!v) {
					setProfileId("");
					setDomain("");
				}
				onOpenChange(v);
			}}
			open={open}
		>
			<DialogContent className="flex max-h-[85vh] flex-col sm:max-w-md">
				<DialogHeader>
					<DialogTitle>New connection</DialogTitle>
				</DialogHeader>

				<ScrollFadeEffect className="min-h-0 flex-1">
					<div className="space-y-4 pb-1">
						<p className="text-muted-foreground text-sm">
							A profile groups every domain an agent should be logged in to.
							Reuse an existing profile name or create a new one.
						</p>
						<div className="space-y-1.5">
							<Label htmlFor="dialog-conn-profile">Profile</Label>
							<Input
								id="dialog-conn-profile"
								list="dialog-identity-profile-ids"
								onChange={(e) => setProfileId(e.target.value)}
								placeholder="personal"
								value={profileId}
							/>
							<datalist id="dialog-identity-profile-ids">
								{existingProfileIds.map((id) => (
									<option key={id} value={id} />
								))}
							</datalist>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="dialog-conn-domain">Domain</Label>
							<Input
								id="dialog-conn-domain"
								onChange={(e) => setDomain(e.target.value)}
								placeholder="app.example.com"
								value={domain}
							/>
						</div>
					</div>
				</ScrollFadeEffect>

				<DialogFooter>
					<Button onClick={() => onOpenChange(false)} variant="ghost">
						Cancel
					</Button>
					<Button
						disabled={!canSubmit}
						loading={creating}
						onClick={handleCreate}
					>
						Create
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
