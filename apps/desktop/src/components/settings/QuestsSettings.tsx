// apps/desktop/src/components/settings/QuestsSettings.tsx
//
// Settings for the quests feature (the auto-detecting todo list): how aggressive
// auto-detection is, the judge model that decides whether a task looks done, its
// effort, and how often each open quest is checked. All persist via Core's
// `/api/quests/detection-config`; Core resolves the model at runtime and routes
// the judge call through the Gateway — nothing is hardcoded (blank model = the
// system default).

import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { toast } from "@ryu/ui/components/sileo";
import { useCallback, useEffect, useState } from "react";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	type DetectionConfig,
	type DetectionMode,
	getDetectionConfig,
	setDetectionConfig,
} from "@/src/lib/api/quests.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

const EMPTY: DetectionConfig = {
	mode: "auto_high",
	model: "",
	effort: "",
	interval: "2m",
};

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

function activeTarget(): ApiTarget {
	return toTarget(useNodeStore.getState().getActiveNode());
}

export function QuestsSettings() {
	const [cfg, setCfg] = useState<DetectionConfig>(EMPTY);
	const [interval, setIntervalText] = useState("2m");
	const [loading, setLoading] = useState(true);
	const [loadFailed, setLoadFailed] = useState(false);

	const load = useCallback(async () => {
		setLoading(true);
		setLoadFailed(false);
		try {
			const value = await getDetectionConfig(activeTarget());
			setCfg(value);
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

	const update = useCallback((patch: Partial<DetectionConfig>) => {
		setCfg((prev) => ({ ...prev, ...patch }));
		setDetectionConfig(activeTarget(), patch).catch(() => undefined);
	}, []);

	const saveInterval = useCallback(() => {
		const t = interval.trim() || "2m";
		update({ interval: t });
		setIntervalText(t);
	}, [interval, update]);

	const activeMode = MODE_OPTIONS.find((m) => m.value === cfg.mode);

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
					variant="outline"
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
						<Select
							items={MODE_OPTIONS}
							onValueChange={(v) => update({ mode: v as DetectionMode })}
							value={cfg.mode}
						>
							<SelectTrigger className="h-9 w-full text-sm" id="quest-mode">
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
							id="quest-model"
							onBlur={() => update({ model: cfg.model.trim() })}
							onChange={(e) => setCfg((p) => ({ ...p, model: e.target.value }))}
							placeholder="Using the system default…"
							value={cfg.model}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="quest-effort">Reasoning effort</Label>
						<Select
							items={{
								default: "Provider default",
								high: "High",
								low: "Low",
								medium: "Medium",
							}}
							onValueChange={(v) =>
								update({ effort: v && v !== "default" ? v : "" })
							}
							value={cfg.effort || "default"}
						>
							<SelectTrigger className="h-9 w-full text-sm" id="quest-effort">
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
							id="quest-interval"
							onBlur={saveInterval}
							onChange={(e) => setIntervalText(e.target.value)}
							placeholder="2m"
							value={interval}
						/>
						<p className="text-muted-foreground text-xs">
							How often each open quest is checked (e.g. 30s, 2m, 10m).
						</p>
					</div>
				</SettingsCard>
			</SettingsSection>
		</div>
	);
}
