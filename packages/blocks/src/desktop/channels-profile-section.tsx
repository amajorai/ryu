"use client";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import { Textarea } from "@ryu/ui/components/textarea";
import type { Dispatch, SetStateAction } from "react";
import type { FormState } from "./channels-model.ts";

interface ChannelProfileSectionProps {
	form: FormState;
	setForm: Dispatch<SetStateAction<FormState>>;
}

export function ChannelProfileSection({
	form,
	setForm,
}: ChannelProfileSectionProps) {
	const tl = useLiteralMessages();
	return (
		<div className="space-y-3 rounded-lg border bg-card p-4">
			<div>
				<p className="font-medium text-sm">Profile</p>
				<p className="text-muted-foreground text-xs">
					Pushed to the platform when the gateway starts. Leave a field blank to
					keep whatever the bot already has.
				</p>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="channel-profile-name">Display name</Label>
				<Input
					id="channel-profile-name"
					onChange={(e) =>
						setForm((f) => ({
							...f,
							profileName: e.target.value || null,
						}))
					}
					placeholder="Leave blank to keep the current name"
					value={form.profileName ?? ""}
				/>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="channel-profile-bio">
					{tl("Short bio ({length}/120)", {
						length: (form.profileShortBio ?? "").length,
					})}
				</Label>
				<Input
					id="channel-profile-bio"
					maxLength={120}
					onChange={(e) =>
						setForm((f) => ({
							...f,
							profileShortBio: e.target.value || null,
						}))
					}
					placeholder="Shown on the bot's profile page"
					value={form.profileShortBio ?? ""}
				/>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="channel-profile-description">
					{tl("Description ({length}/512)", {
						length: (form.profileDescription ?? "").length,
					})}
				</Label>
				<Textarea
					id="channel-profile-description"
					maxLength={512}
					onChange={(e) =>
						setForm((f) => ({
							...f,
							profileDescription: e.target.value || null,
						}))
					}
					placeholder="Shown in an empty chat, before the first message"
					rows={3}
					value={form.profileDescription ?? ""}
				/>
			</div>
		</div>
	);
}
