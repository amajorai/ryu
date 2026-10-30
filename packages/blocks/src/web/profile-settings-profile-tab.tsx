"use client";

import { Button, buttonVariants } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Switch } from "@ryu/ui/components/switch";
import { Github } from "lucide-react";
import type { ReactNode } from "react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "../desktop/settings-items.tsx";

// Inline text fields in a settings row: compact height, a fixed width that
// leaves the row title room on a phone-width column.
const ROW_INPUT_CLASS = "h-8 w-36 sm:w-56";

export interface ProfileTabPanelProps {
	avatarSlot?: ReactNode;
	email: string;
	isProfilePublic: boolean;
	isSaving: boolean;
	isSavingProfileVisibility: boolean;
	isSavingUsername: boolean;
	name: string;
	onNameChange: (name: string) => void;
	onProfilePublicToggle: (checked: boolean) => void;
	onSaveName: () => void;
	onSaveUsername: () => void;
	onUsernameChange: (username: string) => void;
	publicProfileHref?: string;
	publicProfileSlot?: ReactNode;
	username: string;
}

export function ProfileTabPanel({
	avatarSlot,
	email,
	isProfilePublic,
	isSaving,
	isSavingProfileVisibility,
	isSavingUsername,
	name,
	onNameChange,
	onProfilePublicToggle,
	onSaveName,
	onSaveUsername,
	onUsernameChange,
	publicProfileHref,
	publicProfileSlot,
	username,
}: ProfileTabPanelProps) {
	return (
		<>
			{avatarSlot ? (
				<SettingsSection
					caption="Upload a profile picture. Supports JPEG, PNG, and WebP formats. Maximum file size is 10MB."
					title="Profile photo"
				>
					<SettingsCard className="flex justify-center py-5">
						{avatarSlot}
					</SettingsCard>
				</SettingsSection>
			) : null}

			<SettingsSection title="Personal info">
				<SettingsGroup>
					<SettingsItem
						actions={
							<div className="flex items-center gap-2">
								<Input
									aria-label="Full name"
									className={ROW_INPUT_CLASS}
									id="profile-name"
									onChange={(e) => onNameChange(e.target.value)}
									placeholder="Your name"
									value={name}
								/>
								<Button loading={isSaving} onClick={onSaveName} size="sm">
									{isSaving ? "Saving…" : "Save profile"}
								</Button>
							</div>
						}
						title="Full name"
					/>
					<SettingsItem
						actions={
							<div>
								<Input
									aria-label="Email address"
									className={ROW_INPUT_CLASS}
									disabled
									id="profile-email"
									placeholder="Your email"
									value={email}
								/>
							</div>
						}
						title="Email address"
					/>
					<SettingsItem
						actions={
							<div className="flex items-center gap-2">
								<Input
									aria-label="Username"
									className={ROW_INPUT_CLASS}
									id="profile-username"
									onChange={(e) => onUsernameChange(e.target.value)}
									placeholder="your_handle"
									value={username}
								/>
								<Button
									loading={isSavingUsername}
									onClick={onSaveUsername}
									size="sm"
									variant="outline"
								>
									{isSavingUsername ? "Claiming…" : "Claim username"}
								</Button>
							</div>
						}
						description="Claim a public handle for your Ryu profile."
						title="Username"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection title="Sharing">
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Public profile"
								checked={isProfilePublic}
								disabled={isSavingProfileVisibility}
								onCheckedChange={onProfilePublicToggle}
							/>
						}
						description="Show your public stats page. New profiles are public by default."
						title="Public profile"
					>
						{publicProfileHref && isProfilePublic ? (
							<a
								className="inline-flex text-primary text-xs hover:underline"
								href={publicProfileHref}
							>
								View public profile
							</a>
						) : null}
					</SettingsItem>
				</SettingsGroup>
			</SettingsSection>

			{publicProfileSlot}

			<SettingsSection title="Your data">
				<SettingsGroup>
					<SettingsItem
						actions={<span className="text-muted-foreground text-sm">Off</span>}
						description="We never use your chats, files, or activity to train Ryu models. Core and Gateway are open source, so you can inspect them. A model provider, app, or plugin only processes content when you choose to use it, under that service's own terms and privacy policy."
						title="Train on my data"
					>
						<div className="flex flex-wrap items-center gap-3 pt-1">
							<a
								className={buttonVariants({ size: "sm", variant: "outline" })}
								href="https://github.com/amajorai/ryu"
								rel="noopener noreferrer"
								target="_blank"
							>
								<Github className="size-4" />
								GitHub
							</a>
							<div className="flex gap-3 text-muted-foreground text-xs">
								<a
									className="hover:text-foreground hover:underline"
									href="/privacy"
								>
									Privacy
								</a>
								<a
									className="hover:text-foreground hover:underline"
									href="/terms"
								>
									Terms
								</a>
							</div>
						</div>
					</SettingsItem>
				</SettingsGroup>
			</SettingsSection>
		</>
	);
}
