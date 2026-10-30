import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Alert,
	AlertDescription,
	AlertTitle,
} from "@ryu/ui/components/alert.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useEffect, useMemo, useState } from "react";
import { useShadowCapture } from "@/src/hooks/useShadowCapture.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	isLocalNode,
	LOCAL_FALLBACK,
	useNodeStore,
} from "@/src/store/useNodeStore.ts";
import { ShadowComputerUseSection } from "./ShadowSettings-computer-use-section.tsx";
import { useShadowComputerUseState } from "./ShadowSettings-computer-use-state.ts";
import { MAX_HISTORY_RETENTION_DAYS } from "./ShadowSettings-constants.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/**
 * Shadow settings tab. Shadow is the local screen-context sidecar (active window,
 * OCR, clipboard/git/terminal events, and — when enabled — screen-frame
 * keyframes that the Timeline scrubber shows). Capture controls stay device-local;
 * the optional Jev planner sends its bounded UI state to the configured HTTPS
 * provider. Settings persist in Shadow, and the Jev key uses Core's encrypted
 * plugin-secret store.
 */
export function ShadowSettings() {
	const localNode = useNodeStore(
		(state) => state.nodes.find(isLocalNode) ?? LOCAL_FALLBACK
	);
	const localTarget = useMemo(() => toTarget(localNode), [localNode]);
	const tl = useLiteralMessages();
	const {
		allowlist,
		captureApplying,
		captureError,
		captureReadError,
		persistenceError,
		retryCaptureSettings,
		frames,
		historyRetentionDays,
		paused,
		ready,
		setAllowlist,
		setFrames,
		setHistoryRetentionDays,
		setPaused,
		refreshShadow,
	} = useShadowCapture();
	const computerUseState = useShadowComputerUseState(
		localTarget,
		refreshShadow
	);

	const [allowlistRaw, setAllowlistRaw] = useState("");
	const [historyRetentionRaw, setHistoryRetentionRaw] = useState("30");

	useEffect(() => {
		if (ready) {
			setAllowlistRaw(allowlist.join(", "));
		}
	}, [ready, allowlist]);

	useEffect(() => {
		if (ready) {
			setHistoryRetentionRaw(String(historyRetentionDays));
		}
	}, [ready, historyRetentionDays]);

	const commitAllowlist = () => {
		const parsed = allowlistRaw
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		setAllowlist(parsed).catch(() => undefined);
	};

	const commitHistoryRetention = () => {
		const parsed = Number.parseInt(historyRetentionRaw, 10);
		const days = Number.isFinite(parsed) ? parsed : historyRetentionDays;
		// Show the window being applied even when it equals the current one, so a
		// clamped or emptied entry never keeps text Shadow did not accept.
		setHistoryRetentionRaw(
			String(Math.max(1, Math.min(MAX_HISTORY_RETENTION_DAYS, days)))
		);
		setHistoryRetentionDays(days).catch(() => undefined);
	};

	if (!(ready || captureReadError)) {
		return (
			<div className="animate-skeleton text-muted-foreground text-xs">
				Loading Shadow settings…
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<SettingsSection
				caption="Shadow captures your screen context locally to power the Timeline, search, and proactive suggestions. Nothing leaves your machine."
				title="Capture"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={frames}
								disabled={!ready || captureApplying}
								onCheckedChange={(v) => {
									setFrames(v).catch(() => undefined);
								}}
							/>
						}
						description="Save periodic screenshots so the Timeline can show what was on screen at any moment. On by default. Turning this off keeps the rest of capture (on-screen text, clipboard, and code activity) running."
						title="Screen recording"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={paused}
								disabled={!ready || captureApplying}
								onCheckedChange={(v) => {
									setPaused(v).catch(() => undefined);
								}}
							/>
						}
						description="Request incognito mode. When Shadow accepts the pause, it stops recording frames, text, and events until capture is resumed."
						title="Pause all capture"
					/>
					<SettingsItem
						actions={
							<div className="flex items-center gap-2">
								<Input
									aria-label="Shadow history retention in days"
									className="h-8 w-24"
									disabled={!ready || captureApplying}
									inputMode="numeric"
									max={MAX_HISTORY_RETENTION_DAYS}
									min={1}
									onBlur={commitHistoryRetention}
									onChange={(e) => setHistoryRetentionRaw(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											commitHistoryRetention();
										}
									}}
									type="number"
									value={historyRetentionRaw}
								/>
								<span className="text-muted-foreground text-xs">days</span>
							</div>
						}
						description="Delete captured Timeline and search history after this many days: activity, screen frames, recordings, screen text and transcripts. Shadow checks hourly and right after you change this. Saved clips, meeting summaries and learned memory are not affected."
						title="Keep history"
					/>
				</SettingsGroup>
			</SettingsSection>

			<ShadowComputerUseSection state={computerUseState} />

			<SettingsSection
				caption={
					<>
						{tl(
							"Comma-separated app names. Leave empty to capture everything; add entries to capture only those apps."
						)}
						{allowlist.length > 0 && (
							<span className="ml-1 font-medium text-foreground">
								{tl("Selected ({count, plural, one {# app} other {# apps}}).", {
									count: allowlist.length,
								})}
							</span>
						)}
					</>
				}
				title="App allowlist"
			>
				<SettingsCard className="flex gap-2">
					<Input
						aria-label="App allowlist, comma-separated app names"
						className="flex-1"
						disabled={!ready || captureApplying}
						onBlur={commitAllowlist}
						onChange={(e) => setAllowlistRaw(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								commitAllowlist();
							}
						}}
						placeholder="e.g. VSCode, Terminal, Chrome"
						value={allowlistRaw}
					/>
					<Button
						disabled={!ready || captureApplying}
						onClick={commitAllowlist}
						variant="ghost"
					>
						Apply
					</Button>
				</SettingsCard>
			</SettingsSection>

			{captureApplying ? (
				<p className="px-3 text-muted-foreground text-xs" role="status">
					Applying capture settings…
				</p>
			) : null}
			{captureReadError ? (
				<Alert variant="destructive">
					<AlertTitle>Could not read saved capture preferences</AlertTitle>
					<AlertDescription>
						Capture has not been changed because the saved preferences could not
						be loaded. Retry to read them before applying a change.
					</AlertDescription>
				</Alert>
			) : null}
			{captureError ? (
				<Alert variant="destructive">
					<AlertTitle>Capture settings could not be applied</AlertTitle>
					<AlertDescription>
						The selected preferences do not confirm that capture has changed.
						Check that Shadow is available, then retry.
					</AlertDescription>
				</Alert>
			) : null}
			{persistenceError ? (
				<Alert variant="destructive">
					<AlertTitle>Could not save capture preferences</AlertTitle>
					<AlertDescription>
						These preferences may not survive a restart. An accepted capture
						change can still be active for this session.
					</AlertDescription>
				</Alert>
			) : null}
			{captureReadError || captureError || persistenceError ? (
				<Button
					disabled={captureApplying}
					onClick={retryCaptureSettings}
					variant="outline"
				>
					Retry capture settings
				</Button>
			) : null}
		</div>
	);
}
