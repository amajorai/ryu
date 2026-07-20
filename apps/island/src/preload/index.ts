import { contextBridge, ipcRenderer } from "electron";
import {
	type AcpConfigResult,
	type AgentsResult,
	type AvailabilityResult,
	type CaptureControlResult,
	type CaptureControlUpdate,
	type CatalogActionResult,
	type CatalogInstallRequest,
	type CatalogListRequest,
	type CatalogListResult,
	type CatalogSelectSourceRequest,
	type CatalogSourcesResult,
	type ConsentPatch,
	type ConsentState,
	type ContentSizePayload,
	type ConversationsResult,
	type CoreChatStreamHandle,
	type CoreChatStreamRequest,
	type CoreCompletionsRequest,
	type CoreCompletionsResult,
	type CoreSpeakRequest,
	type CoreSpeakResult,
	type CoreStreamEndEvent,
	type CoreStreamPartEvent,
	type CoreToolCallRequest,
	type CoreToolCallResult,
	type CoreTranscribeResult,
	type CursorPoint,
	type DictationSubmitResult,
	type DragStartPayload,
	type EngineModelsResult,
	type FeedbackRequest,
	type FeedbackResult,
	IPC,
	type IslandApi,
	type IslandAttachment,
	type IslandMeetingEvent,
	type IslandMeetingResult,
	type IslandQuestEvent,
	type IslandQuestResult,
	type IslandSettings,
	type IslandSettingsPatch,
	type IslandStartMeetingInput,
	type IslandSuggestion,
	type IslandWinApi,
	type MoveByPayload,
	type PluginContributionsResult,
	type PluginCoreHttpRequest,
	type PluginCoreHttpResult,
	type PluginHostInvokeRequest,
	type PluginHostInvokeResult,
	type PluginHostStreamChunkEvent,
	type PluginHostStreamEndEvent,
	type PluginHostStreamHandle,
	type PluginHostStreamStartRequest,
	type PluginUiBundleResult,
	type SetMouseCapturePayload,
	type ShadowContextResult,
	type ShadowProactiveInboxResult,
	type ShadowProactiveResult,
	type SidecarStartResult,
	type SidecarStatusResult,
	type SuggestionEngineStatus,
	type SuggestionFeedbackRequest,
	type SuggestionFeedbackResult,
	type UpdateState,
	type VoiceCycleDirection,
	type VoiceTarget,
	WIN_CHANNELS,
} from "../shared/ipc.ts";

// Subscribe a renderer listener to an IPC event channel, returning an
// unsubscribe function. The raw Electron `event` arg is stripped so the
// renderer only sees the typed payload.
function subscribe<T>(
	channel: string,
	listener: (payload: T) => void
): () => void {
	const handler = (_event: unknown, payload: T): void => listener(payload);
	ipcRenderer.on(channel, handler);
	return () => ipcRenderer.removeListener(channel, handler);
}

const win: IslandWinApi = {
	setMouseCapture(capture: boolean): void {
		const payload: SetMouseCapturePayload = { capture };
		ipcRenderer.send(WIN_CHANNELS.setMouseCapture, payload);
	},
	dragStart(rect: DragStartPayload): void {
		ipcRenderer.send(WIN_CHANNELS.dragStart, rect);
	},
	moveBy(dx: number, dy: number): void {
		const payload: MoveByPayload = { dx, dy };
		ipcRenderer.send(WIN_CHANNELS.moveBy, payload);
	},
	dragEnd(): void {
		ipcRenderer.send(WIN_CHANNELS.dragEnd);
	},
	setContentSize(width: number, height: number, expanded: boolean): void {
		const payload: ContentSizePayload = { width, height, expanded };
		ipcRenderer.send(WIN_CHANNELS.setContentSize, payload);
	},
};

