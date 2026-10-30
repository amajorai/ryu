import {
	Key01Icon,
	MonitorDotIcon,
	SquareLock01Icon,
} from "@hugeicons/core-free-icons";
import { CLOUD_TASKS_BOX_BACKEND_FLAG } from "@ryu/auth/lib/feature-flags";
import { SettingsIconTile } from "@ryu/blocks/desktop/settings-nav.tsx";
import { ComputerUseCostNotice } from "@ryu/blocks/session-box/cost-notice.tsx";
import {
	formatHourlyRate,
	minimumStartWords,
} from "@ryu/blocks/session-box/wire.ts";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useFeatureFlag } from "@/src/hooks/useFeatureFlag.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchGatewayConfig,
	type GatewayComputerUseConfig,
	updateGatewayConfig,
} from "@/src/lib/api/gateway.ts";
import { getPreference, setPreference } from "@/src/lib/api/preferences.ts";
import {
	acknowledgeSessionBoxCostAhead,
	fetchSessionBoxCostNoticeState,
	type SessionBoxCostNoticeState,
	sessionBoxErrorMessage,
} from "@/src/lib/api/session-box.ts";

/** Core preference: where a conversation's computer and browser actions run. */
export const SESSION_BOX_COMPUTER_TARGET_PREF = "session-box-computer-target";

/** `auto`: the conversation's own session Box; `node`: this device's desktop. */
export type SessionBoxComputerTarget = "auto" | "node";

/** Core treats anything but `node` (case-insensitive) as `auto`. */
export function parseSessionBoxComputerTarget(
	value: string | null
): SessionBoxComputerTarget {
	return value?.trim().toLowerCase() === "node" ? "node" : "auto";
}

/**
 * The composer preference for computer use in a conversation. With `auto`
 * (the default) the first computer or browser action in a conversation runs
 * on that conversation's own Box and screen; with `node` it stays on this
 * device's shared desktop. Shown only while the Box rollout is on.
 */
