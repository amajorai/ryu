import { app, BrowserWindow, globalShortcut, ipcMain, screen } from "electron";
import {
	type IslandBackground,
	isMaterialAppearance,
	parseAppearance,
} from "../shared/appearance.ts";
import { parseAutoJump } from "../shared/auto-jump.ts";
import {
	COMMAND_SHORTCUT_PREF_KEY,
	parseCommandShortcut,
} from "../shared/command-shortcut.ts";
import {
	ISLAND_CONSENT_PREF_KEY,
	parseConsent,
	serializeConsent,
} from "../shared/consent.ts";
import {
	DICTATION_PREF_KEY,
	type DictationTask,
	parseDictationPrefs,
} from "../shared/dictation.ts";
import { parseEdgeOffset } from "../shared/edge-offset.ts";
import {
	HIDE_ON_FULLSCREEN_PREF_KEY,
	parseHideOnFullscreen,
} from "../shared/hide-on-fullscreen.ts";
import { type ConsentState, IPC } from "../shared/ipc.ts";
import { NOTCH_PREF_KEY, parseNotchMode } from "../shared/notch.ts";
import {
	DEFAULT_SCREEN_PRIVACY,
	parseScreenPrivacy,
	SCREEN_PRIVACY_PREF_KEY,
} from "../shared/screen-privacy.ts";
import { parseVoicePrefs } from "../shared/voice.ts";
import { initAutoJump, jumpNow, setAutoJump } from "./auto-jump.ts";
import { startControlServer, stopControlServer } from "./control.ts";
import { attachCursorTracking } from "./cursor-tracker.ts";
import { setEdgeOffset } from "./edge-offset.ts";
import { initFullscreenHide, setHideOnFullscreen } from "./fullscreen.ts";
import { destroyGhostCursor } from "./ghost-cursor.ts";
import { registerIpc } from "./ipc/index.ts";
import {
	isNotchModeEnabled,
	refreshNotchGeometry,
	setNotchMode,
} from "./notch.ts";
import { initZoneOverlay, setOverlayContentProtection } from "./overlay.ts";
import { applyEdgeOffset } from "./position.ts";
import {
	destroyScreenSurface,
	followIslandWindow,
	setScreenSurfaceContentProtection,
} from "./screen-surface.ts";
import {
	getAppearanceRaw,
	subscribeAppearanceChanges,
} from "./services/appearance.ts";
import {
	getAutoJumpRaw,
	subscribeAutoJumpChanges,
} from "./services/auto-jump.ts";
import { onCoreConfigChange, refreshCoreIdentity } from "./services/config.ts";
import {
	applyConsentState,
	getConsent,
	onConsentChanged,
} from "./services/consent.ts";
import {
	getEdgeOffsetRaw,
	subscribeEdgeOffsetChanges,
} from "./services/edge-offset.ts";
import { createPluginShortcutRegistrar } from "./services/plugin-shortcut-registration.ts";
import { createPluginShortcutRefresh } from "./services/plugin-shortcuts.ts";
import {
	getPreferenceRaw,
	setPreferenceRaw,
	subscribePreferenceChanges,
} from "./services/preferences.ts";
import { getVoicePrefsRaw, subscribeVoiceChanges } from "./services/voice.ts";
import {
	focusForCommand,
	hideWindow,
	setAppActivator,
	setVisibilityTarget,
	showWindow,
} from "./visibility.ts";
import {
	acceleratorPrimaryKeycode,
	configureHold,
	isHoldArmed,
	noteHoldPressed,
	setRecording,
	setTabCycle,
	stopHooks,
} from "./voice-control.ts";
import { createIslandWindow } from "./window.ts";

// Brand the running app: app.getName() otherwise defaults to the package name,
// which leaks into the macOS menu/dock, the process name, and the userData dir.
// The dev variant (RYU_PROFILE=dev) brands as "Ryu Island Dev" so it gets its own
// userData dir and reads as distinct in the menu/dock while running alongside a
// release island.
const isDevProfile =
	(process.env.RYU_PROFILE ?? "").trim().toLowerCase() === "dev";