const api: IslandApi = {
	version: process.env.npm_package_version ?? "0.1.0",
	win,
	appearance: {
		get: (): Promise<string | null> => ipcRenderer.invoke(IPC.appearance.get),
	},
	core: {
		health: (): Promise<AvailabilityResult> =>
			ipcRenderer.invoke(IPC.core.health),
		chatStream: (req: CoreChatStreamRequest): Promise<CoreChatStreamHandle> =>
			ipcRenderer.invoke(IPC.core.chatStreamStart, req),
		abortStream: (streamId: string): Promise<void> =>
			ipcRenderer.invoke(IPC.core.chatStreamAbort, streamId),
		onStreamPart: (
			listener: (event: CoreStreamPartEvent) => void
		): (() => void) => subscribe(IPC.core.streamPart, listener),
		onStreamEnd: (
			listener: (event: CoreStreamEndEvent) => void
		): (() => void) => subscribe(IPC.core.streamEnd, listener),
		completions: (
			req: CoreCompletionsRequest
		): Promise<CoreCompletionsResult> =>
			ipcRenderer.invoke(IPC.core.completions, req),
		callTool: (req: CoreToolCallRequest): Promise<CoreToolCallResult> =>
			ipcRenderer.invoke(IPC.core.callTool, req),
		sidecarStatus: (): Promise<SidecarStatusResult> =>
			ipcRenderer.invoke(IPC.core.sidecarStatus),
		sidecarStart: (name: string): Promise<SidecarStartResult> =>
			ipcRenderer.invoke(IPC.core.sidecarStart, name),
		transcribe: (
			audio: ArrayBuffer,
			engine: string
		): Promise<CoreTranscribeResult> =>
			ipcRenderer.invoke(IPC.core.transcribe, { audio, engine }),
		agents: (): Promise<AgentsResult> => ipcRenderer.invoke(IPC.core.agents),
		acpConfig: (agentId: string): Promise<AcpConfigResult> =>
			ipcRenderer.invoke(IPC.core.acpConfig, agentId),
		engineModels: (): Promise<EngineModelsResult> =>
			ipcRenderer.invoke(IPC.core.engineModels),
		conversations: (): Promise<ConversationsResult> =>
			ipcRenderer.invoke(IPC.core.conversations),
	},
	plugins: {
		contributions: (): Promise<PluginContributionsResult> =>
			ipcRenderer.invoke(IPC.plugins.contributions),
		uiBundle: (pluginId: string): Promise<PluginUiBundleResult> =>
			ipcRenderer.invoke(IPC.plugins.uiBundle, pluginId),
		hostInvoke: (
			req: PluginHostInvokeRequest
		): Promise<PluginHostInvokeResult> =>
			ipcRenderer.invoke(IPC.plugins.hostInvoke, req),
		coreHttp: (req: PluginCoreHttpRequest): Promise<PluginCoreHttpResult> =>
			ipcRenderer.invoke(IPC.plugins.coreHttp, req),
		startHostStream: (
			req: PluginHostStreamStartRequest
		): Promise<PluginHostStreamHandle> =>
			ipcRenderer.invoke(IPC.plugins.hostStreamStart, req),
		abortHostStream: (streamId: string): Promise<void> =>
			ipcRenderer.invoke(IPC.plugins.hostStreamAbort, streamId),
		onHostStreamChunk: (
			listener: (event: PluginHostStreamChunkEvent) => void
		): (() => void) => subscribe(IPC.plugins.hostStreamChunk, listener),
		onHostStreamEnd: (
			listener: (event: PluginHostStreamEndEvent) => void
		): (() => void) => subscribe(IPC.plugins.hostStreamEnd, listener),
	},
	command: {
		onOpen: (listener: () => void): (() => void) =>
			subscribe(IPC.command.open, listener),
		onBlur: (listener: () => void): (() => void) =>
			subscribe(IPC.command.blur, listener),
	},
	catalog: {
		sources: (kind: "skill" | "mcp"): Promise<CatalogSourcesResult> =>
			ipcRenderer.invoke(IPC.catalog.sources, kind),
		list: (req: CatalogListRequest): Promise<CatalogListResult> =>
			ipcRenderer.invoke(IPC.catalog.list, req),
		install: (req: CatalogInstallRequest): Promise<CatalogActionResult> =>
			ipcRenderer.invoke(IPC.catalog.install, req),
		selectSource: (
			req: CatalogSelectSourceRequest
		): Promise<CatalogActionResult> =>
			ipcRenderer.invoke(IPC.catalog.selectSource, req),
	},
	shadow: {
		getCurrentContext: (): Promise<ShadowContextResult> =>
			ipcRenderer.invoke(IPC.shadow.getCurrentContext),
		getProactive: (): Promise<ShadowProactiveResult> =>
			ipcRenderer.invoke(IPC.shadow.getProactive),
		getProactiveInbox: (): Promise<ShadowProactiveInboxResult> =>
			ipcRenderer.invoke(IPC.shadow.getProactiveInbox),
		postFeedback: (req: FeedbackRequest): Promise<FeedbackResult> =>
			ipcRenderer.invoke(IPC.shadow.postFeedback, req),
		getCaptureControl: (): Promise<CaptureControlResult> =>
			ipcRenderer.invoke(IPC.shadow.getCaptureControl),
		setCaptureControl: (
			update: CaptureControlUpdate
		): Promise<CaptureControlResult> =>
			ipcRenderer.invoke(IPC.shadow.setCaptureControl, update),
	},
	suggestions: {
		start: (): Promise<SuggestionEngineStatus> =>
			ipcRenderer.invoke(IPC.suggestions.start),
		stop: (): Promise<SuggestionEngineStatus> =>
			ipcRenderer.invoke(IPC.suggestions.stop),
		status: (): Promise<SuggestionEngineStatus> =>
			ipcRenderer.invoke(IPC.suggestions.status),
		feedback: (
			req: SuggestionFeedbackRequest
		): Promise<SuggestionFeedbackResult> =>
			ipcRenderer.invoke(IPC.suggestions.feedback, req),
		onNew: (listener: (suggestion: IslandSuggestion) => void): (() => void) =>
			subscribe(IPC.suggestions.new, listener),
		onCleared: (listener: () => void): (() => void) =>
			subscribe(IPC.suggestions.cleared, listener),
	},
	meetings: {
		start: (input?: IslandStartMeetingInput): Promise<IslandMeetingResult> =>
			ipcRenderer.invoke(IPC.meetings.start, input ?? {}),
		finalize: (id: string): Promise<IslandMeetingResult> =>
			ipcRenderer.invoke(IPC.meetings.finalize, id),
		onEvent: (listener: (event: IslandMeetingEvent) => void): (() => void) =>
			subscribe(IPC.meetings.event, listener),
	},
	quests: {
		accept: (id: string): Promise<IslandQuestResult> =>
			ipcRenderer.invoke(IPC.quests.accept, id),
		dismiss: (id: string): Promise<IslandQuestResult> =>
			ipcRenderer.invoke(IPC.quests.dismiss, id),
		onEvent: (listener: (event: IslandQuestEvent) => void): (() => void) =>
			subscribe(IPC.quests.event, listener),
	},
	system: {
		openExternal: (url: string): Promise<void> =>
			ipcRenderer.invoke(IPC.system.openExternal, url),
		attachFiles: (): Promise<IslandAttachment[]> =>
			ipcRenderer.invoke(IPC.system.attachFiles),
	},
	consent: {
		get: (): Promise<ConsentState> => ipcRenderer.invoke(IPC.consent.get),
		set: (patch: ConsentPatch): Promise<ConsentState> =>
			ipcRenderer.invoke(IPC.consent.set, patch),
		onChanged: (listener: (state: ConsentState) => void): (() => void) =>
			subscribe(IPC.consent.changed, listener),
	},
	settings: {
		get: (): Promise<IslandSettings> => ipcRenderer.invoke(IPC.settings.get),
		set: (patch: IslandSettingsPatch): Promise<IslandSettings> =>
			ipcRenderer.invoke(IPC.settings.set, patch),
	},
	theme: {
		get: (): Promise<string | null> => ipcRenderer.invoke(IPC.theme.get),
		onChanged: (listener: (value: string) => void): (() => void) =>
			subscribe(IPC.theme.changed, listener),
	},
	voice: {
		get: (): Promise<string | null> => ipcRenderer.invoke(IPC.voice.get),
		onChanged: (listener: (value: string) => void): (() => void) =>
			subscribe(IPC.voice.changed, listener),
		onToggle: (listener: () => void): (() => void) =>
			subscribe(IPC.voice.toggle, listener),
		onStart: (listener: () => void): (() => void) =>
			subscribe(IPC.voice.start, listener),
		onStop: (listener: () => void): (() => void) =>
			subscribe(IPC.voice.stop, listener),
		onCycleAgent: (
			listener: (direction: VoiceCycleDirection) => void
		): (() => void) => subscribe(IPC.voice.cycleAgent, listener),
		setRecording: (active: boolean): void =>
			ipcRenderer.send(IPC.voice.recordingState, active),
		target: (): Promise<VoiceTarget> => ipcRenderer.invoke(IPC.voice.target),
	},
	dictation: {
		get: (): Promise<string | null> => ipcRenderer.invoke(IPC.dictation.get),
		onChanged: (listener: (value: string) => void): (() => void) =>
			subscribe(IPC.dictation.changed, listener),
		onToggle: (listener: () => void): (() => void) =>
			subscribe(IPC.dictation.toggle, listener),
		onStart: (listener: () => void): (() => void) =>
			subscribe(IPC.dictation.start, listener),
		onStop: (listener: () => void): (() => void) =>
			subscribe(IPC.dictation.stop, listener),
		setRecording: (active: boolean): void =>
			ipcRenderer.send(IPC.dictation.recordingState, active),
		submit: (audio: ArrayBuffer): Promise<DictationSubmitResult> =>
			ipcRenderer.invoke(IPC.dictation.submit, audio),
	},
	agents: {
		get: (): Promise<string | null> => ipcRenderer.invoke(IPC.agents.get),
		set: (raw: string): Promise<void> =>
			ipcRenderer.invoke(IPC.agents.set, raw),
		onChanged: (listener: (value: string) => void): (() => void) =>
			subscribe(IPC.agents.changed, listener),
	},
	tts: {
		get: (): Promise<string | null> => ipcRenderer.invoke(IPC.tts.get),
		onChanged: (listener: (value: string) => void): (() => void) =>
			subscribe(IPC.tts.changed, listener),
		speak: (req: CoreSpeakRequest): Promise<CoreSpeakResult> =>
			ipcRenderer.invoke(IPC.tts.speak, req),
	},
	window: {
		toggle: (): void => ipcRenderer.send(IPC.window.toggle),
		onVisibilityChanged: (listener: (visible: boolean) => void): (() => void) =>
			subscribe(IPC.window.visibilityChanged, listener),
		onCursorMove: (listener: (point: CursorPoint) => void): (() => void) =>
			subscribe(IPC.window.cursorMove, listener),
	},
	update: {
		getVersion: (): Promise<string> =>
			ipcRenderer.invoke(IPC.update.getVersion),
		getAutoUpdate: (): Promise<boolean> =>
			ipcRenderer.invoke(IPC.update.getAutoUpdate),
		setAutoUpdate: (enabled: boolean): Promise<boolean> =>
			ipcRenderer.invoke(IPC.update.setAutoUpdate, enabled),
		getState: (): Promise<UpdateState> =>
			ipcRenderer.invoke(IPC.update.getState),
		quitAndInstall: (): void => ipcRenderer.send(IPC.update.quitAndInstall),
		onAvailable: (listener: (state: UpdateState) => void): (() => void) =>
			subscribe(IPC.update.available, listener),
		onDownloaded: (listener: (state: UpdateState) => void): (() => void) =>
			subscribe(IPC.update.downloaded, listener),
	},
};

contextBridge.exposeInMainWorld("island", api);
