import { Button } from "@ryu/ui/components/button.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import type { ShadowCaptureState } from "@/src/hooks/useShadowCapture.ts";
import type { IslandConsentPrefs } from "@/src/lib/api/preferences.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

interface IslandCaptureSectionsProps {
	consent: IslandConsentPrefs;
	shadow: ShadowCaptureState;
	writeConsent: (next: IslandConsentPrefs) => void;
}

/** Shadow capture mirror and the island's privacy & permissions consent. */
export function IslandCaptureSections({
	consent,
	shadow,
	writeConsent,
}: IslandCaptureSectionsProps) {
	return (
		<>
			<SettingsSection
				caption="What Shadow records for the island's context. Full controls live in the Shadow tab."
				title="Shadow capture"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Screen recording (frames)"
								checked={shadow.frames}
								disabled={!shadow.ready || shadow.captureApplying}
								onCheckedChange={(v) => {
									shadow.setFrames(v).catch(() => undefined);
								}}
							/>
						}
						title="Screen recording (frames)"
					/>
					<SettingsItem
						actions={
							<Switch
								aria-label="Pause all capture (incognito)"
								checked={shadow.paused}
								disabled={!shadow.ready || shadow.captureApplying}
								onCheckedChange={(v) => {
									shadow.setPaused(v).catch(() => undefined);
								}}
							/>
						}
						title="Pause all capture (incognito)"
					/>
				</SettingsGroup>
				{shadow.captureApplying ? (
					<p className="px-3 text-muted-foreground text-xs" role="status">
						Applying capture settings…
					</p>
				) : null}
				{shadow.captureReadError ? (
					<p className="px-3 text-status-destructive text-xs" role="alert">
						Could not read saved capture preferences. Capture has not been
						changed. Retry to load the saved preferences first.
					</p>
				) : null}
				{shadow.captureError ? (
					<p className="px-3 text-status-destructive text-xs" role="alert">
						Capture settings could not be applied. The selected preferences do
						not confirm that capture has changed.
					</p>
				) : null}
				{shadow.persistenceError ? (
					<p className="px-3 text-status-destructive text-xs" role="alert">
						Could not save capture preferences. An accepted capture change may
						still be active for this session, but these preferences may not
						survive a restart.
					</p>
				) : null}
				{shadow.captureReadError ||
				shadow.captureError ||
				shadow.persistenceError ? (
					<Button
						disabled={shadow.captureApplying}
						onClick={shadow.retryCaptureSettings}
						variant="outline"
					>
						Retry capture settings
					</Button>
				) : null}
			</SettingsSection>

			<SettingsSection
				caption="What the island companion is allowed to do. Screen context lets it see your active app and window; proactive suggestions read that context and then offer tips, so screen context has to be on too. Chat lets the island send and receive messages. Turning one off here turns it off on the island right away."
				title="Privacy & permissions"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Chat"
								checked={consent.chat}
								onCheckedChange={(v) => writeConsent({ ...consent, chat: v })}
							/>
						}
						description="Let the island companion send and receive chat and voice messages."
						title="Chat"
					/>
					<SettingsItem
						actions={
							<Switch
								aria-label="Screen context"
								checked={consent.contextRead === true}
								onCheckedChange={(v) =>
									writeConsent({ ...consent, contextRead: v })
								}
							/>
						}
						description="Let the island see your active app and window. Off keeps it away from anything that reads your screen."
						title="Screen context"
					/>
					<SettingsItem
						actions={
							<Switch
								aria-label="Proactive suggestions"
								checked={consent.proactive === true}
								disabled={consent.contextRead !== true}
								onCheckedChange={(v) =>
									writeConsent({ ...consent, proactive: v })
								}
							/>
						}
						description="Generate proactive suggestion chips from your context. Requires Screen context to be on."
						title="Proactive suggestions"
					/>
				</SettingsGroup>
			</SettingsSection>
		</>
	);
}
