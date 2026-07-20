import { AvatarUploadCropper, settingsApi } from "@ryu/settings";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import { toast } from "@ryu/ui/components/sileo";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSession } from "@/lib/auth-client.ts";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

export function ProfileTab() {
	const queryClient = useQueryClient();
	const { data: sessionData, refetch: refetchSession } = useSession();
	const user = sessionData?.user;

	const [name, setName] = useState(user?.name ?? "");
	const [isSavingName, setIsSavingName] = useState(false);

	// Session data loads asynchronously, so backfill the field once the name
	// arrives. Keyed on user?.name so it won't clobber in-progress edits.
	useEffect(() => {
		if (user?.name) {
			setName(user.name);
		}
	}, [user?.name]);

	const handleNameSave = async () => {
		if (!name.trim() || name === user?.name) {
			return;
		}
		setIsSavingName(true);
		try {
			await settingsApi.profile.updateName(name.trim());
			await refetchSession();
			toast.success("Name updated");
		} catch {
			toast.error("Couldn't update your name", {
				description: "Check your connection and try again.",
			});
		} finally {
			setIsSavingName(false);
		}
	};

	const avatarUrl = user?.image ?? null;

	return (
		<div className="space-y-6">
			<SettingsSection title="Profile photo">
				<SettingsCard>
					<AvatarUploadCropper
						currentAvatarUrl={avatarUrl}
						onUploadComplete={() => {
							refetchSession();
							queryClient.invalidateQueries({ queryKey: ["session"] });
						}}
						userName={user?.name}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection title="Display name">
				<SettingsCard className="flex gap-2">
					<Label className="sr-only" htmlFor="display-name">
						Display Name
					</Label>
					<Input
						id="display-name"
						maxLength={50}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								handleNameSave();
							}
						}}
						placeholder="Your name"
						value={name}
					/>
					<Button
						disabled={isSavingName || !name.trim() || name === user?.name}
						onClick={handleNameSave}
						size="sm"
					>
						{isSavingName ? "Saving…" : "Save"}
					</Button>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="To change your email, go to the Account tab."
				title="Email"
			>
				<SettingsCard>
					<Label className="sr-only" htmlFor="email">
						Email
					</Label>
					<Input
						className="bg-muted"
						disabled
						id="email"
						value={user?.email ?? ""}
					/>
				</SettingsCard>
			</SettingsSection>
		</div>
	);
}
