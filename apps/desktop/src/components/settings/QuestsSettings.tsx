// apps/desktop/src/components/settings/QuestsSettings.tsx
//
// Settings for the quests feature (the auto-detecting todo list): how aggressive
// auto-detection is, the judge model that decides whether a task looks done, its
// effort, and how often each open quest is checked. All persist via Core's
// `/api/quests/detection-config`; Core resolves the model at runtime and routes
// the judge call through the Gateway — nothing is hardcoded (blank model = the
// system default).

import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { useActiveTargetGetter } from "@/src/hooks/useActiveNode.ts";
import { ApiError } from "@/src/lib/api/client.ts";
import {
	type DetectionConfig,
	type DetectionMode,
	getDetectionConfig,
	setDetectionConfig,
} from "@/src/lib/api/quests.ts";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

const EMPTY: DetectionConfig = {
	mode: "auto_high",
	model: "",
	effort: "",
	interval: "2m",
};

// One `<integer><unit>` part, with exactly the unit spellings humantime 2.4
// accepts. The quests sidecar validates the interval with humantime and answers
// a unit it does not know with a 400, which would leave this form stuck on
// "Retry save" with the field disabled. Units are case-sensitive there: `M` is
// months, `m` is minutes, and `2H` is refused. The lookahead stops a unit from
// matching only the start of a longer word, such as `ms` inside `msecs`.
const HUMANTIME_PART =
	/^\s*\d+\s*(?:nanos|nsec|ns|usec|us|\u00b5s|millis|msec|ms|seconds|second|secs|sec|s|minutes|minute|mins|min|m|hours|hour|hrs|hr|h|days|day|d|weeks|week|wks|wk|w|months|month|M|years|year|yrs|yr|y)(?![A-Za-z\u00b5])/;

function isHumantimeDuration(value: string): boolean {
	let remaining = value.trim();
	if (!remaining) {
		return false;
	}
	while (remaining) {
		const match = HUMANTIME_PART.exec(remaining);
		if (!match) {
			return false;
		}
		remaining = remaining.slice(match[0].length).trimStart();
	}
	return true;
}

const MODE_OPTIONS: { value: DetectionMode; label: string; help: string }[] = [
	{
		value: "off",
		label: "Off",
		help: "No auto-detection. Tasks are a plain manual todo list.",
	},
	{
		value: "suggest",
		label: "Suggest",
		help: "Nudge you to confirm when a task looks done. Never auto-completes.",
	},
	{
		value: "auto_high",
		label: "Auto-complete (high confidence) — default",
		help: "Complete automatically only when very confident; otherwise suggest.",
	},
	{
		value: "auto_all",
		label: "Auto-complete (always)",
		help: "Complete automatically whenever a task is detected as done.",
	},
];

/** A change the node refused outright (a 4xx), with the node's own reason. */
interface Refusal {
	message: string;
	patch: Partial<DetectionConfig>;
}

// A 4xx means the node refused this value: sending it again cannot succeed, so
// the form stays editable instead of locking behind "Retry save". A timeout
// (408) or rate limit (429) can succeed later and keeps the retry path.
function refusalOf(
	error: unknown,
	patch: Partial<DetectionConfig>,
	tl: LiteralMessage
): Refusal | null {
	if (
		!(error instanceof ApiError) ||
		error.status < 400 ||
		error.status >= 500 ||
		error.status === 408 ||
		error.status === 429
	) {
		return null;
	}
	return {
		message:
			error.serverMessage ??
			tl("The node refused it (HTTP {status}).", {
				status: String(error.status),
			}),
		patch,
	};
}

/** The refusal left once `patch` was saved: a stored field is no longer refused. */
function withoutSaved(
	refusal: Refusal | null,
	patch: Partial<DetectionConfig>
): Refusal | null {
	if (!refusal) {
		return null;
	}
	const remaining = Object.fromEntries(
		Object.entries(refusal.patch).filter(([key]) => !(key in patch))
	) as Partial<DetectionConfig>;
	return Object.keys(remaining).length > 0
		? { ...refusal, patch: remaining }
		: null;
}

/**
 * Add a new refusal to any still-pending one. Every refused field stays in
 * `cfg` optimistically, so each must remain discardable until it is discarded
 * or saved; the node's latest reason is shown.
 */
