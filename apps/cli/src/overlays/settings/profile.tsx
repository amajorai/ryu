import { coreAuthStatusWireSchema } from "../../core/auth-status-wire.ts";
import { nativeErrorMessage as errorText } from "../../core/native-errors.ts";
import { profileNameResponseSchema } from "../../core/settings-response-codecs.ts";
import { securitySessionResponseSchema } from "./account-security-response-contracts.ts";
/* @jsxImportSource @opentui/react */

import { useKeyboard } from "@opentui/react";
import { type ApiTarget, request } from "@ryuhq/core-client/client";
import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { accountBackendTarget } from "../../core/authBackend.ts";
import { useCore } from "../../core/CoreContext.tsx";
import { tf } from "../../i18n/translate.ts";
import { PersonalContext } from "./personal-context.tsx";
import { ProfileAvatar } from "./profile-avatar.tsx";

interface Profile {
	email: string;
	name: string;
	token: string;
}

async function fetchProfile(
	target: ApiTarget,
	signal: AbortSignal
): Promise<Profile | null> {
	const status = await request(
		target,
		"/api/auth/status",
		{
			signal,
		},
		coreAuthStatusWireSchema
	);
	const token = status.authenticated ? status.token?.trim() : null;
	if (!token) {
		return null;
	}

	const authTarget = accountBackendTarget(token);
	const session = await request(
		authTarget,
		"/api/auth/get-session",
		{ signal },
		securitySessionResponseSchema
	);
	if (!session?.user) {
		return null;
	}

	return {
		email: session.user.email ?? "—",
		name: session.user.name ?? "",
		token,
	};
}

