import { Button } from "@ryu/ui/components/button.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect, useRef, useState } from "react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchGatewaySpeechSettings,
	type GatewaySpeechSettings as SpeechSettings,
	saveGatewayAnonymousSpeech,
} from "@/src/lib/api/speech-settings.ts";

export { GatewayCloudSpeechAccounts } from "./GatewaySpeechSettings-cloud-accounts.tsx";

export function GatewaySpeechSettings({
	target,
	canView,
	canConfigure,
	managed,
	onRefresh,
}: {
	canConfigure: boolean;
	canView: boolean;
	managed: boolean;
	onRefresh: () => Promise<void>;
	target: ApiTarget;
}) {
	const current = useRef(target);
	const [settings, setSettings] = useState<SpeechSettings | null>(null);
	const [enabled, setEnabled] = useState(false);
	const [translateEnabled, setTranslateEnabled] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		current.current = target;
		let active = true;
		setSettings(null);
		setEnabled(false);
		setTranslateEnabled(false);
		setBusy(false);
		setError(null);
		setSaved(false);
		if (canView) {
			fetchGatewaySpeechSettings(target)
				.then((value) => {
					if (!active) {
						return;
					}
					setSettings(value);
					setEnabled(value?.edgeTts.anonymousConsumerOptIn ?? false);
					setTranslateEnabled(
						value?.googleTranslateTts?.anonymousConsumerOptIn ?? false
					);
				})
				.catch((cause) => {
					if (active) {
						setError(
							cause instanceof Error
								? cause.message
								: "Could not load speech settings"
						);
					}
				});
		}
		return () => {
			active = false;
		};
	}, [target, canView]);

	const save = async () => {
		if (!(settings && canConfigure) || managed || busy) {
			return;
		}
		setBusy(true);
		setSaved(false);
		setError(null);
		try {
			let updated = settings;
			if (enabled !== settings.edgeTts.anonymousConsumerOptIn) {
				await saveGatewayAnonymousSpeech(
					target,
					enabled,
					updated.configRevision
				);
				const refreshed = await fetchGatewaySpeechSettings(target);
				if (!refreshed) {
					throw new Error("Speech settings are no longer available.");
				}
				updated = refreshed;
			}
			if (current.current !== target) {
				return;
			}
			if (
				updated.googleTranslateTts &&
				translateEnabled !== updated.googleTranslateTts.anonymousConsumerOptIn
			) {
				await saveGatewayAnonymousSpeech(
					target,
					translateEnabled,
					updated.configRevision,
					"google-translate-tts"
				);
				const refreshed = await fetchGatewaySpeechSettings(target);
				if (!refreshed) {
					throw new Error("Speech settings are no longer available.");
				}
				updated = refreshed;
			}
			if (current.current !== target) {
				return;
			}
			setSettings(updated);
			setSaved(true);
			await onRefresh();
		} catch (cause) {
			if (current.current !== target) {
				return;
			}
			setError(
				cause instanceof Error
					? cause.message
					: "Could not save speech settings"
			);
			try {
				const updated = await fetchGatewaySpeechSettings(target);
				if (current.current !== target) {
					return;
				}
				setSettings(updated);
				await onRefresh();
			} catch {
				// Preserve the original save explanation and the user's switch draft.
			}
		} finally {
			if (current.current === target) {
				setBusy(false);
			}
		}
	};

	if (!(canView && (settings || error))) {
		return null;
	}
	return (
		<SettingsSection
			caption="These services need no credentials. Enable each one explicitly."
			headerAction={
				<div className="flex items-center gap-1">
					<Button
						disabled={busy}
						onClick={() => {
							void fetchGatewaySpeechSettings(target)
								.then((updated) => {
									if (current.current !== target) {
										return;
									}
									setSettings(updated);
									setEnabled(updated?.edgeTts.anonymousConsumerOptIn ?? false);
									setTranslateEnabled(
										updated?.googleTranslateTts?.anonymousConsumerOptIn ?? false
									);
									setError(null);
									return onRefresh();
								})
								.catch((cause) => {
									if (current.current === target) {
										setError(
											cause instanceof Error
												? cause.message
												: "Could not refresh speech settings"
										);
									}
								});
						}}
						size="sm"
						variant="ghost"
					>
						Refresh speech settings
					</Button>
					<Button
						disabled={
							!(settings && canConfigure) ||
							managed ||
							busy ||
							(enabled === settings.edgeTts.anonymousConsumerOptIn &&
								(!settings.googleTranslateTts ||
									translateEnabled ===
										settings.googleTranslateTts.anonymousConsumerOptIn))
						}
						onClick={() => void save()}
						size="sm"
						variant="ghost"
					>
						Save speech settings
					</Button>
				</div>
			}
			title="Anonymous speech"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							aria-label="Enable anonymous Edge TTS"
							checked={enabled}
							disabled={!(settings && canConfigure) || managed || busy}
							onCheckedChange={(value) => {
								setEnabled(value);
								setSaved(false);
							}}
						/>
					}
					description="Unofficial consumer integration. Use native voice IDs with the edge-tts model."
					title="Edge TTS"
				/>
				{settings?.googleTranslateTts ? (
					<SettingsItem
						actions={
							<Switch
								aria-label="Enable anonymous Google Translate TTS"
								checked={translateEnabled}
								disabled={!canConfigure || managed || busy}
								onCheckedChange={(value) => {
									setTranslateEnabled(value);
									setSaved(false);
								}}
							/>
						}
						description="Unofficial Google Translate service. Use google-translate-tts with a language code and MP3 output. Google Cloud accounts stay separate."
						title="Google Translate TTS"
					/>
				) : null}
			</SettingsGroup>
			{error ? (
				<p className="px-3 text-sm text-status-destructive" role="alert">
					{error}
				</p>
			) : null}
			{saved ? (
				<p className="px-3 text-muted-foreground text-xs" role="status">
					Saved and applied to new requests.
				</p>
			) : null}
		</SettingsSection>
	);
}
