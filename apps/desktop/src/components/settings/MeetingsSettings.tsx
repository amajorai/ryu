// apps/desktop/src/components/settings/MeetingsSettings.tsx
//
// Settings for the meeting-notes feature: which model turns a transcript into
// notes (+ at what effort), the prompt it uses, and the automatic-detection
// policy (whether to prompt when a meeting app grabs the mic, and which apps
// count). Model/effort/prompt persist under the `meeting-notes-*` preference
// keys; detection persists via `/api/meetings/detection-config`. Core resolves
// all of these at runtime and routes the note-gen call through the Gateway —
// nothing is hardcoded (blank model = system default, blank prompt = built-in).

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
import { Switch } from "@ryu/ui/components/switch";
import { Textarea } from "@ryu/ui/components/textarea";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type ApiTarget, toTarget } from "@/src/lib/api/client.ts";
import {
	type DetectionConfig,
	getDetectionConfig,
	listMeetingTemplates,
	type MeetingTemplate,
	setDetectionConfig,
} from "@/src/lib/api/meetings.ts";
import {
	getMeetingDiarizationEnabled,
	getMeetingNotesConfig,
	getMeetingNotesPrompt,
	getMeetingNotesTemplate,
	type SideModelConfig,
	setMeetingDiarizationEnabled,
	setMeetingNotesConfig,
	setMeetingNotesPrompt,
	setMeetingNotesTemplate,
} from "@/src/lib/api/preferences.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { SideModelPicker } from "./shared/SideModelPicker.tsx";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

const EMPTY_MODEL: SideModelConfig = { provider: "", model: "", effort: "" };
const EMPTY_DETECTION: DetectionConfig = { enabled: true, apps: [] };

function activeTarget(): ApiTarget {
	return toTarget(useNodeStore.getState().getActiveNode());
}