app.setName(isDevProfile ? "Ryu Island Dev" : "Ryu Island");

// macOS: the island is a menu-bar companion, not a Dock app. The packaged build
// declares `LSUIElement: true` (electron-builder.yml) so it launches as an
// accessory with no Dock icon — but in dev (`electron-vite dev`) there is no
// packaged Info.plist, so hide the Dock at runtime too. `app.dock` is undefined
// off macOS, so the optional chaining makes this a no-op on Windows/Linux.
app.dock?.hide();
// macOS focus path for presentWindow (see visibility.ts).
setAppActivator(() => app.focus({ steal: true }));

// The currently-registered command-summon accelerator (null until bound),
// tracked so a settings change can unregister the old one before binding the new.
// Replaces the formerly-hardcoded `CommandOrControl+Shift+Space`; the value is now
// the `island-command-shortcut` preference (rebindable in desktop Island settings).
let commandShortcut: string | null = null;

// The currently-registered push-to-talk accelerator (null when disabled/unset),
// tracked so a settings change can unregister the old one before binding the new.
let voiceShortcut: string | null = null;

// The latest raw push-to-talk preference blob, kept so a command-shortcut change
// can re-reconcile push-to-talk (rebind it if its slot was freed) without a
// fresh Core read.
let lastVoiceRaw: string | null = null;

// The currently-registered dictation accelerator (null when disabled/unset),
// tracked so a settings change can unregister the old one before binding the new.
// Dictation is system-wide dictation (types into the focused app), distinct from
// push-to-talk voice input, and gets its own rebindable shortcut.
let dictationShortcut: string | null = null;

// The currently-registered agent-ask accelerator (null when disabled/unset).
// Agent-ask shares the dictation capture pipeline but pastes an agent answer.
let dictationAskShortcut: string | null = null;
const registerPluginShortcuts = createPluginShortcutRegistrar({
	register: (accelerator, handler) =>
		globalShortcut.register(accelerator, handler),
	unregister: (accelerator) => globalShortcut.unregister(accelerator),
	focus: () => focusForCommand(),
	sendShortcut: (companionId) =>
		islandWindow?.webContents.send(IPC.plugins.shortcut, companionId),
});
const applyPluginShortcuts = createPluginShortcutRefresh(
	(result, overrides) => {
		registerPluginShortcuts(
			result,
			overrides,
			[
				commandShortcut,
				voiceShortcut,
				dictationShortcut,
				dictationAskShortcut,
			].filter((value): value is string => value !== null)
		);
	}
);

// The latest raw dictation preference blob, kept so a command- or voice-shortcut
// change can re-reconcile dictation (which defers to both) without a fresh read.
let lastDictationRaw: string | null = null;

// The live island window (the snap-zone overlay is a separate BrowserWindow, so
// we track ours explicitly rather than scanning `getAllWindows()`).
let islandWindow: BrowserWindow | null = null;
// The appearance the live window was built with. Changing this mode requires
// recreating the window: `transparent` and the native material are set at
// construction time and cannot be toggled on a live window.
let currentBackground: IslandBackground = "acrylic";
// The Background the user chose last: the startup read, then each live change.
// A rebuild builds this value when the old window has closed, so a change that
// lands while a rebuild is in flight is applied instead of dropped.
let requestedBackground: IslandBackground = "acrylic";
// True while a recreation is tearing the old window down, so the transient
// zero-window moment does not trip `window-all-closed` into quitting the app.
let recreating = false;
// True once the app has begun quitting: a rebuild still tearing its old window
// down must not attach a fresh one then.
let quitting = false;
// Whether the island (and its drag overlay) must be excluded from screen capture
// — the `island-screen-privacy` preference. Tracked here so the state is re-applied
// to every fresh window after an appearance recreation (content protection is a
// per-window property that does not survive `recreateWindow`).
let currentScreenPrivacy = DEFAULT_SCREEN_PRIVACY;

