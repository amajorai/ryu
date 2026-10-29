import {
	Alert,
	AlertDescription,
	AlertTitle,
} from "@ryu/ui/components/alert.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { useShadowCapture } from "@/src/hooks/useShadowCapture.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	clearPluginSecret,
	listPluginSecrets,
	setPluginSecret,
} from "@/src/lib/api/plugin-secrets.ts";
import {
	getShadowComputerUseConfigStrict,
	type ShadowComputerUseConfigUpdate,
	setShadowComputerUseConfig,
} from "@/src/lib/api/shadow.ts";
import { startSidecar, stopSidecar } from "@/src/lib/services-api.ts";
import {
	isLocalNode,
	LOCAL_FALLBACK,
	useNodeStore,
} from "@/src/store/useNodeStore.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

const SHADOW_PLUGIN_ID = "@ryu/shadow";
const MAX_HISTORY_RETENTION_DAYS = 3650;
const JEV_SECRET_KEY = "SHADOW_JEV_API_KEY";
const PLANNER_OPTION_SEPARATOR = ":";

function plannerOptionValue(pluginId: string, contributionId: string) {
	return `${pluginId}${PLANNER_OPTION_SEPARATOR}${contributionId}`;
}

const COMPUTER_USE_DEFAULTS: ShadowComputerUseConfigUpdate = {
	planner: "native",
	jevUrl: "https://api.typesafe.ai/v1/systemone",
	jevModel: "jev-latest",
	layaUrl: "",
	localPluginId: "",
	localModelId: "",
	maxSteps: 12,
};

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
	const { computer_use_planners: computerUsePlanners } =
		usePluginContributions(localTarget);
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
	const [computerUse, setComputerUse] = useState<ShadowComputerUseConfigUpdate>(
		() => ({
			...COMPUTER_USE_DEFAULTS,
			layaUrl: `${localTarget.url}/api/ext/@ryu/laya/predict`,
		})
	);
	const [computerUseLoaded, setComputerUseLoaded] = useState(false);
	const [computerUseLoadFailed, setComputerUseLoadFailed] = useState(false);
	const [jevSecretLoaded, setJevSecretLoaded] = useState(false);
	const [jevSecretLoadFailed, setJevSecretLoadFailed] = useState(false);
	const computerUseLoadEpoch = useRef(0);
	const computerUseWriteInFlight = useRef(false);
	const [jevApiKeyConfigured, setJevApiKeyConfigured] = useState(false);
	const [jevSecretSet, setJevSecretSet] = useState(false);
	const [jevSecretShadowed, setJevSecretShadowed] = useState(false);
	const [jevKeyDraft, setJevKeyDraft] = useState("");
	const [computerUseBusy, setComputerUseBusy] = useState(false);
	const [computerUseError, setComputerUseError] = useState<string | null>(null);
	const [computerUseReadError, setComputerUseReadError] = useState<
		string | null
	>(null);
	const [computerUseNotice, setComputerUseNotice] = useState<string | null>(
		null
	);
	const selectedLocalPlanner = computerUsePlanners.find(
		(planner) =>
			planner.plugin === computerUse.localPluginId &&
			planner.model_id === computerUse.localModelId
	);
	const localPlannerSelectValue = selectedLocalPlanner
		? plannerOptionValue(selectedLocalPlanner.plugin, selectedLocalPlanner.id)
		: computerUse.localPluginId && computerUse.localModelId
			? plannerOptionValue(computerUse.localPluginId, computerUse.localModelId)
			: "";
	// One list feeds both the options and the closed trigger's label; without
	// `items` the trigger would show the internal `plugin:model` value.
	const localPlannerItems = computerUsePlanners.map((planner) => ({
		value: plannerOptionValue(planner.plugin, planner.id),
		label: `${planner.label} · ${planner.plugin}`,
	}));
	if (!selectedLocalPlanner && localPlannerSelectValue) {
		localPlannerItems.push({
			value: localPlannerSelectValue,
			label: `Unavailable model · ${computerUse.localPluginId}`,
		});
	}

	const [allowlistRaw, setAllowlistRaw] = useState("");
	const [historyRetentionRaw, setHistoryRetentionRaw] = useState("30");

	const loadComputerUse = useCallback(async () => {
		const epoch = ++computerUseLoadEpoch.current;
		setComputerUseLoaded(false);
		setComputerUseLoadFailed(false);
		setJevSecretLoaded(false);
		setJevSecretLoadFailed(false);
		setComputerUseReadError(null);
		setComputerUseNotice(null);
		const reportReadFailure = (error: unknown): never => {
			if (computerUseLoadEpoch.current === epoch) {
				setComputerUseLoadFailed(true);
				setComputerUseReadError(
					error instanceof Error
						? error.message
						: "Could not load computer-use settings."
				);
			}
			throw error;
		};
		const results = await Promise.allSettled([
			getShadowComputerUseConfigStrict()
				.then((config) => {
					if (computerUseLoadEpoch.current !== epoch) {
						return;
					}
					const {
						applied: _applied,
						jevApiKeyConfigured: _configured,
						...editable
					} = config;
					setComputerUse(
						editable.planner === "laya"
							? {
									...editable,
									planner: "local",
									localPluginId: editable.localPluginId || "@ryu/laya",
									localModelId: editable.localModelId || "router",
								}
							: editable
					);
					setJevApiKeyConfigured(config.jevApiKeyConfigured);
					setComputerUseLoaded(true);
				})
				.catch(reportReadFailure),
			listPluginSecrets(localTarget, SHADOW_PLUGIN_ID)
				.then((secrets) => {
					if (computerUseLoadEpoch.current !== epoch) {
						return;
					}
					const secret = secrets.find((entry) => entry.key === JEV_SECRET_KEY);
					setJevSecretSet(secret?.set ?? false);
					setJevSecretShadowed(secret?.shadowed_by_env ?? false);
					setJevSecretLoaded(true);
				})
				.catch((error) => {
					if (computerUseLoadEpoch.current === epoch) {
						setJevSecretLoadFailed(true);
					}
					return reportReadFailure(error);
				}),
		]);
		if (computerUseLoadEpoch.current !== epoch) {
			return;
		}
		setJevSecretLoadFailed(results[1].status === "rejected");
		const failures = results.filter((result) => result.status === "rejected");
		if (failures.length > 0) {
			setComputerUseLoadFailed(true);
			setComputerUseReadError(
				failures
					.map((failure) =>
						failure.reason instanceof Error
							? failure.reason.message
							: "Could not load computer-use settings."
					)
					.join("; ")
			);
		}
	}, [localTarget]);

	useEffect(() => {
		void loadComputerUse();
		return () => {
			computerUseLoadEpoch.current += 1;
		};
	}, [loadComputerUse]);

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

	const saveComputerUse = async () => {
		if (computerUseWriteInFlight.current || !computerUseLoaded) {
			return;
		}
		computerUseWriteInFlight.current = true;
		setComputerUseBusy(true);
		setComputerUseError(null);
		setComputerUseNotice(null);
		try {
			const saved = await setShadowComputerUseConfig(computerUse);
			const {
				applied: _applied,
				jevApiKeyConfigured: _configured,
				...editable
			} = saved;
			setComputerUse(editable);
			setComputerUseNotice(
				saved.applied
					? "Computer-use settings saved and applied."
					: "Computer-use settings saved; they will apply when Shadow starts."
			);
		} catch (error) {
			setComputerUseError(
				error instanceof Error
					? error.message
					: "Could not save computer-use settings."
			);
		} finally {
			computerUseWriteInFlight.current = false;
			setComputerUseBusy(false);
		}
	};

	const restartShadowForCredential = async () => {
		const reachable = await refreshShadow();
		if (reachable) {
			await stopSidecar(
				localTarget.url,
				localTarget.token,
				"shadow",
				localTarget.userJwt ?? null
			);
			await startSidecar(
				localTarget.url,
				localTarget.token,
				"shadow",
				localTarget.userJwt ?? null
			);
			await refreshShadow();
			return true;
		}
		return false;
	};

	const saveJevKey = async () => {
		if (computerUseWriteInFlight.current || !jevSecretLoaded) {
			return;
		}
		if (!jevKeyDraft.trim()) {
			setComputerUseError("Paste a Jev API key before saving.");
			return;
		}
		computerUseWriteInFlight.current = true;
		setComputerUseBusy(true);
		setComputerUseError(null);
		setComputerUseNotice(null);
		try {
			await setPluginSecret(
				localTarget,
				SHADOW_PLUGIN_ID,
				JEV_SECRET_KEY,
				jevKeyDraft.trim()
			);
			const secret = (
				await listPluginSecrets(localTarget, SHADOW_PLUGIN_ID)
			).find((entry) => entry.key === JEV_SECRET_KEY);
			setJevKeyDraft("");
			setJevSecretSet(secret?.set ?? true);
			setJevSecretShadowed(secret?.shadowed_by_env ?? false);
			setJevApiKeyConfigured(true);
			const restarted = await restartShadowForCredential();
			setComputerUseNotice(
				restarted
					? "Jev key saved encrypted. Shadow restarted to load it."
					: "Jev key saved encrypted. Shadow will load it when it next starts."
			);
		} catch (error) {
			setComputerUseError(
				error instanceof Error ? error.message : "Could not save the Jev key."
			);
		} finally {
			computerUseWriteInFlight.current = false;
			setComputerUseBusy(false);
		}
	};

	const clearJevKey = async () => {
		if (computerUseWriteInFlight.current || !jevSecretLoaded) {
			return;
		}
		computerUseWriteInFlight.current = true;
		setComputerUseBusy(true);
		setComputerUseError(null);
		setComputerUseNotice(null);
		try {
			await clearPluginSecret(localTarget, SHADOW_PLUGIN_ID, JEV_SECRET_KEY);
			const secret = (
				await listPluginSecrets(localTarget, SHADOW_PLUGIN_ID)
			).find((entry) => entry.key === JEV_SECRET_KEY);
			setJevSecretSet(secret?.set ?? false);
			setJevSecretShadowed(secret?.shadowed_by_env ?? false);
			setJevApiKeyConfigured(Boolean(secret?.shadowed_by_env));
			const restarted = await restartShadowForCredential();
			setComputerUseNotice(
				secret?.shadowed_by_env
					? "Stored Jev key cleared. The process environment still provides a key."
					: restarted
						? "Stored Jev key cleared. Shadow restarted."
						: "Stored Jev key cleared. The change applies when Shadow next starts."
			);
		} catch (error) {
			setComputerUseError(
				error instanceof Error ? error.message : "Could not clear the Jev key."
			);
		} finally {
			computerUseWriteInFlight.current = false;
			setComputerUseBusy(false);
		}
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

			<SettingsSection
				caption="Choose how Shadow plans user-requested computer tasks. Jev sends the goal and current accessibility labels and field values to its configured HTTPS endpoint. Local model plugins run the decision step on this node; any requested text is generated by Shadow’s configured text model."
				title="Computer use"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Select
								disabled={computerUseBusy || !computerUseLoaded}
								items={[
									{ value: "native", label: "Shadow model" },
									{ value: "jev", label: "Jev Ultrafast" },
									{ value: "local", label: "Local model plugin" },
								]}
								onValueChange={(value) => {
									if (value === "native" || value === "jev") {
										setComputerUse((current) => ({
											...current,
											planner: value,
										}));
									} else if (value === "local") {
										const firstPlanner = computerUsePlanners[0];
										setComputerUse((current) => ({
											...current,
											planner: "local",
											localPluginId:
												current.localPluginId || firstPlanner?.plugin || "",
											localModelId:
												current.localModelId || firstPlanner?.model_id || "",
										}));
									}
								}}
								value={computerUse.planner}
							>
								<SelectTrigger
									aria-label="Shadow computer-use planner"
									className="h-8 w-52"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="native">Shadow model</SelectItem>
									<SelectItem value="jev">Jev Ultrafast</SelectItem>
									<SelectItem value="local">Local model plugin</SelectItem>
								</SelectContent>
							</Select>
						}
						description="This setting applies to the shadow.computer_use tool. The regular Shadow activity chat stays on its existing model path."
						title="Planner"
					/>
					<SettingsItem
						actions={
							<div className="flex items-center gap-2">
								<Input
									aria-label="Maximum computer-use steps"
									className="h-8 w-24"
									max={20}
									min={1}
									onChange={(event) => {
										const parsed = Number.parseInt(event.target.value, 10);
										if (Number.isFinite(parsed)) {
											setComputerUse((current) => ({
												...current,
												maxSteps: Math.max(1, Math.min(20, parsed)),
											}));
										}
									}}
									type="number"
									value={computerUse.maxSteps}
								/>
								<span className="text-muted-foreground text-xs">steps</span>
							</div>
						}
						description="Hard limit per request, from 1 to 20. Shadow never presses Enter or submits a form automatically."
						title="Action limit"
					/>
				</SettingsGroup>

				{computerUse.planner === "jev" ? (
					<SettingsGroup>
						<SettingsItem
							actions={
								<Input
									aria-label="Jev decision endpoint URL"
									className="h-8 w-80"
									maxLength={2048}
									onChange={(event) =>
										setComputerUse((current) => ({
											...current,
											jevUrl: event.target.value,
										}))
									}
									value={computerUse.jevUrl}
								/>
							}
							description="Use the Typesafe Jev endpoint or another trusted HTTPS-compatible endpoint. Redirects are refused."
							title="Jev endpoint"
						/>
						<SettingsItem
							actions={
								<Input
									aria-label="Jev model identifier"
									className="h-8 w-52"
									maxLength={128}
									onChange={(event) =>
										setComputerUse((current) => ({
											...current,
											jevModel: event.target.value,
										}))
									}
									value={computerUse.jevModel}
								/>
							}
							description="Jev’s action-selection model name."
							title="Jev model"
						/>
						<SettingsItem
							actions={
								<div className="flex items-center gap-2">
									<Input
										aria-label="Jev API key"
										autoComplete="new-password"
										className="h-8 w-64"
										onChange={(event) => setJevKeyDraft(event.target.value)}
										placeholder={
											jevSecretSet ? "Saved; enter to replace" : "Paste API key"
										}
										type="password"
										value={jevKeyDraft}
									/>
									<Button
										disabled={
											computerUseBusy || !jevSecretLoaded || !jevKeyDraft.trim()
										}
										onClick={saveJevKey}
										size="sm"
									>
										Save key
									</Button>
									{jevSecretSet ? (
										<Button
											disabled={computerUseBusy || !jevSecretLoaded}
											onClick={clearJevKey}
											size="sm"
											variant="ghost"
										>
											Clear
										</Button>
									) : null}
								</div>
							}
							description={
								jevSecretLoaded
									? jevSecretShadowed
										? "An environment-provided key takes precedence over the encrypted saved key."
										: jevSecretSet
											? "Key saved encrypted on this node. Shadow reloads it after restart; the value is never shown again."
											: jevApiKeyConfigured
												? "A Jev key is provided to Shadow by its process environment."
												: "Required by Jev. Saved encrypted on this node and never returned to the app."
									: jevSecretLoadFailed
										? "Credential state could not be loaded. Retry to read the saved key state."
										: "Loading credential state…"
							}
							title="Jev credential"
						/>
					</SettingsGroup>
				) : null}

				{computerUse.planner === "local" || computerUse.planner === "laya" ? (
					<SettingsGroup>
						<SettingsItem
							actions={
								<Select
									disabled={computerUseBusy || !computerUseLoaded}
									items={localPlannerItems}
									onValueChange={(value) => {
										const selected = computerUsePlanners.find(
											(planner) =>
												plannerOptionValue(planner.plugin, planner.id) === value
										);
										if (selected) {
											setComputerUse((current) => ({
												...current,
												planner: "local",
												localPluginId: selected.plugin,
												localModelId: selected.model_id,
											}));
										}
									}}
									value={localPlannerSelectValue}
								>
									<SelectTrigger
										aria-label="Local computer-use model"
										className="h-8 w-[min(32rem,55vw)]"
									>
										<SelectValue placeholder="Choose an enabled plugin model" />
									</SelectTrigger>
									<SelectContent>
										{localPlannerItems.map((item) => (
											<SelectItem key={item.value} value={item.value}>
												{item.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							}
							description={
								computerUsePlanners.length > 0
									? "Options come from enabled model plugins. Inference stays inside the plugin; Shadow receives only a normalized action choice."
									: "Install and enable a local computer-use model plugin to make models available here. FunctionGemma downloads require a Hugging Face token and acceptance of Google's Gemma terms."
							}
							title="Local model"
						/>
					</SettingsGroup>
				) : null}

				<div className="flex justify-end">
					<Button
						disabled={
							computerUseBusy ||
							!computerUseLoaded ||
							((computerUse.planner === "local" ||
								computerUse.planner === "laya") &&
								!selectedLocalPlanner)
						}
						onClick={saveComputerUse}
					>
						{computerUseBusy ? "Saving…" : "Save computer-use settings"}
					</Button>
				</div>
				{computerUseReadError ? (
					<Alert variant="destructive">
						<AlertTitle>Computer-use settings could not be loaded</AlertTitle>
						<AlertDescription>{computerUseReadError}</AlertDescription>
						<Button
							disabled={computerUseBusy}
							onClick={() => {
								if (!computerUseWriteInFlight.current) {
									void loadComputerUse();
								}
							}}
							size="sm"
							variant="outline"
						>
							Retry
						</Button>
					</Alert>
				) : null}
				{computerUseError ? (
					<Alert variant="destructive">
						<AlertTitle>Computer-use settings could not be saved</AlertTitle>
						<AlertDescription>{computerUseError}</AlertDescription>
					</Alert>
				) : null}
				{computerUseNotice ? (
					<p className="px-3 text-status-success text-xs" role="status">
						{computerUseNotice}
					</p>
				) : null}
				{computerUseLoaded || computerUseLoadFailed ? null : (
					<p className="px-3 text-muted-foreground text-xs" role="status">
						Loading computer-use settings…
					</p>
				)}
				<p className="px-3 text-muted-foreground text-xs">
					Invoke the configured path through the{" "}
					<code>shadow.computer_use</code> tool after the user requests a
					computer task.
				</p>
			</SettingsSection>

			<SettingsSection
				caption={
					<>
						Comma-separated app names. Leave empty to capture everything; add
						entries to capture only those apps.
						{allowlist.length > 0 && (
							<span className="ml-1 font-medium text-foreground">
								Selected ({allowlist.length} app
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