export function ProfileTab({
	active,
	onEditingChange,
}: {
	active: boolean;
	onEditingChange: (editing: boolean) => void;
}) {
	const { target } = useCore();
	const theme = useTheme();
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [profile, setProfile] = useState<Profile | null>(null);
	const [draft, setDraft] = useState("");
	const [editing, setEditing] = useState(false);
	const [avatarEditing, setAvatarEditing] = useState(false);
	const [personalEditing, setPersonalEditing] = useState(false);
	const setAvatarEditMode = useCallback(
		(next: boolean) => {
			setAvatarEditing(next);
			onEditingChange(next);
		},
		[onEditingChange]
	);
	const setPersonalEditMode = useCallback(
		(next: boolean) => {
			setPersonalEditing(next);
			onEditingChange(next);
		},
		[onEditingChange]
	);
	const [saving, setSaving] = useState(false);
	const [statusMessage, setStatusMessage] = useState<string | null>(null);

	const setEditMode = useCallback(
		(next: boolean) => {
			setEditing(next);
			onEditingChange(next);
		},
		[onEditingChange]
	);

	const load = useCallback(
		async (signal: AbortSignal) => {
			setLoading(true);
			setLoadError(null);
			try {
				const result = await fetchProfile(target, signal);
				if (signal.aborted) {
					return;
				}
				setProfile(result);
				setDraft(result?.name ?? "");
			} catch (error) {
				if (!signal.aborted) {
					setLoadError(errorText(error));
					setProfile(null);
				}
			} finally {
				if (!signal.aborted) {
					setLoading(false);
				}
			}
		},
		[target]
	);

	useEffect(() => {
		if (!active) {
			return;
		}
		const controller = new AbortController();
		void load(controller.signal);
		return () => {
			controller.abort();
			onEditingChange(false);
		};
	}, [active, load, onEditingChange]);

	const refresh = useCallback(() => {
		const controller = new AbortController();
		void load(controller.signal);
	}, [load]);

	const cancelEdit = useCallback(() => {
		setDraft(profile?.name ?? "");
		setStatusMessage(null);
		setEditMode(false);
	}, [profile?.name, setEditMode]);

	const beginEdit = useCallback(() => {
		setStatusMessage(null);
		setEditMode(true);
	}, [setEditMode]);

	const saveName = useCallback(async () => {
		if (!(profile && editing) || saving) {
			return;
		}
		const name = draft.trim();
		if (!name) {
			setStatusMessage("Display name cannot be empty.");
			return;
		}
		if (name.length > 50) {
			setStatusMessage("Display name cannot exceed 50 characters.");
			return;
		}
		if (name === profile.name) {
			cancelEdit();
			return;
		}

		setSaving(true);
		setStatusMessage(null);
		try {
			const authTarget = accountBackendTarget(profile.token);
			const result = await request(
				authTarget,
				"/api/profile/name",
				{ method: "PUT", body: { name } },
				profileNameResponseSchema
			);
			if (result.success !== true) {
				throw new Error("The account service did not confirm the name update.");
			}
			const savedName = result.name ?? name;
			setProfile({ ...profile, name: savedName });
			setDraft(savedName);
			setStatusMessage("Display name updated.");
			setEditMode(false);
		} catch (error) {
			setStatusMessage(`Could not update display name: ${errorText(error)}`);
		} finally {
			setSaving(false);
		}
	}, [cancelEdit, draft, editing, profile, saving, setEditMode]);

	useKeyboard((key) => {
		if (!active || loading || avatarEditing || personalEditing) {
			return;
		}
		if (editing) {
			if (key.name === "return") {
				void saveName();
			} else if (key.name === "tab") {
				cancelEdit();
			}
			return;
		}
		if (key.name === "r" && loadError) {
			refresh();
		} else if (key.name === "e" && profile) {
			beginEdit();
		}
	});

	return (
		<Card subtitle="Your Ryu account profile" title="Profile">
			{loading ? (
				<text fg={theme.colors.mutedForeground}>Loading profile…</text>
			) : null}
			{loadError ? (
				<box flexDirection="column" gap={1}>
					<text fg={theme.colors.error}>
						{tf("Could not load profile: {error}", { error: loadError })}
					</text>
					<text fg={theme.colors.mutedForeground}>Press r to retry.</text>
				</box>
			) : null}
			{loading || loadError || profile ? null : (
				<box flexDirection="column" gap={1}>
					<text fg={theme.colors.mutedForeground}>
						Sign in from Settings → Account to view and edit your profile.
					</text>
				</box>
			)}
			{!(loading || loadError) && profile ? (
				<box flexDirection="column" gap={1}>
					<text fg={theme.colors.mutedForeground}>Display name</text>
					{editing ? (
						<box flexDirection="row" gap={1}>
							<input
								focused={active}
								onInput={(value: string) => setDraft(value.slice(0, 50))}
								placeholder="Your name"
								value={draft}
							/>
							<box
								borderColor={theme.colors.border}
								borderStyle="single"
								onMouseDown={() => void saveName()}
								paddingLeft={1}
								paddingRight={1}
							>
								<text fg={theme.colors.primary}>
									{saving ? "Saving…" : "Save"}
								</text>
							</box>
							<box
								borderColor={theme.colors.border}
								borderStyle="single"
								onMouseDown={cancelEdit}
								paddingLeft={1}
								paddingRight={1}
							>
								<text fg={theme.colors.mutedForeground}>Cancel</text>
							</box>
						</box>
					) : (
						<box flexDirection="row" gap={1}>
							<text fg={theme.colors.foreground}>{profile.name || "—"}</text>
							<box
								borderColor={theme.colors.border}
								borderStyle="single"
								onMouseDown={beginEdit}
								paddingLeft={1}
								paddingRight={1}
							>
								<text fg={theme.colors.primary}>Edit</text>
							</box>
						</box>
					)}
					<box flexDirection="row" gap={1}>
						<text fg={theme.colors.mutedForeground}>Email</text>
						<text fg={theme.colors.foreground}>{profile.email}</text>
					</box>
					{statusMessage ? (
						<text
							fg={
								statusMessage.startsWith("Could not") ||
								statusMessage.includes("cannot")
									? theme.colors.error
									: theme.colors.success
							}
						>
							{statusMessage}
						</text>
					) : null}
					<ProfileAvatar
						active={active && !editing && !personalEditing}
						authTarget={accountBackendTarget(profile.token)}
						onEditingChange={setAvatarEditMode}
					/>
					<text fg={theme.colors.mutedForeground}>
						{editing
							? "Type to edit · Enter save · Tab cancel"
							: "e or click Edit to change your display name"}
					</text>
				</box>
			) : null}
			<PersonalContext
				active={active && !editing && !avatarEditing}
				onEditingChange={setPersonalEditMode}
			/>
		</Card>
	);
}