function attachWindow(background: IslandBackground): BrowserWindow {
	const win = createIslandWindow(background);
	registerIpc(win, background);
	setVisibilityTarget(win);
	// Re-apply screen privacy: a recreated window starts un-protected, so seed it
	// from the tracked preference (the overlay mirrors it via its own setter).
	win.setContentProtection(currentScreenPrivacy);
	// The on-screen generative UI belongs to this window's chat; never let a
	// leftover screen outlive it (or keep the app alive after it closes), and
	// keep it hidden/shown and placed together with the Island.
	win.on("closed", destroyScreenSurface);
	followIslandWindow(win);
	// Track the global cursor so the island's eyes follow the pointer anywhere on
	// screen (not just over the small window). Cleans itself up on window close.
	attachCursorTracking(win);
	// When auto-jump is on, landing the island on the active monitor the instant it
	// becomes visible feels better than waiting for the settle loop to notice.
	win.on("show", jumpNow);
	// Tell the renderer the window lost focus so it can dismiss the command surface
	// (collapse to the resting pill). Skipped while devtools are focused so the
	// command palette stays open during dev inspection.
	win.on("blur", () => {
		if (win.isDestroyed() || win.webContents.isDevToolsOpened()) {
			return;
		}
		win.webContents.send(IPC.command.blur);
	});
	islandWindow = win;
	currentBackground = background;
	return win;
}

/**
 * Rebuild the island window in {@link requestedBackground}. Closing the old
 * window runs its teardown (`win:*` listeners + the snap-zone overlay) via its
 * `closed` handler, so we wait for that, then build the fresh window + overlay.
 * No-op when the built mode already matches (unless `force`, used when the notch
 * geometry changes). While a rebuild is in flight a new request only waits: the
 * pending rebuild reads the latest requested mode and notch state when it builds.
 */
function recreateWindow(force = false): void {
	if (recreating || (!force && requestedBackground === currentBackground)) {
		return;
	}
	const old = islandWindow;
	if (!old || old.isDestroyed()) {
		attachWindow(requestedBackground);
		initZoneOverlay();
		return;
	}
	recreating = true;
	old.once("closed", () => {
		// `recreating` must clear even if building the new window throws, or every
		// later Background change would wait on a rebuild that never finishes.
		try {
			if (!quitting) {
				attachWindow(requestedBackground);
				initZoneOverlay();
			}
		} finally {
			recreating = false;
		}
	});
	old.close();
}

/**
 * Apply the screen-privacy preference: exclude the island window (and its drag
 * overlay) from screen capture, or restore them to it. Stores the value so it is
 * re-applied after an appearance recreation, then updates the live windows.
 */
function applyScreenPrivacy(enabled: boolean): void {
	currentScreenPrivacy = enabled;
	if (islandWindow && !islandWindow.isDestroyed()) {
		islandWindow.setContentProtection(enabled);
	}
	setOverlayContentProtection(enabled);
	setScreenSurfaceContentProtection(enabled);
}

/**
 * Global-hotkey handler: summon the command palette. Toggles like a launcher —
 * if the island is already visible AND focused, pressing again hides it;
 * otherwise it shows + focuses the window and tells the renderer to open the
 * command surface. Focus + click-through are forced in {@link focusForCommand} so
 * the palette accepts typing even when the pointer is elsewhere.
 */
function summonCommand(): void {
	const win = islandWindow;
	if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) {
		hideWindow();
		return;
	}
	focusForCommand();
	if (win && !win.isDestroyed()) {
		win.webContents.send(IPC.command.open);
	}
}