export function MeetingsSettings() {
	const [cfg, setCfg] = useState<SideModelConfig>(EMPTY_MODEL);
	const [prompt, setPrompt] = useState("");
	const [detection, setDetection] = useState<DetectionConfig>(EMPTY_DETECTION);
	const [appsText, setAppsText] = useState("");
	const [templates, setTemplates] = useState<MeetingTemplate[]>([]);
	const [templateId, setTemplateId] = useState("default");
	const [diarization, setDiarization] = useState(false);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState(false);
	const [_reloadKey, setReloadKey] = useState(0);

	useEffect(() => {
		let cancelled = false;
		const target = activeTarget();
		setLoading(true);
		setLoadError(false);
		Promise.all([
			getMeetingNotesConfig(target),
			getMeetingNotesPrompt(target),
			getDetectionConfig(target),
			listMeetingTemplates(target),
			getMeetingNotesTemplate(target),
			getMeetingDiarizationEnabled(target),
		])
			.then(
				([
					modelValue,
					promptValue,
					detectionValue,
					templateList,
					selectedTemplate,
					diarizationValue,
				]) => {
					if (cancelled) {
						return;
					}
					setCfg(modelValue);
					setPrompt(promptValue);
					setDetection(detectionValue);
					setAppsText(detectionValue.apps.join(", "));
					setTemplates(templateList);
					setTemplateId(selectedTemplate || "default");
					setDiarization(diarizationValue);
					setLoading(false);
				}
			)
			.catch(() => {
				if (!cancelled) {
					setLoadError(true);
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const templateOptions = useMemo(
		() => templates.map((t) => ({ value: t.id, label: t.name })),
		[templates]
	);

	const updateTemplate = useCallback(async (next: string) => {
		let previous = "default";
		setTemplateId((prev) => {
			previous = prev;
			return next;
		});
		try {
			await setMeetingNotesTemplate(activeTarget(), next);
		} catch {
			setTemplateId(previous);
			toast.error("Couldn't save the notes template");
		}
	}, []);

	const updateDiarization = useCallback(async (next: boolean) => {
		setDiarization(next);
		try {
			await setMeetingDiarizationEnabled(activeTarget(), next);
		} catch {
			setDiarization(!next);
			toast.error("Couldn't save the diarization setting");
		}
	}, []);

	const updateModel = useCallback(async (next: SideModelConfig) => {
		let previous: SideModelConfig = EMPTY_MODEL;
		setCfg((prev) => {
			previous = prev;
			return next;
		});
		try {
			await setMeetingNotesConfig(activeTarget(), next);
		} catch {
			setCfg(previous);
			toast.error("Couldn't save the notes model", {
				description: "Check your connection and try again.",
			});
		}
	}, []);

	const savePrompt = useCallback(async () => {
		try {
			await setMeetingNotesPrompt(activeTarget(), prompt);
			toast.success("Notes prompt saved");
		} catch {
			toast.error("Couldn't save the notes prompt", {
				description: "Check your connection and try again.",
			});
		}
	}, [prompt]);

	const updateDetection = useCallback(
		async (patch: Partial<DetectionConfig>) => {
			let previous: DetectionConfig = EMPTY_DETECTION;
			setDetection((prev) => {
				previous = prev;
				return { ...prev, ...patch };
			});
			try {
				await setDetectionConfig(activeTarget(), patch);
			} catch {
				setDetection(previous);
				toast.error("Couldn't save your detection settings", {
					description: "Check your connection and try again.",
				});
			}
		},
		[]
	);

	const saveApps = useCallback(async () => {
		const apps = appsText
			.split(",")
			.map((a) => a.trim())
			.filter(Boolean);
		setAppsText(apps.join(", "));
		await updateDetection({ apps });
	}, [appsText, updateDetection]);

	if (loading) {
		return (
			<div className="space-y-6">
				<p className="text-muted-foreground text-sm">
					Loading your meeting settings…
				</p>
			</div>
		);
	}

	if (loadError) {
		return (
			<div className="space-y-3">
				<p className="text-muted-foreground text-sm">
					We couldn't load your meeting settings. Check your connection and try
					again.
				</p>
				<Button
					onClick={() => setReloadKey((k) => k + 1)}
					size="sm"
					variant="outline"
				>
					Retry
				</Button>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<SettingsSection
				caption="When a meeting ends, this model turns the transcript into notes (summary, key points, action items, decisions) and saves them to your Meetings space. It runs through the Gateway like any other model call; leave the model blank to use the system default."
				title="Notes model"
			>
				<SettingsCard>
					<SideModelPicker
						onChange={updateModel}
						target={activeTarget()}
						value={cfg}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="Customize how notes are written. Leave blank to use the built-in prompt."
				title="Notes prompt"
			>
				<SettingsCard>
					<Textarea
						className="min-h-32 font-mono text-xs"
						onBlur={savePrompt}
						onChange={(e) => setPrompt(e.target.value)}
						placeholder="Using the built-in default prompt…"
						value={prompt}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="Templates steer what the notes emphasize (a standup vs. a sales call vs. an interview) without changing their shape. A custom prompt above, if set, overrides the template."
				title="Notes template"
			>
				<SettingsCard>
					<Select
						items={templateOptions}
						onValueChange={updateTemplate}
						value={templateId}
					>
						<SelectTrigger
							aria-label="Notes template"
							className="h-8 w-56 text-sm"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{templateOptions.map((opt) => (
								<SelectItem key={opt.value} value={opt.value}>
									{opt.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="Label who said what in the transcript. Diarization runs on the recording after a meeting ends, using a local model (the Ryu diarize sidecar, pyannote). It's off by default — the model is large and gated; enable it and install the sidecar to use it. Your microphone side is always labeled “Me”."
				title="Speaker labels"
			>
				<SettingsCard>
					<div className="flex items-center justify-between gap-4">
						<div>
							<p className="font-medium text-sm">Identify speakers</p>
							<p className="text-muted-foreground text-xs">
								Split the transcript by speaker when a meeting is finalized.
							</p>
						</div>
						<Switch
							aria-label="Identify speakers"
							checked={diarization}
							onCheckedChange={(v) => {
								Promise.resolve(updateDiarization(Boolean(v))).catch(
									() => undefined
								);
							}}
						/>
					</div>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="Ryu notices when a meeting app starts using your microphone (e.g. Zoom, Teams) and offers to take notes — it does not listen to your mic to detect. Choose whether to prompt, and which apps count as a meeting."
				title="Automatic detection"
			>
				<SettingsCard className="space-y-4">
					<div className="flex items-center justify-between gap-4">
						<div>
							<p className="font-medium text-sm">Auto-detect meetings</p>
							<p className="text-muted-foreground text-xs">
								Prompt to take notes when a meeting app starts.
							</p>
						</div>
						<Switch
							aria-label="Auto-detect meetings"
							checked={detection.enabled}
							onCheckedChange={(v) => {
								Promise.resolve(updateDetection({ enabled: Boolean(v) })).catch(
									() => undefined
								);
							}}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="meeting-apps">Meeting apps</Label>
						<Input
							id="meeting-apps"
							onBlur={saveApps}
							onChange={(e) => setAppsText(e.target.value)}
							placeholder="zoom, teams, meet, slack, discord"
							value={appsText}
						/>
						<p className="text-muted-foreground text-xs">
							Comma-separated app names. An app using your mic counts as a
							meeting when its name contains one of these.
						</p>
					</div>
				</SettingsCard>
			</SettingsSection>
		</div>
	);
}
