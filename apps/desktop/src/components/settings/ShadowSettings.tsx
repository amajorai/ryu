import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Switch } from "@ryu/ui/components/switch";
import { useEffect, useState } from "react";
import { useShadowCapture } from "@/src/hooks/useShadowCapture.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/**
 * Shadow settings tab. Shadow is the local screen-context sidecar (active window,
 * OCR, clipboard/git/terminal events, and — when enabled — screen-frame
 * keyframes that the Timeline scrubber shows). Everything here is local; no
 * telemetry. Controls write straight through to the running Shadow sidecar and
 * are persisted so they survive a Shadow restart.
 */
export function ShadowSettings() {
	const {
		allowlist,
		frames,
		historyRetentionDays,
		paused,
		ready,
		setAllowlist,
		setFrames,
		setHistoryRetentionDays,
		setPaused,
		shadowReachable,
	} = useShadowCapture();

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
		setHistoryRetentionDays(days).catch(() => undefined);
	};

	if (!ready) {
		return (
			<div className="animate-pulse text-muted-foreground text-xs">
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
								onCheckedChange={(v) => {
									setPaused(v).catch(() => undefined);
								}}
							/>
						}
						description="Incognito mode — Shadow records nothing at all (no frames, no text, no events) until you turn this back off."
						title="Pause all capture"
					/>
					<SettingsItem
						actions={
							<div className="flex items-center gap-2">
								<Input
									aria-label="Shadow history retention in days"
									className="h-8 w-24"
									inputMode="numeric"
									max={3650}
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
						description="Delete captured Timeline and search history after this many days. Full screen frames are kept for up to 7 days, then compact keyframes remain until the history window expires."
						title="Keep history"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption={
					<>
						Comma-separated app names. Leave empty to capture everything; add
						entries to capture only those apps.
						{allowlist.length > 0 && (
							<span className="ml-1 font-medium text-foreground">
								Active ({allowlist.length} app
								{allowlist.length === 1 ? "" : "s"}).
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
					<Button onClick={commitAllowlist} variant="outline">
						Apply
					</Button>
				</SettingsCard>
			</SettingsSection>

			{shadowReachable === false && (
				<p className="px-3 text-muted-foreground text-xs">
					Shadow is not running — these settings are saved and will apply when
					it starts.
				</p>
			)}
		</div>
	);
}