/** Send a no-payload voice signal to the renderer, if the window is alive. */
function sendVoiceSignal(channel: string): void {
	if (islandWindow && !islandWindow.isDestroyed()) {
		islandWindow.webContents.send(channel);
	}
}

/** Tell the renderer the toggle-mode shortcut fired (start OR stop recording). */
function sendVoiceToggle(): void {
	sendVoiceSignal(IPC.voice.toggle);
}

/** Tell the renderer to start recording (push-to-talk key held down). */
function sendVoiceStart(): void {
	sendVoiceSignal(IPC.voice.start);
}

/** Tell the renderer to stop recording (push-to-talk key released). */
function sendVoiceStop(): void {
	sendVoiceSignal(IPC.voice.stop);
}

/** Tell the renderer to rotate the routed agent (Tab pressed while recording). */
function sendCycleAgent(direction: 1 | -1): void {
	if (islandWindow && !islandWindow.isDestroyed()) {
		islandWindow.webContents.send(IPC.voice.cycleAgent, direction);
	}
}

/** Tell the renderer the dictation toggle-mode shortcut fired (start OR stop). */
function sendDictationToggle(task: DictationTask = "transcribe"): void {
	if (islandWindow && !islandWindow.isDestroyed()) {
		islandWindow.webContents.send(IPC.dictation.toggle, task);
	}
}

/** Tell the renderer to start dictation capture (push-to-talk key held down). */
function sendDictationStart(task: DictationTask = "transcribe"): void {
	if (islandWindow && !islandWindow.isDestroyed()) {
		islandWindow.webContents.send(IPC.dictation.start, task);
	}
}

/** Tell the renderer to stop dictation capture (push-to-talk key released). */
function sendDictationStop(): void {
	sendVoiceSignal(IPC.dictation.stop);
}

/**
 * Register one dictation-family shortcut (plain dictation or agent-ask). Returns
 * the registered accelerator on success, otherwise `null`.
 */
function registerDictationShortcut(
	shortcut: string,
	task: DictationTask,
	holdChannel: string,
	mode: "toggle" | "push-to-talk",
	occupied: Set<string>
): string | null {
	if (occupied.has(shortcut)) {
		configureHold(holdChannel, {
			pttMode: false,
			keycode: null,
			onRelease: sendDictationStop,
		});
		return null;
	}
	const primaryKeycode = acceleratorPrimaryKeycode(shortcut);
	const holdToTalk = mode === "push-to-talk" && primaryKeycode !== null;
	configureHold(holdChannel, {
		pttMode: holdToTalk,
		keycode: primaryKeycode,
		onRelease: sendDictationStop,
	});
	try {
		const ok = globalShortcut.register(shortcut, () => {
			// Deliberately no showWindow()/focus: dictation types into the currently
			// focused native app, so stealing focus here would break insertion.
			if (holdToTalk && isHoldArmed(holdChannel)) {
				noteHoldPressed(holdChannel);
				sendDictationStart(task);
			} else {
				sendDictationToggle(task);
			}
		});
		return ok ? shortcut : null;
	} catch {
		return null;
	}
}

/**
 * (Re)register system-wide dictation + agent-ask global shortcuts from the
 * `dictation` preference. Unregisters previous accelerators first, skips when
 * the Dictation plugin (prefs.enabled) is off, and refuses to clobber the
 * command-summon or push-to-talk shortcuts.
 */
