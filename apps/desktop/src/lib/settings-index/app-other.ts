// App dialog: Settings sync, Keyboard, Updates, Voice, Developer, Account rows of the settings search index. The index, its contract and
// its coverage notes live in `../settings-index.ts`; this file only holds rows.

import type { SettingsEntry } from "../settings-index.ts";

export const APP_OTHER_SETTINGS_ENTRIES: SettingsEntry[] = [
	// --- Settings sync ---
	{
		id: "sync.settings-sync.sync-my-settings-across-machines",
		dialog: "app",
		section: "sync",
		group: "Settings Sync",
		label: "Sync My Settings Across Machines",
		keywords: "sync cloud devices machines follow me backup settings sync",
	},
	{
		id: "sync.conflict-handling",
		dialog: "app",
		section: "sync",
		group: "When The Same Setting Changed In Two Places",
		label: "Conflict Handling",
		keywords: "conflict ask download upload newer cloud copy",
	},
	{
		id: "sync.last-sync",
		dialog: "app",
		section: "sync",
		group: "Settings Sync",
		label: "Last Sync",
		keywords: "sync now pending upload status",
	},
	{
		id: "sync.delete-cloud-copy",
		dialog: "app",
		section: "sync",
		group: "Cloud Copy",
		label: "Delete My Synced Settings",
		keywords: "delete forget cloud copy remove synced",
	},

	// --- Keyboard shortcuts (rendered from the hotkey registry, not rows) ---
	{
		id: "keyboard.shortcuts",
		dialog: "app",
		section: "keyboard",
		group: "",
		label: "Keyboard Shortcuts",
		keywords: "hotkey keybinding chord rebind accelerator shortcut keys",
	},
	{
		id: "keyboard.global",
		dialog: "app",
		section: "keyboard",
		group: "Global",
		label: "Global Shortcuts",
		keywords: "system wide os accelerator island push to talk",
		desktopOnly: true,
	},

	// --- Updates (this desktop client) ---
	{
		id: "updates.automatic-updates",
		dialog: "app",
		section: "updates",
		group: "",
		label: "Download updates automatically",
		keywords:
			"auto update version upgrade background download ready install restart",
		desktopOnly: true,
	},
	{
		id: "updates.check-for-updates",
		dialog: "app",
		section: "updates",
		group: "",
		label: "Check for updates",
		keywords: "version new release upgrade",
		desktopOnly: true,
	},
	{
		id: "updates.extend-updates",
		dialog: "app",
		section: "updates",
		group: "",
		label: "Extend updates",
		keywords: "updates window licence license renew",
		desktopOnly: true,
	},

	// --- Voice ---
	{
		id: "voice.audio-devices.default-microphone",
		dialog: "app",
		section: "voice",
		group: "Audio devices",
		label: "Default microphone",
		keywords: "mic input device recording",
	},
	{
		id: "voice.audio-devices.default-speaker",
		dialog: "app",
		section: "voice",
		group: "Audio devices",
		label: "Default speaker",
		keywords: "output playback headphones",
	},
	{
		id: "voice.voice-mode-display.show-transcript-in-voice-mode",
		dialog: "app",
		section: "voice",
		group: "Voice mode display",
		label: "Show transcript in voice mode",
	},
	{
		id: "voice.voice-input.model",
		dialog: "app",
		section: "voice",
		group: "Voice Recognition",
		label: "Model",
		keywords: "stt speech to text whisper parakeet dictation",
	},
	{
		id: "voice.read-back-responses.always-read-back-responses",
		dialog: "app",
		section: "voice",
		group: "Read back responses",
		label: "Always read back responses",
		keywords: "tts speak aloud readback",
	},
	{
		id: "voice.text-to-speech.engine",
		dialog: "app",
		section: "voice",
		group: "Audio",
		label: "Audio engine",
		keywords: "tts kokoro voice synthesis",
	},
	{
		id: "voice.text-to-speech.voice",
		dialog: "app",
		section: "voice",
		group: "Audio",
		label: "Voice",
		keywords: "tts speaker preset",
	},

	// --- Developer ---
	{
		id: "developer.developer-mode.enable-developer-mode",
		dialog: "app",
		section: "developer",
		group: "Developer Mode",
		label: "Enable developer mode",
		keywords: "debug dev tools troubleshooting diagnostics",
	},
	{
		id: "developer.agentation-toolbar.toolbar-active",
		dialog: "app",
		section: "developer",
		group: "Agentation toolbar",
		label: "Toolbar active",
		keywords: "annotate screenshot markup",
	},
	{
		id: "developer.console-capture.console-buffer-status",
		dialog: "app",
		section: "developer",
		group: "Console capture",
		label: "Console buffer status",
		keywords: "logs console errors ring buffer",
	},
	{
		id: "developer.performance.chat-turns",
		dialog: "app",
		section: "developer",
		group: "Performance",
		label: "Chat turns",
		keywords:
			"timing latency slow ttft first token performance metrics profiling troubleshoot",
	},
	{
		id: "developer.diagnostics.collect-copy-diagnostics",
		dialog: "app",
		section: "developer",
		group: "Diagnostics",
		label: "Collect & copy diagnostics",
		keywords: "support bug report logs export",
	},
	{
		id: "developer.diagnostics.copy-console-output",
		dialog: "app",
		section: "developer",
		group: "Diagnostics",
		label: "Copy console output",
	},
	{
		// Rendered only on canary/nightly builds, but indexed unconditionally: the
		// index is a static list and the search is how a user finds the switch that
		// turns a destructive setting back OFF.
		id: "developer.daily-data-reset.wipe-this-data-folder-at-midnight",
		dialog: "app",
		section: "developer",
		group: "Daily data reset",
		label: "Wipe this data folder at midnight",
		keywords:
			"canary nightly wipe clear erase fresh install daily reset data folder",
	},

	// --- Account / sessions ---
	{
		id: "account.sign-in-security.email-address",
		dialog: "app",
		section: "account",
		group: "Sign-in & security",
		label: "Email address",
	},
	{
		id: "account.sign-in-security.password",
		dialog: "app",
		section: "account",
		group: "Sign-in & security",
		label: "Password",
		keywords: "change password credentials",
	},
	{
		id: "account.sign-in-security.user-id",
		dialog: "app",
		section: "account",
		group: "Sign-in & security",
		label: "User ID",
	},
	{
		id: "sessions.active-sessions",
		dialog: "app",
		section: "sessions",
		group: "",
		label: "Active sessions",
		keywords: "sign out revoke devices logged in",
	},
];