function mergeRefusal(previous: Refusal | null, next: Refusal): Refusal {
	return previous
		? { message: next.message, patch: { ...previous.patch, ...next.patch } }
		: next;
}

export function QuestsSettings() {
	const tl = useLiteralMessages();
	const getTarget = useActiveTargetGetter();
	const [cfg, setCfg] = useState<DetectionConfig>(EMPTY);
	// What the node last confirmed it holds, so a refused change can be discarded.
	const [savedCfg, setSavedCfg] = useState<DetectionConfig>(EMPTY);
	const [refusal, setRefusal] = useState<Refusal | null>(null);
	const [interval, setIntervalText] = useState("2m");
	const [loading, setLoading] = useState(true);
	const [loadFailed, setLoadFailed] = useState(false);
	const [pendingPatch, setPendingPatch] =
		useState<Partial<DetectionConfig> | null>(null);
	const [saving, setSaving] = useState(false);
	const [saveFailed, setSaveFailed] = useState(false);
	const [intervalError, setIntervalError] = useState(false);

	const load = useCallback(async () => {
		setLoading(true);
		setLoadFailed(false);
		try {
			const value = await getDetectionConfig(getTarget());
			setCfg(value);
			setSavedCfg(value);
			setIntervalText(value.interval);
		} catch {
			setLoadFailed(true);
			toast.error("Couldn't load quest settings", {
				description:
					"Ryu couldn't reach this node. Check that it's running and try again.",
			});
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load().catch(() => undefined);
	}, [load]);

	// Read through a ref: `tl` is a new function each render, and `update`
	// must keep its identity for the callbacks that depend on it.
	const tlRef = useRef(tl);
	tlRef.current = tl;
	const update = useCallback(async (patch: Partial<DetectionConfig>) => {
		setCfg((prev) => ({ ...prev, ...patch }));
		setPendingPatch(patch);
		setSaving(true);
		setSaveFailed(false);
		try {
			await setDetectionConfig(getTarget(), patch);
			setPendingPatch(null);
			setSavedCfg((prev) => ({ ...prev, ...patch }));
			setRefusal((prev) => withoutSaved(prev, patch));
		} catch (error) {
			const refused = refusalOf(error, patch, tlRef.current);
			if (refused) {
				setPendingPatch(null);
				setRefusal((prev) => mergeRefusal(prev, refused));
			} else {
				setSaveFailed(true);
			}
		} finally {
			setSaving(false);
		}
	}, []);

	const discardRefused = useCallback(() => {
		if (!refusal) {
			return;
		}
		const restored: Partial<DetectionConfig> = {};
		for (const key of Object.keys(refusal.patch) as (keyof DetectionConfig)[]) {
			Object.assign(restored, { [key]: savedCfg[key] });
		}
		setCfg((prev) => ({ ...prev, ...restored }));
		if ("interval" in refusal.patch) {
			setIntervalText(savedCfg.interval);
			setIntervalError(false);
		}
		setRefusal(null);
	}, [refusal, savedCfg]);

	const saveInterval = useCallback(() => {
		const t = interval.trim() || "2m";
		if (!isHumantimeDuration(t)) {
			setIntervalError(true);
			return;
		}
		setIntervalError(false);
		setIntervalText(t);
		if (t !== cfg.interval) {
			void update({ interval: t });
		}
	}, [cfg.interval, interval, update]);

	const saveModel = useCallback(() => {
		const next = cfg.model.trim();
		const refusedModel =
			refusal !== null && "model" in refusal.patch
				? refusal.patch.model
				: undefined;
		if (next === refusedModel) {
			// The node refused this exact value; sending it again cannot succeed.
			setCfg((prev) => ({ ...prev, model: next }));
			return;
		}
		if (refusedModel === undefined && next === savedCfg.model) {
			// The node already holds it, so there is nothing to save.
			setCfg((prev) => ({ ...prev, model: next }));
			return;
		}
		void update({ model: next });
	}, [cfg.model, refusal, savedCfg.model, update]);

	const activeMode = MODE_OPTIONS.find((m) => m.value === cfg.mode);
	const intervalRefused = refusal !== null && "interval" in refusal.patch;
	let intervalDescribedBy: string | undefined;
	if (intervalError) {
		intervalDescribedBy = "quest-interval-error";
	} else if (intervalRefused) {
		intervalDescribedBy = "quest-refusal";
	}

	if (loadFailed) {
		return (
			<SettingsCard className="space-y-3">
				<p className="font-medium text-sm">Couldn't load quest settings</p>
				<p className="text-muted-foreground text-xs">
					Ryu couldn't reach this node. Check that it's running, then try again.
				</p>
				<Button
					disabled={loading}
					onClick={() => {
						load().catch(() => undefined);
					}}
					size="sm"
					variant="ghost"
				>
					{loading ? "Retrying…" : "Retry"}
				</Button>
			</SettingsCard>
		);
	}

	return (
		<div className="space-y-6">
			<SettingsSection
				caption="Ryu can watch what you are doing (via Shadow's on-device context) and detect when a quest is finished. Choose how it acts when it thinks a task is done. Detection only runs while Shadow capture is enabled."
				title="Auto-detection"
			>
				<SettingsCard className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="quest-mode">Detection mode</Label>
						<Select<DetectionMode>
							disabled={saving || saveFailed}
							items={MODE_OPTIONS}
							onValueChange={(v) => {
								if (v) {
									void update({ mode: v });
								}
							}}
							value={cfg.mode}
						>
							<SelectTrigger className="h-9 w-full" id="quest-mode">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{MODE_OPTIONS.map((m) => (
									<SelectItem key={m.value} value={m.value}>
										{m.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{activeMode ? (
							<p className="text-muted-foreground text-xs">{activeMode.help}</p>
						) : null}
					</div>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="The model that reads your recent activity and judges whether a task is done. Leave blank to use the system default (the bundled local model). It runs through the Gateway like any other model call."
				title="Judge model"
			>
				<SettingsCard className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="quest-model">Model</Label>
						<Input
							disabled={saving || saveFailed}
							id="quest-model"
							onBlur={saveModel}
							onChange={(e) => setCfg((p) => ({ ...p, model: e.target.value }))}
							placeholder="Using the system default…"
							value={cfg.model}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="quest-effort">Reasoning effort</Label>
						<Select
							disabled={saving || saveFailed}
							items={{
								default: "Provider default",
								high: "High",
								low: "Low",
								medium: "Medium",
							}}
							onValueChange={(v) => {
								if (v) {
									void update({ effort: v === "default" ? "" : v });
								}
							}}
							value={cfg.effort || "default"}
						>
							<SelectTrigger
								className="h-9 w-full"
								disabled={saving || saveFailed}
								id="quest-effort"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="default">Provider default</SelectItem>
								<SelectItem value="low">Low</SelectItem>
								<SelectItem value="medium">Medium</SelectItem>
								<SelectItem value="high">High</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="quest-interval">Check interval</Label>
						<Input
							aria-describedby={intervalDescribedBy}
							aria-invalid={intervalError || intervalRefused}
							disabled={saving || saveFailed}
							id="quest-interval"
							onBlur={saveInterval}
							onChange={(e) => {
								setIntervalError(false);
								setIntervalText(e.target.value);
							}}
							placeholder="2m"
							value={interval}
						/>
						{intervalError ? (
							<p
								className="text-status-destructive text-xs"
								id="quest-interval-error"
								role="alert"
							>
								Enter a valid duration such as 30s, 2m, or 1h.
							</p>
						) : null}
						<p className="text-muted-foreground text-xs">
							How often each open quest is checked (e.g. 30s, 2m, 10m).
						</p>
					</div>
				</SettingsCard>
			</SettingsSection>
			{refusal ? (
				<div
					className="flex items-center justify-between gap-3 px-3"
					role="alert"
				>
					<p className="text-sm text-status-destructive" id="quest-refusal">
						{tl("The node refused this change: {message}", {
							message: refusal.message,
						})}
					</p>
					<Button onClick={discardRefused} size="sm" variant="ghost">
						Discard change
					</Button>
				</div>
			) : null}
			{saveFailed && pendingPatch ? (
				<div
					className="flex items-center justify-between gap-3 px-3"
					role="alert"
				>
					<p className="text-sm text-status-destructive">
						Couldn't save quest settings. Your change is still here.
					</p>
					<Button
						disabled={saving}
						onClick={() => {
							void update(pendingPatch);
						}}
						size="sm"
						variant="ghost"
					>
						Retry save
					</Button>
				</div>
			) : null}
		</div>
	);
}