function applyDictationPrefs(raw: string | null): void {
	if (dictationShortcut) {
		globalShortcut.unregister(dictationShortcut);
		dictationShortcut = null;
	}
	if (dictationAskShortcut) {
		globalShortcut.unregister(dictationAskShortcut);
		dictationAskShortcut = null;
	}
	const prefs = parseDictationPrefs(raw);
	const occupied = new Set(
		[commandShortcut, voiceShortcut].filter((s): s is string => Boolean(s))
	);

	if (!prefs.enabled) {
		configureHold("dictation", {
			pttMode: false,
			keycode: null,
			onRelease: sendDictationStop,
		});
		configureHold("dictation-ask", {
			pttMode: false,
			keycode: null,
			onRelease: sendDictationStop,
		});
		return;
	}

	dictationShortcut = registerDictationShortcut(
		prefs.shortcut,
		"transcribe",
		"dictation",
		prefs.mode,
		occupied
	);
	if (dictationShortcut) {
		occupied.add(dictationShortcut);
	}

	if (prefs.ask.enabled) {
		dictationAskShortcut = registerDictationShortcut(
			prefs.ask.shortcut,
			"ask",
			"dictation-ask",
			prefs.ask.mode,
			occupied
		);
	} else {
		configureHold("dictation-ask", {
			pttMode: false,
			keycode: null,
			onRelease: sendDictationStop,
		});
	}
}

/**
 * (Re)register the push-to-talk global shortcut from the voice-input preference.
 * Unregisters the previous accelerator first, skips when disabled, and refuses to
 * clobber the visibility toggle hotkey. Pressing it shows the island and signals
 * the renderer to toggle recording.
 */
function applyVoicePrefs(raw: string | null): void {
	if (voiceShortcut) {
		globalShortcut.unregister(voiceShortcut);
		voiceShortcut = null;
	}
	const prefs = parseVoicePrefs(raw);
	const canRegister = prefs.enabled && prefs.shortcut !== commandShortcut;
	// Push-to-talk needs the activation key mapped to a hook keycode; if it is not
	// mappable (or the shortcut can't bind), fall back to toggle behavior so voice
	// input keeps working.
	const primaryKeycode = acceleratorPrimaryKeycode(prefs.shortcut);
	const holdToTalk =
		canRegister && prefs.mode === "push-to-talk" && primaryKeycode !== null;
	// Configure the "voice" hold channel on the shared key hook (hold-to-talk
	// release). The hook only runs while a hold is armed or a recording is active.
	configureHold("voice", {
		pttMode: holdToTalk,
		keycode: primaryKeycode,
		onRelease: sendVoiceStop,
	});
	if (!canRegister) {
		return;
	}
	try {
		// Toggle mode: the down-press starts, the next down-press stops. Hold-to-talk:
		// the down-press starts and the hook's key-up (above) stops. The global
		// shortcut consumes the key-down either way, so the chord never leaks.
		const ok = globalShortcut.register(prefs.shortcut, () => {
			showWindow();
			// Hold-to-talk only when the key hook is actually running; otherwise fall
			// back to toggle so a missing Input Monitoring grant can't strand capture
			// with no stop path.
			if (holdToTalk && isHoldArmed("voice")) {
				// Arm release detection (main-tracked) before telling the renderer to
				// start, so a fast release still stops capture cleanly.
				noteHoldPressed("voice");
				sendVoiceStart();
			} else {
				sendVoiceToggle();
			}
		});
		if (ok) {
			voiceShortcut = prefs.shortcut;
		}
	} catch {
		// Invalid accelerator string: leave voice input unbound until corrected.
	}
}

/**
 * (Re)register the command-summon global shortcut from the `island-command-shortcut`
 * preference. Unregisters the previous accelerator first, frees the slot if the
 * push-to-talk shortcut currently holds it (the command summon always wins the
 * collision), then reconciles push-to-talk so it rebinds if freed and keeps
 * deferring to this on a clash. No-op when the accelerator is unchanged.
 */
