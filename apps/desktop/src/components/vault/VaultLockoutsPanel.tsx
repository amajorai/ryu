// Machine identities locked after failed logins, with Unlock, and the login
// lockout settings. Every route needs the vault `admin` capability on
// `sys/lockouts`. Core replaces the whole config on a save, so the form sends
// every field.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { sileo } from "sileo";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	listVaultLockouts,
	setVaultLockoutConfig,
	unlockVaultIdentity,
	type VaultLockoutConfig,
} from "@/src/lib/api/vault-lockouts.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
import { isForbidden, vaultErrorMessage } from "./vault-errors.ts";

const queryKey = (url: string) => ["vault", "lockouts", url];

function whenLabel(value: string | number): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? String(value)
		: formatDateTime(date.toISOString());
}

/** Whole minutes as seconds, or null when not a positive whole number. */
export function minutesToSecs(value: string): number | null {
	const minutes = Number(value);
	return Number.isInteger(minutes) && minutes > 0 ? minutes * 60 : null;
}

function LockoutSettingsForm({
	saved,
	target,
}: {
	saved: VaultLockoutConfig;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const [enabled, setEnabled] = useState(saved.enabled);
	const [threshold, setThreshold] = useState(String(saved.threshold));
	const [windowMinutes, setWindowMinutes] = useState(
		String(saved.windowSecs / 60)
	);
	const [durationMinutes, setDurationMinutes] = useState(
		String(saved.durationSecs / 60)
	);
	const thresholdValue = Number(threshold);
	const windowSecs = minutesToSecs(windowMinutes);
	const durationSecs = minutesToSecs(durationMinutes);
	const valid =
		Number.isInteger(thresholdValue) &&
		thresholdValue > 0 &&
		windowSecs !== null &&
		durationSecs !== null;
	const saveMutation = useMutation({
		mutationFn: () =>
			setVaultLockoutConfig(target, {
				enabled,
				threshold: thresholdValue,
				windowSecs: windowSecs ?? saved.windowSecs,
				durationSecs: durationSecs ?? saved.durationSecs,
			}),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: queryKey(target.url) });
			sileo.success({ title: tl("Lockout settings saved") });
		},
	});
	const dirty =
		enabled !== saved.enabled ||
		thresholdValue !== saved.threshold ||
		windowSecs !== saved.windowSecs ||
		durationSecs !== saved.durationSecs;

	return (
		<form
			className="space-y-4 p-4"
			onSubmit={(event) => {
				event.preventDefault();
				saveMutation.mutate();
			}}
		>
			<div className="flex items-center justify-between gap-4">
				<Label htmlFor="vault-lockout-enabled">
					Lock machine identities after failed logins
				</Label>
				<Switch
					checked={enabled}
					id="vault-lockout-enabled"
					onCheckedChange={setEnabled}
				/>
			</div>
			<div className="grid gap-3 sm:grid-cols-3">
				<div className="space-y-1.5">
					<Label htmlFor="vault-lockout-threshold">Failed logins</Label>
					<Input
						id="vault-lockout-threshold"
						inputMode="numeric"
						onChange={(event) => setThreshold(event.target.value)}
						value={threshold}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="vault-lockout-window">Within (minutes)</Label>
					<Input
						id="vault-lockout-window"
						inputMode="numeric"
						onChange={(event) => setWindowMinutes(event.target.value)}
						value={windowMinutes}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="vault-lockout-duration">Locked for (minutes)</Label>
					<Input
						id="vault-lockout-duration"
						inputMode="numeric"
						onChange={(event) => setDurationMinutes(event.target.value)}
						value={durationMinutes}
					/>
				</div>
			</div>
			{valid ? null : (
				<p className="text-sm text-status-destructive" role="alert">
					Use whole numbers above zero.
				</p>
			)}
			{saveMutation.error ? (
				<p className="text-sm text-status-destructive" role="alert">
					{vaultErrorMessage(
						saveMutation.error,
						"Could not save the lockout settings.",
						tl
					)}
				</p>
			) : null}
			<div className="flex justify-end">
				<Button
					disabled={!(dirty && valid) || saveMutation.isPending}
					type="submit"
				>
					Save
				</Button>
			</div>
		</form>
	);
}

export function VaultLockoutsPanel({ target }: { target: ApiTarget }) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const lockoutsQuery = useQuery({
		queryKey: queryKey(target.url),
		queryFn: () => listVaultLockouts(target),
	});
	const unlockMutation = useMutation({
		mutationFn: (identity: string) => unlockVaultIdentity(target, identity),
		onSuccess: async (_wasLocked, identity) => {
			await queryClient.invalidateQueries({ queryKey: queryKey(target.url) });
			sileo.success({ title: tl("Unlocked {identity}", { identity }) });
		},
	});

	if (isForbidden(lockoutsQuery.error)) {
		return null;
	}

	return (
		<SettingsSection
			caption="Machine identities that fail to log in too often are refused until the lock ends or an admin unlocks them."
			title="Login lockout"
		>
			<SettingsCard className="divide-y p-0">
				{lockoutsQuery.isLoading ? (
					<SkeletonRows inset="panel" rows={2} />
				) : lockoutsQuery.error ? (
					<p className="p-4 text-sm text-status-destructive">
						{vaultErrorMessage(
							lockoutsQuery.error,
							"Could not load the login lockouts.",
							tl
						)}
					</p>
				) : lockoutsQuery.data ? (
					<>
						{lockoutsQuery.data.locked.length ? (
							<ul className="divide-y">
								{lockoutsQuery.data.locked.map((row) => (
									<li
										className="flex items-center justify-between gap-4 px-4 py-3"
										key={row.identity}
									>
										<div className="min-w-0">
											<p className="truncate font-mono text-sm">
												{row.identity}
											</p>
											<p className="mt-0.5 text-muted-foreground text-xs">
												{tl("{failures} failed logins, locked until {until}", {
													failures: row.failures,
													until: whenLabel(row.lockedUntil),
												})}
											</p>
										</div>
										<Button
											aria-label={tl("Unlock {identity}", {
												identity: row.identity,
											})}
											disabled={unlockMutation.isPending}
											onClick={() => unlockMutation.mutate(row.identity)}
											size="sm"
											variant="ghost"
										>
											Unlock
										</Button>
									</li>
								))}
							</ul>
						) : (
							<p className="p-4 text-center text-muted-foreground text-sm">
								No machine identity is locked.
							</p>
						)}
						<LockoutSettingsForm
							key={JSON.stringify(lockoutsQuery.data.config)}
							saved={lockoutsQuery.data.config}
							target={target}
						/>
					</>
				) : null}
			</SettingsCard>
			{unlockMutation.error ? (
				<p className="px-3.5 text-status-destructive text-xs" role="status">
					{vaultErrorMessage(unlockMutation.error, "Could not unlock.", tl)}
				</p>
			) : null}
		</SettingsSection>
	);
}
