import { type StatsPreferences, statsPreferenceFields } from "./stats-model.ts";

export function StatsPreferencesPanel({
	preferences,
	setPreferences,
}: {
	preferences: StatsPreferences;
	setPreferences: (next: Partial<StatsPreferences>) => void;
}) {
	return (
		<div className="mt-3 border-border border-t pt-3 text-xs">
			<div className="mb-2 font-medium text-foreground">Stats settings</div>
			<div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2">
				<label htmlFor="stats-cache-scope">Cache totals</label>
				<select
					className="rounded-lg border border-border bg-background px-1.5 py-1 text-xs"
					id="stats-cache-scope"
					onChange={(event) =>
						setPreferences({
							cacheScope: statsPreferenceFields.cacheScope.parse(
								event.target.value
							),
						})
					}
					value={preferences.cacheScope}
				>
					<option value="latest">Latest turn</option>
					<option value="session">Cumulative session</option>
				</select>
				<label htmlFor="stats-cache-ttl">Cache timer TTL</label>
				<select
					className="rounded-lg border border-border bg-background px-1.5 py-1 text-xs"
					id="stats-cache-ttl"
					onChange={(event) =>
						setPreferences({
							cacheTimerTtlMinutes:
								statsPreferenceFields.cacheTimerTtlMinutes.parse(
									Number(event.target.value)
								),
						})
					}
					value={preferences.cacheTimerTtlMinutes}
				>
					<option value="5">5 minutes</option>
					<option value="60">1 hour</option>
				</select>
				<label htmlFor="stats-rolling-window">Speed rolling window</label>
				<select
					className="rounded-lg border border-border bg-background px-1.5 py-1 text-xs"
					id="stats-rolling-window"
					onChange={(event) =>
						setPreferences({ rollingWindowSeconds: Number(event.target.value) })
					}
					value={preferences.rollingWindowSeconds}
				>
					<option value="0">Full session</option>
					<option value="5">5 seconds</option>
					<option value="15">15 seconds</option>
					<option value="30">30 seconds</option>
					<option value="60">1 minute</option>
					<option value="120">2 minutes</option>
				</select>
				<label htmlFor="stats-compaction-value">Compaction value</label>
				<select
					className="rounded-lg border border-border bg-background px-1.5 py-1 text-xs"
					id="stats-compaction-value"
					onChange={(event) =>
						setPreferences({
							compactionValue: statsPreferenceFields.compactionValue.parse(
								event.target.value
							),
						})
					}
					value={preferences.compactionValue}
				>
					<option value="total">Total count</option>
					<option value="auto">Auto count</option>
					<option value="manual">Manual count</option>
					<option value="unknown">Unknown count</option>
					<option value="reclaimed">Tokens reclaimed</option>
				</select>
				<label
					className="col-span-2 flex items-center gap-2"
					htmlFor="stats-compaction-triggers"
				>
					<input
						checked={preferences.compactionShowTriggers}
						id="stats-compaction-triggers"
						onChange={(event) =>
							setPreferences({ compactionShowTriggers: event.target.checked })
						}
						type="checkbox"
					/>
					Show compaction trigger split
				</label>
				<label
					className="col-span-2 flex items-center gap-2"
					htmlFor="stats-compaction-reclaimed"
				>
					<input
						checked={preferences.compactionShowReclaimed}
						id="stats-compaction-reclaimed"
						onChange={(event) =>
							setPreferences({ compactionShowReclaimed: event.target.checked })
						}
						type="checkbox"
					/>
					Show reclaimed tokens
				</label>
				<label htmlFor="stats-usage-percent-mode">Usage percentage</label>
				<select
					className="rounded-lg border border-border bg-background px-1.5 py-1 text-xs"
					id="stats-usage-percent-mode"
					onChange={(event) =>
						setPreferences({
							usagePercentMode: statsPreferenceFields.usagePercentMode.parse(
								event.target.value
							),
						})
					}
					value={preferences.usagePercentMode}
				>
					<option value="used">Used percentage</option>
					<option value="remaining">Remaining percentage</option>
				</select>
				<label htmlFor="stats-reset-timer-mode">Reset timer display</label>
				<select
					className="rounded-lg border border-border bg-background px-1.5 py-1 text-xs"
					id="stats-reset-timer-mode"
					onChange={(event) =>
						setPreferences({
							resetTimerMode: statsPreferenceFields.resetTimerMode.parse(
								event.target.value
							),
						})
					}
					value={preferences.resetTimerMode}
				>
					<option value="remaining">Remaining time</option>
					<option value="progress">Progress</option>
					<option value="exact">Exact date/time</option>
				</select>
				<label htmlFor="stats-reset-timezone">Reset timezone</label>
				<select
					className="rounded-lg border border-border bg-background px-1.5 py-1 text-xs"
					id="stats-reset-timezone"
					onChange={(event) =>
						setPreferences({
							resetTimerTimezone:
								statsPreferenceFields.resetTimerTimezone.parse(
									event.target.value
								),
						})
					}
					value={preferences.resetTimerTimezone}
				>
					<option value="local">Local time</option>
					<option value="utc">UTC</option>
				</select>
				<label htmlFor="stats-reset-locale">Reset locale</label>
				<input
					className="w-24 rounded-lg border border-border bg-background px-1.5 py-1 text-xs"
					id="stats-reset-locale"
					maxLength={24}
					onChange={(event) =>
						setPreferences({ resetTimerLocale: event.target.value || "system" })
					}
					placeholder="system"
					value={
						preferences.resetTimerLocale === "system"
							? ""
							: preferences.resetTimerLocale
					}
				/>
				<label htmlFor="stats-cache-hot-glyph">Cache hot glyph</label>
				<input
					className="w-14 rounded-lg border border-border bg-background px-1.5 py-1 text-center text-xs"
					id="stats-cache-hot-glyph"
					maxLength={4}
					onChange={(event) =>
						setPreferences({ cacheHotGlyph: event.target.value })
					}
					value={preferences.cacheHotGlyph}
				/>
				<label htmlFor="stats-cache-countdown-glyph">
					Cache countdown glyph
				</label>
				<input
					className="w-14 rounded-lg border border-border bg-background px-1.5 py-1 text-center text-xs"
					id="stats-cache-countdown-glyph"
					maxLength={4}
					onChange={(event) =>
						setPreferences({ cacheCountdownGlyph: event.target.value })
					}
					value={preferences.cacheCountdownGlyph}
				/>
				<label htmlFor="stats-cache-cold-glyph">Cache cold glyph</label>
				<input
					className="w-14 rounded-lg border border-border bg-background px-1.5 py-1 text-center text-xs"
					id="stats-cache-cold-glyph"
					maxLength={4}
					onChange={(event) =>
						setPreferences({ cacheColdGlyph: event.target.value })
					}
					value={preferences.cacheColdGlyph}
				/>
			</div>
			<label
				className="mt-3 flex items-center gap-2"
				htmlFor="stats-hide-empty"
			>
				<input
					checked={preferences.hideEmpty}
					id="stats-hide-empty"
					onChange={(event) =>
						setPreferences({ hideEmpty: event.target.checked })
					}
					type="checkbox"
				/>
				Hide unavailable or empty metrics
			</label>
			<label
				className="mt-2 flex items-center gap-2"
				htmlFor="stats-usage-time-cursor"
			>
				<input
					checked={preferences.usageShowTimeCursor}
					id="stats-usage-time-cursor"
					onChange={(event) =>
						setPreferences({ usageShowTimeCursor: event.target.checked })
					}
					type="checkbox"
				/>
				Show usage-window time cursor
			</label>
			<label
				className="mt-2 flex items-center gap-2"
				htmlFor="stats-cache-timer"
			>
				<input
					checked={preferences.showCacheTimer}
					id="stats-cache-timer"
					onChange={(event) =>
						setPreferences({ showCacheTimer: event.target.checked })
					}
					type="checkbox"
				/>
				Show cache timer when an anchor is available
			</label>
		</div>
	);
}