function applyCommandShortcut(raw: string | null): void {
	const next = parseCommandShortcut(raw);
	if (commandShortcut === next) {
		return;
	}
	if (commandShortcut) {
		globalShortcut.unregister(commandShortcut);
		commandShortcut = null;
	}
	if (voiceShortcut === next) {
		globalShortcut.unregister(voiceShortcut);
		voiceShortcut = null;
	}
	if (dictationShortcut === next) {
		globalShortcut.unregister(dictationShortcut);
		dictationShortcut = null;
	}
	if (dictationAskShortcut === next) {
		globalShortcut.unregister(dictationAskShortcut);
		dictationAskShortcut = null;
	}
	try {
		if (globalShortcut.register(next, () => summonCommand())) {
			commandShortcut = next;
		}
	} catch {
		// Invalid accelerator string: leave the command bar unbound until corrected.
	}
	// Push-to-talk and dictation may now need (re)binding (their slots could have
	// moved) and both defer to the command shortcut, so reconcile them against the
	// new state. Voice is reconciled first; dictation defers to voice too.
	applyVoicePrefs(lastVoiceRaw);
	applyDictationPrefs(lastDictationRaw);
}

async function bootstrap(): Promise<void> {
	// Identify the signed-in user to shared nodes from the first Core request.
	refreshCoreIdentity();
	// Resolve the persisted appearance + edge offset before building the window so
	// the first paint is already in the right mode and docked at the saved gap
	// (no flash/recreate or reposition on a cold start).
	const [
		notchRaw,
		appearanceRaw,
		edgeOffsetRaw,
		autoJumpRaw,
		screenPrivacyRaw,
		hideOnFullscreenRaw,
	] = await Promise.all([
		getPreferenceRaw(NOTCH_PREF_KEY),
		getAppearanceRaw(),
		getEdgeOffsetRaw(),
		getAutoJumpRaw(),
		getPreferenceRaw(SCREEN_PRIVACY_PREF_KEY),
		getPreferenceRaw(HIDE_ON_FULLSCREEN_PREF_KEY),
	]);
	setNotchMode(parseNotchMode(notchRaw));
	setEdgeOffset(parseEdgeOffset(edgeOffsetRaw));
	const background = parseAppearance(appearanceRaw).background;
	requestedBackground = background;
	// Seed screen privacy before the window + overlay are built so the very first
	// frame is already excluded from capture when enabled (content protection is a
	// per-window property, so the window must be (re)tagged on every create).
	currentScreenPrivacy = parseScreenPrivacy(screenPrivacyRaw);
	setOverlayContentProtection(currentScreenPrivacy);
	setScreenSurfaceContentProtection(currentScreenPrivacy);
	// Point the auto-jump controller at the live window + appearance before it can
	// be enabled (the getters are read each tick, so window recreation is handled).
	initAutoJump(
		() => islandWindow,
		() => isMaterialAppearance(currentBackground)
	);
	attachWindow(background);
	// Build + load the snap-zone overlay up front so it is ready before the
	// first drag (avoids a blank overlay on the initial gesture).
	initZoneOverlay();
	// The menu-bar presence is unified under the desktop (Tauri) tray; the island
	// has no tray of its own. Expose a loopback control surface so that tray can
	// show/hide/quit it. The global hotkey remains the primary summon affordance.
	startControlServer();

	// Hide-on-fullscreen: point the controller at the live window (the getter is
	// read each tick, so window recreation is handled), then start it from the saved
	// preference and keep it in sync with the desktop's Island settings.
	initFullscreenHide(() => islandWindow);
	setHideOnFullscreen(parseHideOnFullscreen(hideOnFullscreenRaw));
	subscribePreferenceChanges(HIDE_ON_FULLSCREEN_PREF_KEY, (raw) =>
		setHideOnFullscreen(parseHideOnFullscreen(raw))
	);

	// Screen privacy: re-apply on every live change from the desktop's settings.
	subscribePreferenceChanges(SCREEN_PRIVACY_PREF_KEY, (raw) =>
		applyScreenPrivacy(parseScreenPrivacy(raw))
	);

	// Follow the user to the active desktop/monitor when enabled. Seed from the
	// saved pref and keep it in sync with the desktop's Island settings.
	setAutoJump(parseAutoJump(autoJumpRaw));
	subscribeAutoJumpChanges((raw) => setAutoJump(parseAutoJump(raw)));

	subscribePreferenceChanges(NOTCH_PREF_KEY, (raw) => {
		setNotchMode(parseNotchMode(raw));
		recreateWindow(true);
	});
	const updateNotchDisplay = () => {
		if (!isNotchModeEnabled()) {
			return;
		}
		refreshNotchGeometry();
		recreateWindow(true);
	};
	screen.on("display-metrics-changed", updateNotchDisplay);
	screen.on("display-added", updateNotchDisplay);
	screen.on("display-removed", updateNotchDisplay);
	// React to live appearance changes from the desktop's settings. The last
	// change wins, even one that arrives while a rebuild is in flight.
	subscribeAppearanceChanges((raw) => {
		requestedBackground = parseAppearance(raw).background;
		recreateWindow();
	});

	// React to live edge-offset changes: store the new gap and immediately
	// re-dock the resting island so the setting visibly takes effect.
	subscribeEdgeOffsetChanges((raw) => {
		setEdgeOffset(parseEdgeOffset(raw));
		if (islandWindow && !islandWindow.isDestroyed()) {
			applyEdgeOffset(islandWindow);
		}
	});

	// Command-summon + push-to-talk global shortcuts. Read both saved values
	// first, then register the summon accelerator (which reconciles push-to-talk
	// against it), and keep both in sync with the desktop's Island settings
	// (re-register on change). The command summon always wins a collision.
	const [voiceRaw, dictationRaw, commandShortcutRaw] = await Promise.all([
		getVoicePrefsRaw(),
		getPreferenceRaw(DICTATION_PREF_KEY),
		getPreferenceRaw(COMMAND_SHORTCUT_PREF_KEY),
	]);
	lastVoiceRaw = voiceRaw;
	lastDictationRaw = dictationRaw;
	// Tab-cycling belongs to voice input; point the shared key hook at it once.
	setTabCycle("voice", sendCycleAgent);
	applyCommandShortcut(commandShortcutRaw);
	// Live changes to an Island-owned chord go through `rebindReserved`: plugin
	// chords are released first (so the Island chord can claim one a plugin held),
	// then re-applied against the new reserved set (so a chord the Island gave up
	// goes straight back to its plugin).
	subscribePreferenceChanges(COMMAND_SHORTCUT_PREF_KEY, (raw) =>
		applyPluginShortcuts.rebindReserved(() => applyCommandShortcut(raw))
	);
	subscribeVoiceChanges((raw) => {
		applyPluginShortcuts.rebindReserved(() => {
			lastVoiceRaw = raw;
			applyVoicePrefs(raw);
			// Dictation defers to the voice shortcut, so re-reconcile it whenever
			// voice rebinds (its slot may have freed up or newly collided).
			applyDictationPrefs(lastDictationRaw);
		});
	});
	// Dictation shortcut: bind it now (command + voice were reconciled above) and
	// keep it in sync with its preference.
	applyDictationPrefs(lastDictationRaw);
	subscribePreferenceChanges(DICTATION_PREF_KEY, (raw) => {
		applyPluginShortcuts.rebindReserved(() => {
			lastDictationRaw = raw;
			applyDictationPrefs(raw);
		});
	});
	// Plugin chords follow Core: the first read, every saved-shortcut change, a
	// switch to another Core (different plugins and saved shortcuts), and the
	// refresh's own idle poll for plugins enabled or disabled in Core.
	// Subscribed before the first read so a change that lands while it is in
	// flight supersedes it instead of being lost.
	subscribePreferenceChanges("keybindings", () => {
		applyPluginShortcuts().catch(() => undefined);
	});
	onCoreConfigChange(() => {
		applyPluginShortcuts().catch(() => undefined);
	});
	await applyPluginShortcuts();

	// The renderer owns the recording lifecycle (it drives the mic + waveform), so
	// it reports start/stop here. The main process uses it to arm the global key
	// hook (hold-to-talk release + Tab agent-cycling) only while capture is active.
	ipcMain.on(IPC.voice.recordingState, (_event, active: boolean) => {
		setRecording("voice", active === true);
	});

	// Same for dictation / agent-ask capture, so the shared key hook arms for the
	// matching hold-to-talk release only while that mode is recording.
	ipcMain.on(
		IPC.dictation.recordingState,
		(_event, active: boolean, task?: string) => {
			const channel = task === "ask" ? "dictation-ask" : "dictation";
			setRecording(channel, active === true);
		}
	);

	// Two-way consent sync with Core's `island-consent` preference so the desktop
	// app can edit the privacy toggles (the island's own Settings tab was removed).
	// The island stays the locally authoritative hard gate; this only mirrors state
	// across the two processes. `lastConsentSync` (the serialized blob last seen in
	// either direction) breaks the echo loop: a write we just made comes back over
	// SSE and is skipped, and a desktop change we just applied does not re-push.
	let lastConsentSync: string | null = null;
	const mirrorConsentToCore = (state: ConsentState): void => {
		const json = serializeConsent(state);
		if (json === lastConsentSync) {
			return;
		}
		lastConsentSync = json;
		setPreferenceRaw(ISLAND_CONSENT_PREF_KEY, json).catch(() => undefined);
	};
	const applyConsentFromCore = (raw: string | null): void => {
		if (raw === null) {
			return;
		}
		const json = serializeConsent(parseConsent(raw));
		if (json === lastConsentSync) {
			return;
		}
		lastConsentSync = json;
		applyConsentState(parseConsent(json));
	};
	// Seed: adopt Core's value if the desktop already set one, else publish the
	// island's current local consent so the desktop sees a populated blob.
	//
	// Read-once-then-subscribe (the same pattern every island pref uses). Accepted
	// edge: if Core is unreachable at launch AND the desktop revoked a capability
	// while the island was off, this initial GET fails and the island falls back to
	// its locally-persisted (possibly granted) value until the next live change —
	// i.e. the gate fails to the LOCAL prior grant for that session, not to Core's
	// newer revocation. Tolerable because the local value is itself a prior explicit
	// user grant on a device-bound sensor; revisit with a re-GET on SSE reconnect if
	// a stricter fail-closed contract is ever required.
	const initialConsentRaw = await getPreferenceRaw(ISLAND_CONSENT_PREF_KEY);
	if (initialConsentRaw === null) {
		mirrorConsentToCore(getConsent());
	} else {
		applyConsentFromCore(initialConsentRaw);
	}
	onConsentChanged(mirrorConsentToCore);
	subscribePreferenceChanges(ISLAND_CONSENT_PREF_KEY, applyConsentFromCore);

	app.on("activate", () => {
		// A rebuild in flight attaches its own window when the old one closes. The
		// closed window destroyed its snap-zone overlay, so build a new one too.
		if (!recreating && BrowserWindow.getAllWindows().length === 0) {
			attachWindow(requestedBackground);
			initZoneOverlay();
		}
	});
}

// Single-instance lock: a second launch focuses the existing island instead of
// spawning a duplicate overlay.
const gotLock = app.requestSingleInstanceLock();
if (gotLock) {
	app.on("second-instance", () => showWindow());
	app.whenReady().then(bootstrap);
} else {
	app.quit();
}

app.on("before-quit", () => {
	quitting = true;
});

app.on("will-quit", () => {
	// Stop plugin-shortcut retries first so no late snapshot re-registers a chord.
	applyPluginShortcuts.dispose();
	globalShortcut.unregisterAll();
	stopHooks();
	stopControlServer();
	destroyGhostCursor();
	destroyScreenSurface();
});

app.on("window-all-closed", () => {
	// Ignore the brief zero-window window during an appearance recreation.
	if (recreating) {
		return;
	}
	if (process.platform !== "darwin") {
		app.quit();
	}
});