export function SessionBoxComputerTargetSetting({
	canConfigure,
	reachable,
	target,
}: {
	canConfigure: boolean;
	reachable: boolean;
	target: ApiTarget;
}) {
	const enabled = useFeatureFlag(CLOUD_TASKS_BOX_BACKEND_FLAG);
	const [value, setValue] = useState<SessionBoxComputerTarget | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const stableTarget = useMemo(
		() => ({ url: target.url, token: target.token, userJwt: target.userJwt }),
		[target.token, target.url, target.userJwt]
	);

	useEffect(() => {
		if (!(enabled && reachable)) {
			setValue(null);
			return;
		}
		let cancelled = false;
		setError(null);
		getPreference(stableTarget, SESSION_BOX_COMPUTER_TARGET_PREF)
			.then((stored) => {
				if (!cancelled) {
					setValue(parseSessionBoxComputerTarget(stored));
				}
			})
			.catch((cause: unknown) => {
				if (!cancelled) {
					setError(
						cause instanceof Error
							? cause.message
							: "Could not load where computer use runs"
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [enabled, reachable, stableTarget]);

	if (!enabled) {
		return null;
	}

	const save = async (next: SessionBoxComputerTarget) => {
		if (!(reachable && canConfigure) || saving || value === null) {
			return;
		}
		const previous = value;
		setValue(next);
		setSaving(true);
		setError(null);
		try {
			await setPreference(stableTarget, SESSION_BOX_COMPUTER_TARGET_PREF, next);
		} catch (cause: unknown) {
			setValue(previous);
			setError(
				cause instanceof Error
					? cause.message
					: "Could not save where computer use runs"
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<>
			<SettingsGroup>
				<SettingsItem
					actions={
						<select
							aria-label="Where computer use runs in a conversation"
							className="h-8 rounded-lg border-0 bg-muted/50 px-2 text-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
							disabled={
								!(reachable && canConfigure) || saving || value === null
							}
							onChange={(event) =>
								save(parseSessionBoxComputerTarget(event.target.value))
							}
							value={value ?? "auto"}
						>
							<option value="auto">The session's own Box</option>
							<option value="node">This device</option>
						</select>
					}
					description={
						error ??
						"With the session's own Box, the first computer or browser action in a conversation starts a Box with its own screen, billed from credits by the minute with a 5-minute minimum per start. Automations without a conversation always use this device."
					}
					title={
						<span className="flex items-center gap-2">
							<SettingsIconTile icon={MonitorDotIcon} />
							Computer use in conversations
						</span>
					}
				/>
			</SettingsGroup>
			{value === "auto" && reachable ? (
				<SessionBoxCostSetting target={stableTarget} />
			) : null}
		</>
	);
}

/** "Allowed on 20 Oct 2026 at $0.025/hour, 5-minute minimum per start". */
function allowedText(
	tl: LiteralMessage,
	state: SessionBoxCostNoticeState
): string {
	const day = state.acknowledgedAt
		? new Date(state.acknowledgedAt).toLocaleDateString(undefined, {
				day: "numeric",
				month: "short",
				year: "numeric",
			})
		: null;
	const sentences = [day ? tl("Allowed on {day}.", { day }) : tl("Allowed.")];
	if (state.ratePerHourMicroUsd !== null) {
		sentences.push(
			tl("The rate is {hourlyRate}/hour, {minimumStart} minimum per start.", {
				hourlyRate: formatHourlyRate(state.ratePerHourMicroUsd),
				minimumStart: minimumStartWords(state.minimumSecondsPerStart),
			})
		);
	}
	sentences.push(
		tl(
			"Session Boxes start without asking, including in routines and channel runs."
		)
	);
	return sentences.join(" ");
}

/**
 * The one-time computer-use cost acknowledgement, given here ahead of any
 * conversation. A routine's or channel bot's run has nobody to answer the
 * notice in a conversation, so without it such a run's first session Box
 * waits and is then refused. Hidden on a Core that predates the route.
 */
export function SessionBoxCostSetting({ target }: { target: ApiTarget }) {
	const [state, setState] = useState<SessionBoxCostNoticeState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const tl = useLiteralMessages();

	const load = useCallback(
		async (signal?: AbortSignal) => {
			try {
				const next = await fetchSessionBoxCostNoticeState(target, signal);
				if (!signal?.aborted) {
					setState(next);
				}
			} catch (cause: unknown) {
				if (!signal?.aborted) {
					setError(sessionBoxErrorMessage(cause));
				}
			}
		},
		[target]
	);

	useEffect(() => {
		const controller = new AbortController();
		load(controller.signal);
		return () => controller.abort();
	}, [load]);

	if (state === null) {
		return error ? (
			<p className="px-3 text-sm text-status-destructive">{error}</p>
		) : null;
	}
	if (state.acknowledged) {
		return (
			<SettingsGroup>
				<SettingsItem
					actions={
						<span className="text-muted-foreground text-sm">Allowed</span>
					}
					description={allowedText(tl, state)}
					title="Session Box cost"
				/>
			</SettingsGroup>
		);
	}
	const acknowledge = async (rate: number) => {
		try {
			await acknowledgeSessionBoxCostAhead(target, rate);
		} catch (cause: unknown) {
			throw new Error(sessionBoxErrorMessage(cause));
		} finally {
			await load();
		}
	};
	return (
		<div className="px-3 py-2" data-testid="session-box-cost-setting">
			<ComputerUseCostNotice
				notice={{
					minimumSecondsPerStart: state.minimumSecondsPerStart,
					ratePerHourMicroUsd: state.ratePerHourMicroUsd,
					size: state.size,
					waiting: false,
				}}
				onAcknowledge={acknowledge}
			/>
		</div>
	);
}

/** Gateway-owned policy controls for Ghost's use of one selected device. */
export function ComputerUseSettings({
	canConfigure,
	reachable,
	target,
}: {
	canConfigure: boolean;
	reachable: boolean;
	target: ApiTarget;
}) {
	const [config, setConfig] = useState<GatewayComputerUseConfig | null>(null);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const stableTarget = useMemo(
		() => ({ url: target.url, token: target.token, userJwt: target.userJwt }),
		[target.token, target.url, target.userJwt]
	);

	useEffect(() => {
		if (!reachable) {
			setConfig(null);
			setLoading(false);
			return;
		}

		let cancelled = false;
		setLoading(true);
		setError(null);
		setSaved(false);
		fetchGatewayConfig(stableTarget)
			.then((next) => {
				if (!cancelled) {
					setConfig(next.computer_use);
				}
			})
			.catch((cause) => {
				if (!cancelled) {
					setError(
						cause instanceof Error
							? cause.message
							: "Could not load device settings"
					);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [loadAttempt, reachable, stableTarget]);

	const savePolicy = async (patch: Partial<GatewayComputerUseConfig>) => {
		if (!(config && reachable && canConfigure) || saving) {
			return;
		}

		const previous = config;
		const next = { ...config, ...patch };
		setConfig(next);
		setSaving(true);
		setError(null);
		setSaved(false);
		try {
			await updateGatewayConfig(target, { computer_use: next });
			setSaved(true);
		} catch (cause: unknown) {
			setConfig(previous);
			setError(
				cause instanceof Error
					? cause.message
					: "Could not save device settings"
			);
		} finally {
			setSaving(false);
		}
	};

	const lockedUse = config?.locked_use ?? false;
	const securityKey = config?.security_key ?? false;
	// A Gateway that predates the field drops it on save, so the switch would
	// report a change that never persisted.
	const securityKeySupported =
		config !== null && config.security_key !== undefined;
	const switchDisabled =
		loading || saving || !reachable || !canConfigure || config === null;

	// The raw failure stays on the title attribute; the row reads as a sentence.
	// With no policy loaded the failure was the read, so it gets a Retry.
	const errorRow = error ? (
		<SettingsItem
			actions={
				config === null && reachable ? (
					<Button
						onClick={() => setLoadAttempt((attempt) => attempt + 1)}
						size="sm"
						variant="outline"
					>
						Retry
					</Button>
				) : null
			}
			title={
				<span className="text-status-destructive" title={error}>
					{config === null
						? "Couldn’t load device settings."
						: "Couldn’t save device settings."}
				</span>
			}
		/>
	) : null;

	return (
		<SettingsSection
			caption={
				<CaptionInfo
					detail={
						"The Gateway stores the policy; Ghost still has to pass the operating system's safety and permission checks."
					}
				>
					{canConfigure
						? "These permissions belong to the selected device."
						: "View only: changing them needs device configuration access."}
				</CaptionInfo>
			}
			title="Device control"
		>
			<SettingsGroup>
				{loading ? (
					<SettingsItem
						title={
							<span className="text-muted-foreground">
								Loading device settings…
							</span>
						}
					/>
				) : null}
				{reachable ? null : (
					<SettingsItem
						title={
							<span className="text-muted-foreground">
								Device settings are unavailable while this device is offline.
							</span>
						}
					/>
				)}
				{errorRow}
				{saved ? (
					<SettingsItem
						title={<span className="text-status-success">Saved.</span>}
					/>
				) : null}
				<SettingsItem
					actions={
						<div className="flex items-center gap-2">
							<Switch
								aria-label="Allow locked use"
								checked={lockedUse}
								disabled={switchDisabled}
								onCheckedChange={(checked) =>
									savePolicy({ locked_use: checked })
								}
							/>
						</div>
					}
					description="Allow Ghost to request a locked-session path on this device. Turning this on does not unlock the device or bypass local safety controls."
					title={
						<span className="flex items-center gap-2">
							<SettingsIconTile icon={SquareLock01Icon} />
							Allow locked use
						</span>
					}
				/>
				<SettingsItem
					actions={
						<div className="flex items-center gap-2">
							<Switch
								aria-label="Allow hardware security key"
								checked={securityKey}
								disabled={switchDisabled || !securityKeySupported}
								onCheckedChange={(checked) =>
									savePolicy({ security_key: checked })
								}
							/>
						</div>
					}
					description={
						config !== null && !securityKeySupported
							? "This device's Gateway is too old to store this setting. Update Ryu on the device to change it."
							: "Records whether features that use a security key connected to this device may do so. No current feature uses a security key, and the key always requires its own touch or PIN."
					}
					title={
						<span className="flex items-center gap-2">
							<SettingsIconTile icon={Key01Icon} />
							Allow hardware security key
						</span>
					}
				/>
			</SettingsGroup>
			<SessionBoxComputerTargetSetting
				canConfigure={canConfigure}
				reachable={reachable}
				target={target}
			/>
		</SettingsSection>
	);
}
