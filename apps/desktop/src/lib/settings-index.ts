// A searchable index of individual settings — the rows, not the tabs.
//
// The search box in either settings dialog used to filter the NAV: you typed
// "dark" and it told you which of nineteen tabs was called something like that.
// That is useless for the actual question ("where is the thing that turns the
// theme dark"), because the answer is a ROW inside a tab, and rows were not
// indexed anywhere.
//
// This module is that index. Each entry names one setting: its visible label,
// the group header above it, the dialog + section that renders it, and optional
// `keywords` carrying the words a user would plausibly type but that do not
// appear in the label ("dark mode" for "Theme mode", "hotkey" for a shortcut).
//
// WHY A DECLARED LIST AND NOT RUNTIME DISCOVERY: walking the rendered DOM would
// only ever see the section that happens to be mounted, so search would silently
// miss every setting the user is not already looking at. A declared list is the
// only form that can answer "where is X" for an X you have never opened.
//
// KEEPING IT HONEST: `settings-index.test.ts` re-reads the settings source files
// and asserts every indexed label still exists in the file that owns its
// section. Rename a row and the test names the stale entry. It also reports —
// but does not fail on — labels present in source and missing here, because some
// rows are readouts (a metric, a status line) and are deliberately not indexed.
//
// COVERAGE (stated plainly rather than implied):
//   - ROW-LEVEL: General, Appearance, Developer, Account, Voice (App dialog);
//     Privacy, Storage, Encryption, Danger zone, Network, Integrations,
//     Connections, Routing, Budgets, Updates (Gateway dialog).
//   - GROUP-LEVEL only: Keys, Guardrails, Providers, Workspace, Defaults, Usage,
//     Audit, Evals, Permissions, Access, Email alerts — these render bespoke
//     cards (key vaults, provider grids, permission matrices) whose "rows" are
//     data, not settings. They are indexed by their group name so a search still
//     lands you on the right pane.
//   - NOT INDEXED: per-app / per-plugin settings tabs (`app:<id>` /
//     `plugin:<id>`). Those are contributed at runtime by manifests, so they
//     cannot be in a static list; both dialogs already match them by label.

/** Which of the two settings dialogs owns a setting. */
export type SettingsDialogId = "app" | "gateway";

export interface SettingsEntry {
	/** Hidden outside the native desktop shell. */
	desktopOnly?: boolean;
	/** Which dialog renders it — decides where a result click navigates. */
	dialog: SettingsDialogId;
	/** The `SettingsSection` header above the row. Empty for ungrouped rows. */
	group: string;
	/** Stable id. Used for the focus handoff and as a React key. */
	id: string;
	/** Extra search terms not present in the label. Space-separated. */
	keywords?: string;
	/** The row's visible title, verbatim — this is also the DOM anchor. */
	label: string;
	/** The dialog section value (`general`, `appearance`, `routing`, …). */
	section: string;
	/**
	 * The sub-page inside that section, for a pane that drills in
	 * ({@link SettingsSubpages}) instead of scrolling. Load-bearing for search: a
	 * row inside a closed sub-page is not in the DOM, and the reveal gives up
	 * after two seconds of polling — so without this a hit would land on the
	 * section and highlight nothing.
	 *
	 * Most entries leave it unset and let {@link subpageFor} derive it from the
	 * group, which is the same partition the pane itself uses.
	 */
	subpage?: string;
}

/**
 * Section → group → sub-page id, for the panes that drill in rather than scroll.
 *
 * Each split follows that pane's `SettingsSection` groups exactly, so the
 * mapping is stated once here rather than stamped onto a hundred entries by
 * hand. A group missing from its section's map (Appearance's Theme, General's
 * "On startup") stays on the pane's own index page, which is where a pane's
 * headline settings belong.
 */
const SUBPAGE_BY_GROUP: Record<string, Record<string, string>> = {
	appearance: {
		"Language & vibe": "language",
		"Layout & sizing": "layout",
		Typography: "layout",
		Motion: "motion",
		"Seasonal effects": "motion",
		Interface: "interface",
		Chat: "chat",
		"Usage meter": "usage",
		"Diff viewer": "diff",
		"File tree": "files",
		Reset: "reset",
	},
	// Not 1:1 with the sections here: the three "what we collect" groups share
	// one page, because three rows asking the same question is a longer index,
	// not a clearer one.
	privacy: {
		"Product analytics": "sharing",
		"Community stats": "sharing",
		"Crash reports": "sharing",
		"Diagnostics export": "diagnostics",
		"Support access (local)": "diagnostics",
		"Self-healing": "healing",
	},
	general: {
		Tabs: "tabs",
		"Pane layouts": "tabs",
		Interface: "tabs",
		Chats: "chats",
		Language: "language",
		Terminal: "terminal",
		Files: "files",
		System: "system",
		Setup: "setup",
	},
};

/**
 * Which sub-page holds this setting, or null when its section is a flat scroll.
 * An explicit `subpage` on the entry wins; otherwise it is derived from the
 * group.
 */
export function subpageFor(entry: SettingsEntry): string | null {
	if (entry.subpage) {
		return entry.subpage;
	}
	return SUBPAGE_BY_GROUP[entry.section]?.[entry.group] ?? null;
}

/** Human labels for section values, so a result can say where it lives. */
export const SETTINGS_SECTION_LABELS: Record<string, string> = {
	// App dialog
	general: "General",
	appearance: "Appearance",
	keyboard: "Keyboard Shortcuts",
	updates: "Updates",
	voice: "Voice",
	developer: "Developer",
	sync: "Settings Sync",
	account: "Account",
	sessions: "Sessions & devices",
	"ryu-apps": "Ryu apps",
	"authorized-apps": "OAuth apps",
	billing: "Billing",
	referrals: "Referrals",
	teams: "Teams",
	credits: "Credits",
	// Gateway dialog
	overview: "Overview",
	workspace: "Team & workspace",
	defaults: "Default agent & model",
	providers: "AI providers",
	keys: "API keys",
	access: "Devices & access",
	permissions: "Permissions",
	budgets: "Spending limits",
	guardrails: "Safety filters",
	runtime: "Agent runtime",
	routing: "Model routing",
	integrations: "Integrations",
	network: "Network",
	connections: "Connections",
	hooks: "Hooks",
	git: "Git",
	worktrees: "Worktrees",
	environments: "Environments",
	"email-alerts": "Email & alerts",
	privacy: "Privacy",
	storage: "Storage",
	encryption: "Encryption",
	usage: "Usage & cost",
	audit: "Activity log",
	evals: "Quality tests",
	health: "Health",
	danger: "Danger zone",
};

export const SETTINGS_ENTRIES: SettingsEntry[] = [
	// ─────────────────────────── App dialog ───────────────────────────────────
	// --- General ---
	{
		id: "general.on-startup.open-with",
		dialog: "app",
		section: "general",
		group: "On startup",
		label: "Open with",
		keywords: "launch boot first screen home",
	},
	{
		id: "general.on-startup.projectless-task-folder",
		desktopOnly: true,
		dialog: "app",
		section: "general",
		group: "On startup",
		label: "Projectless task folder",
		keywords: "default cwd working directory no project task folder files",
	},
	{
		id: "general.on-startup.realm",
		desktopOnly: true,
		dialog: "app",
		section: "general",
		group: "On startup",
		label: "Realm on startup",
		keywords: "bot console os last used product mode launch",
	},
	{
		id: "general.on-startup.account-and-node-selection",
		dialog: "app",
		section: "general",
		group: "On startup",
		label: "Account and node selection",
		keywords: "login chooser account computer node defaults",
	},
	{
		id: "general.on-startup.default-account",
		dialog: "app",
		section: "general",
		group: "On startup",
		label: "Default account",
		keywords: "login profile signed in startup",
	},
	{
		id: "general.on-startup.default-node",
		dialog: "app",
		section: "general",
		group: "On startup",
		label: "Default node",
		keywords: "computer workspace server startup",
	},
	{
		id: "general.tabs.open-links-in-the-current-tab",
		dialog: "app",
		section: "general",
		group: "Tabs",
		label: "Open links in the current tab",
	},
	{
		id: "general.tabs.switch-tabs-with-ctrl-cmd-tab",
		dialog: "app",
		section: "general",
		group: "Tabs",
		label: "Switch tabs with Ctrl/Cmd+Tab",
		keywords: "mru most recently used cycle",
	},
	{
		id: "general.tabs.vertical-tabs",
		dialog: "app",
		section: "general",
		group: "Tabs",
		label: "Tab layout",
		keywords: "horizontal vertical side tab bar scroll canvas orientation",
	},
	{
		id: "general.tabs.floating-tabs",
		dialog: "app",
		section: "general",
		group: "Tabs",
		label: "Floating tabs",
		keywords: "morphing blended page surface rounded pills",
	},
	{
		id: "general.tabs.auto-hide-title-bar",
		dialog: "app",
		section: "general",
		group: "Tabs",
		label: "Auto-hide title bar",
		keywords: "titlebar chrome window frame",
	},
	{
		id: "general.tabs.fit-tabs-to-width",
		dialog: "app",
		section: "general",
		group: "Tabs",
		label: "Fit tabs to width",
	},
	{
		id: "general.tabs.unload-inactive-tabs",
		dialog: "app",
		section: "general",
		group: "Tabs",
		label: "Unload inactive tabs",
		keywords: "memory ram sleep discard performance",
	},
	{
		id: "general.tabs.per-tab-node-override",
		dialog: "app",
		section: "general",
		group: "Tabs",
		label: "Per-tab node override",
	},
	{
		id: "general.interface.bottom-panel",
		dialog: "app",
		section: "general",
		group: "Interface",
		label: "Bottom panel",
		keywords: "show header control dock terminal panel toggle",
	},
	{
		id: "general.tabs.split-layout-presets",
		dialog: "app",
		section: "general",
		group: "Pane layouts",
		label: "Pane layout presets",
		keywords: "split view panes layout preset arrangement save equalize",
	},
	{
		id: "general.chats.auto-import-agent-threads",
		dialog: "app",
		section: "general",
		group: "Chats",
		label: "Auto-import agent threads",
		keywords: "claude codex acp history import",
	},
	{
		id: "general.chats.send-shortcut",
		desktopOnly: true,
		dialog: "app",
		section: "general",
		group: "Chats",
		label: "Send shortcut",
		keywords: "send enter return shift command ctrl newline prompt composer",
	},
	{
		id: "general.chats.queued-messages-send",
		dialog: "app",
		section: "general",
		group: "Chats",
		label: "Queued messages send",
	},
	{
		id: "general.chats.composer-selection-changes",
		dialog: "app",
		section: "general",
		group: "Chats",
		label: "Composer selection changes",
		keywords: "agent model effort next turn next user message",
	},
	{
		id: "general.language",
		dialog: "app",
		section: "general",
		group: "Language",
		label: "Language",
		keywords: "locale translation auto detect language pack",
		subpage: "language",
	},
	{
		id: "general.terminal.terminal-shell",
		dialog: "app",
		section: "general",
		group: "Terminal",
		label: "Default shell",
		keywords: "terminal zsh bash fish powershell cmd os system",
		desktopOnly: true,
	},
	{
		id: "general.terminal.panel-location",
		dialog: "app",
		section: "general",
		group: "Terminal",
		label: "Default terminal location",
		keywords: "bottom right dock panel environment action shortcut",
		desktopOnly: true,
	},
	{
		id: "general.files.default-file-open-destination",
		dialog: "app",
		section: "general",
		group: "Files",
		label: "Default file open destination",
		keywords: "open file folder editor finder explorer files vscode cursor zed",
		desktopOnly: true,
	},
	{
		id: "general.system.start-ryu-on-startup",
		dialog: "app",
		section: "general",
		group: "System",
		label: "Start Ryu on startup",
		keywords: "autostart login item boot launch",
		desktopOnly: true,
	},
	{
		id: "general.system.start-hidden",
		dialog: "app",
		section: "general",
		group: "System",
		label: "Start hidden",
		keywords: "minimized background tray",
		desktopOnly: true,
	},
	{
		id: "general.system.close-to-tray",
		dialog: "app",
		section: "general",
		group: "System",
		label: "Stay in tray on close",
		keywords: "close window quit background keep running menu bar",
		desktopOnly: true,
	},
	{
		id: "general.system.show-in-menu-bar",
		dialog: "app",
		section: "general",
		group: "System",
		label: "Show in menu bar",
		keywords: "menu bar menubar system tray status item hide icon",
		desktopOnly: true,
	},
	{
		id: "general.system.prevent-sleep-while-running",
		dialog: "app",
		section: "general",
		group: "System",
		label: "Prevent sleep while running",
		keywords: "keep awake power caffeinate systemd inhibit acp agent",
		desktopOnly: true,
	},
	{
		id: "general.setup.onboarding",
		dialog: "app",
		section: "general",
		group: "Setup",
		label: "Onboarding",
		keywords: "welcome wizard rerun setup",
	},

	// --- Appearance ---
	{
		id: "appearance.theme.color-theme",
		dialog: "app",
		section: "appearance",
		group: "Theme",
		label: "Color theme",
		keywords: "dark light mode preset accent palette scheme",
	},
	{
		id: "appearance.language",
		dialog: "app",
		section: "appearance",
		group: "Language & vibe",
		label: "Language & vibe",
		keywords: "locale translation language pack dialect vibe",
		subpage: "language",
	},
	{
		id: "appearance.custom-color",
		dialog: "app",
		section: "appearance",
		group: "Theme",
		label: "Custom color",
		keywords: "brand accent hex picker",
	},
	{
		id: "appearance.copy-a-publishable-plugin-manifest-for-this-theme",
		dialog: "app",
		section: "appearance",
		group: "Theme",
		label: "Copy a publishable plugin manifest for this theme",
		keywords: "share export theme plugin",
	},
	{
		id: "appearance.typography.ui-font",
		dialog: "app",
		section: "appearance",
		group: "Typography",
		label: "UI font",
		keywords: "typeface family",
	},
	{
		id: "appearance.typography.heading-font",
		dialog: "app",
		section: "appearance",
		group: "Typography",
		label: "Heading font",
	},
	{
		id: "appearance.typography.code-font",
		dialog: "app",
		section: "appearance",
		group: "Typography",
		label: "Code font",
		keywords: "monospace mono editor",
	},
	{
		id: "appearance.layout.scale",
		dialog: "app",
		section: "appearance",
		group: "Layout & sizing",
		label: "Scale (UI zoom)",
		keywords: "zoom size bigger smaller text size",
	},
	{
		id: "appearance.layout.zoom-spacing",
		dialog: "app",
		section: "appearance",
		group: "Layout & sizing",
		label: "Zoom (spacing)",
		keywords: "density compact spacing",
	},
	{
		id: "appearance.layout.roundness",
		dialog: "app",
		section: "appearance",
		group: "Layout & sizing",
		label: "Roundness",
		keywords: "corner radius rounded",
	},
	{
		id: "appearance.layout.card-padding",
		dialog: "app",
		section: "appearance",
		group: "Layout & sizing",
		label: "Card padding",
	},
	{
		id: "appearance.layout.muted-contrast",
		dialog: "app",
		section: "appearance",
		group: "Layout & sizing",
		label: "Muted contrast",
		keywords: "contrast readability accessibility",
	},
	{
		id: "appearance.layout.chat-width",
		dialog: "app",
		section: "appearance",
		group: "Layout & sizing",
		label: "Chat width",
		keywords: "message width reading measure",
	},
	{
		id: "appearance.layout.sidebar-width",
		dialog: "app",
		section: "appearance",
		group: "Layout & sizing",
		label: "Sidebar width",
	},
	{
		id: "appearance.motion.enable-animations",
		dialog: "app",
		section: "appearance",
		group: "Motion",
		label: "Enable animations",
		keywords: "reduce motion transitions",
	},
	{
		id: "appearance.motion.animate-streaming-chat-text",
		dialog: "app",
		section: "appearance",
		group: "Motion",
		label: "Animate streaming chat text",
		keywords: "blur fade word by word streamdown",
	},
	{
		id: "appearance.seasonal.effects",
		dialog: "app",
		section: "appearance",
		group: "Seasonal effects",
		label: "Seasonal effects",
		keywords: "snow snowfall christmas halloween holiday confetti festive",
	},
	{
		id: "appearance.seasonal.season",
		dialog: "app",
		section: "appearance",
		group: "Seasonal effects",
		label: "Season",
		keywords:
			"snow christmas halloween valentine easter lunar new year st patrick preview",
	},
	{
		id: "appearance.interface.friendly-names",
		dialog: "app",
		section: "appearance",
		group: "Interface",
		label: "Friendly names",
		keywords: "jargon plain english model names",
	},
	{
		id: "appearance.interface.bot-terminology",
		dialog: "app",
		section: "appearance",
		group: "Interface",
		label: "Use Bot terminology",
		keywords: "agent agents bot bots simple vocabulary language",
	},
	{
		id: "appearance.interface.pointer-cursor",
		dialog: "app",
		section: "appearance",
		group: "Interface",
		label: "Pointer cursor",
	},
	{
		id: "appearance.interface.navigation-sidebar-shadows",
		dialog: "app",
		section: "appearance",
		group: "Interface",
		label: "Navigation & sidebar shadows",
	},
	{
		id: "appearance.interface.blur-dialog-backgrounds",
		dialog: "app",
		section: "appearance",
		group: "Interface",
		label: "Blur dialog backgrounds",
		keywords: "backdrop glass vibrancy",
	},
	{
		id: "appearance.interface.invert-overlay-backgrounds",
		dialog: "app",
		section: "appearance",
		group: "Interface",
		label: "Invert overlay backgrounds",
	},
	{
		id: "appearance.interface.tabbed-sidebar",
		dialog: "app",
		section: "appearance",
		group: "Interface",
		label: "Tabbed sidebar",
	},
	{
		id: "appearance.interface.group-chats-by-date",
		dialog: "app",
		section: "appearance",
		group: "Interface",
		label: "Group lists by date",
		keywords: "chats projects spaces pages uploads buckets today yesterday",
	},
	{
		id: "appearance.interface.sidebar-grouped-nav",
		dialog: "app",
		section: "appearance",
		group: "Interface",
		label: "Projects & Spaces as pickers",
		keywords: "sidebar picker select all projects all spaces declutter",
	},
	{
		id: "appearance.interface.inset-sidebar",
		dialog: "app",
		section: "appearance",
		group: "Interface",
		label: "Inset sidebar",
	},
	{
		id: "appearance.interface.messaging-style-agent-rows",
		dialog: "app",
		section: "appearance",
		group: "Interface",
		label: "Messaging-style agent rows",
		keywords: "whatsapp avatar preview sidebar rows",
	},
	{
		id: "appearance.interface.show-chat-activity-in-sidebar",
		dialog: "app",
		section: "appearance",
		group: "Interface",
		label: "Show chat activity in sidebar",
		keywords: "latest message tool call status two line rows preview",
	},
	{
		id: "appearance.interface.chat-model-and-agent-picker-placement",
		dialog: "app",
		section: "appearance",
		group: "Interface",
		label: "Chat model and agent picker placement",
		keywords: "composer tab bar actions tray model agent picker",
	},
	{
		id: "appearance.interface.search-overflow-in-a-popover",
		dialog: "app",
		section: "appearance",
		group: "Interface",
		label: "Search overflow in a popover",
	},
	{
		id: "appearance.interface.show-tabs-as-a-dropdown",
		dialog: "app",
		section: "appearance",
		group: "Interface",
		label: "Show tabs as a dropdown",
		keywords: "open tabs searchable tab strip title bar switcher",
	},
	{
		id: "appearance.interface.show-tab-search-button",
		dialog: "app",
		section: "appearance",
		group: "Interface",
		label: "Show tab search button",
		keywords: "open tabs chevron tab list search switch close",
	},
	{
		id: "appearance.interface.notification-layout",
		dialog: "app",
		section: "appearance",
		group: "Interface",
		label: "Notification layout",
		keywords:
			"announcements inbox notifications tray unified grouped split stack",
	},
	{
		id: "appearance.chat.detail-level",
		dialog: "app",
		section: "appearance",
		group: "Chat",
		label: "Detail level",
		// "none" and its synonyms live here rather than as their own row: a
		// search result reading just "None" says nothing, and the row a user
		// wants when they search "hide tool calls" is this ladder.
		keywords:
			"verbosity compact none hide tool calls file edits messaging plain",
	},
	{
		id: "appearance.chat.group-tool-uses",
		dialog: "app",
		section: "appearance",
		group: "Chat",
		label: "Group tool uses",
	},
	{
		id: "appearance.chat.show-file-edits-expanded",
		dialog: "app",
		section: "appearance",
		group: "Chat",
		label: "Show file edits expanded",
		keywords: "diff collapse",
	},
	{
		id: "appearance.chat.auto-expand-commands",
		dialog: "app",
		section: "appearance",
		group: "Chat",
		label: "Auto-expand commands",
	},
	{
		id: "appearance.chat.expand-code-blocks",
		dialog: "app",
		section: "appearance",
		group: "Chat",
		label: "Expand code blocks",
	},
	{
		id: "appearance.chat.pin-user-message-while-scrolling",
		dialog: "app",
		section: "appearance",
		group: "Chat",
		label: "Pin user message while scrolling",
		keywords: "sticky header scroll",
	},
	{
		id: "appearance.chat.open-chats-at-the-latest-message",
		dialog: "app",
		section: "appearance",
		group: "Chat",
		label: "Open chats at the latest message",
		keywords: "scroll bottom restore position",
	},
	{
		id: "appearance.usage-meter.show-usage-meter",
		dialog: "app",
		section: "appearance",
		group: "Usage meter",
		label: "Show usage meter",
		keywords: "quota credits limit bar",
	},
	{
		id: "appearance.usage-meter.show-in-sidebar",
		dialog: "app",
		section: "appearance",
		group: "Usage meter",
		label: "Show in sidebar",
	},
	{
		id: "appearance.usage-meter.show-progress-bar",
		dialog: "app",
		section: "appearance",
		group: "Usage meter",
		label: "Show progress bar",
	},
	{
		id: "appearance.usage-meter.circular-progress-ring",
		dialog: "app",
		section: "appearance",
		group: "Usage meter",
		label: "Circular progress ring",
	},
	{
		id: "appearance.usage-meter.show-percentage",
		dialog: "app",
		section: "appearance",
		group: "Usage meter",
		label: "Show percentage",
	},
	{
		id: "appearance.usage-meter.show-remaining-instead-of-used",
		dialog: "app",
		section: "appearance",
		group: "Usage meter",
		label: "Show remaining instead of used",
	},
	{
		id: "appearance.diff-viewer.layout",
		dialog: "app",
		section: "appearance",
		group: "Diff viewer",
		label: "Layout",
		keywords: "split unified side by side",
	},
	{
		id: "appearance.diff-viewer.theme-mode",
		dialog: "app",
		section: "appearance",
		group: "Diff viewer",
		label: "Theme mode",
	},
	{
		id: "appearance.diff-viewer.light-theme",
		dialog: "app",
		section: "appearance",
		group: "Diff viewer",
		label: "Light theme",
	},
	{
		id: "appearance.diff-viewer.dark-theme",
		dialog: "app",
		section: "appearance",
		group: "Diff viewer",
		label: "Dark theme",
	},
	{
		id: "appearance.diff-viewer.change-markers",
		dialog: "app",
		section: "appearance",
		group: "Diff viewer",
		label: "Change markers",
	},
	{
		id: "appearance.diff-viewer.inline-highlighting",
		dialog: "app",
		section: "appearance",
		group: "Diff viewer",
		label: "Inline highlighting",
	},
	{
		id: "appearance.diff-viewer.hunk-separators",
		dialog: "app",
		section: "appearance",
		group: "Diff viewer",
		label: "Hunk separators",
	},
	{
		id: "appearance.diff-viewer.line-backgrounds",
		dialog: "app",
		section: "appearance",
		group: "Diff viewer",
		label: "Line backgrounds",
	},
	{
		id: "appearance.diff-viewer.line-numbers",
		dialog: "app",
		section: "appearance",
		group: "Diff viewer",
		label: "Line numbers",
	},
	{
		id: "appearance.diff-viewer.wrap-long-lines",
		dialog: "app",
		section: "appearance",
		group: "Diff viewer",
		label: "Wrap long lines",
		keywords: "word wrap soft wrap",
	},
	{
		id: "appearance.diff-viewer.expand-unchanged-context",
		dialog: "app",
		section: "appearance",
		group: "Diff viewer",
		label: "Expand unchanged context",
	},
	{
		id: "appearance.file-tree.density",
		dialog: "app",
		section: "appearance",
		group: "File tree",
		label: "Density",
	},
	{
		id: "appearance.file-tree.light-theme",
		dialog: "app",
		section: "appearance",
		group: "File tree",
		label: "Light theme",
	},
	{
		id: "appearance.file-tree.dark-theme",
		dialog: "app",
		section: "appearance",
		group: "File tree",
		label: "Dark theme",
	},
	{
		id: "appearance.file-tree.icons",
		dialog: "app",
		section: "appearance",
		group: "File tree",
		label: "Icons",
	},
	{
		id: "appearance.file-tree.search-mode",
		dialog: "app",
		section: "appearance",
		group: "File tree",
		label: "Search mode",
	},
	{
		id: "appearance.file-tree.initial-state",
		dialog: "app",
		section: "appearance",
		group: "File tree",
		label: "Initial state",
	},
	{
		id: "appearance.file-tree.colored-icons",
		dialog: "app",
		section: "appearance",
		group: "File tree",
		label: "Colored icons",
	},
	{
		id: "appearance.file-tree.sticky-folders",
		dialog: "app",
		section: "appearance",
		group: "File tree",
		label: "Sticky folders",
	},
	{
		id: "appearance.file-tree.search-box",
		dialog: "app",
		section: "appearance",
		group: "File tree",
		label: "Search box",
	},
	{
		id: "appearance.file-tree.flatten-empty-directories",
		dialog: "app",
		section: "appearance",
		group: "File tree",
		label: "Flatten empty directories",
	},
	{
		id: "appearance.file-tree.drag-and-drop",
		dialog: "app",
		section: "appearance",
		group: "File tree",
		label: "Drag and drop",
	},
	{
		id: "appearance.file-tree.inline-rename",
		dialog: "app",
		section: "appearance",
		group: "File tree",
		label: "Inline rename",
	},
	{
		id: "appearance.reset.reset-appearance",
		dialog: "app",
		section: "appearance",
		group: "Reset",
		label: "Reset appearance",
		keywords: "defaults restore",
	},

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

	// ───────────────────────── Gateway dialog ─────────────────────────────────
	{
		id: "gw.connections.cross-device-sync.sync-my-conversations-across-devices",
		dialog: "gateway",
		section: "connections",
		group: "Cross-device sync",
		label: "Sync my chats and Spaces across devices",
		keywords: "sync chats spaces pages documents cloud devices",
	},
	{
		id: "gw.privacy.product-analytics.share-anonymous-usage-analytics",
		dialog: "gateway",
		section: "privacy",
		group: "Product analytics",
		label: "Share anonymous usage analytics",
		keywords: "telemetry tracking opt out",
	},
	{
		id: "gw.privacy.product-analytics.what-we-send",
		dialog: "gateway",
		section: "privacy",
		group: "Product analytics",
		label: "What we send",
	},
	{
		id: "gw.privacy.community-stats.share-anonymous-community-stats",
		dialog: "gateway",
		section: "privacy",
		group: "Community stats",
		label: "Share anonymous community stats",
	},
	{
		id: "gw.privacy.crash-reports.send-crash-and-error-reports",
		dialog: "gateway",
		section: "privacy",
		group: "Crash reports",
		label: "Send crash and error reports",
		keywords: "sentry telemetry crashes",
	},
	{
		id: "gw.privacy.diagnostics-export.export-local-diagnostics-over-otlp",
		dialog: "gateway",
		section: "privacy",
		group: "Diagnostics export",
		label: "Export local diagnostics over OTLP",
		keywords: "opentelemetry traces metrics axiom",
	},
	{
		id: "gw.privacy.support-access-local.grant-local-support-access",
		dialog: "gateway",
		section: "privacy",
		group: "Support access (local)",
		label: "Grant local support access",
	},
	{
		id: "gw.privacy.support-access-local.access-duration",
		dialog: "gateway",
		section: "privacy",
		group: "Support access (local)",
		label: "Access duration",
	},
	{
		id: "gw.privacy.self-healing.diagnose-failed-runs",
		dialog: "gateway",
		section: "privacy",
		group: "Self-healing",
		label: "Diagnose failed runs",
	},
	{
		id: "gw.privacy.self-healing.auto-fix-without-asking",
		dialog: "gateway",
		section: "privacy",
		group: "Self-healing",
		label: "Auto-fix without asking",
	},
	{
		id: "gw.storage.upload-limits.maximum-file-you-can-upload",
		dialog: "gateway",
		section: "storage",
		group: "Upload limits",
		label: "Maximum file you can upload",
		keywords: "upload size limit attachment",
	},
	{
		id: "gw.storage.data-folder.current-location",
		dialog: "gateway",
		section: "storage",
		group: "Data folder",
		label: "Current location",
		keywords: "path directory where data lives",
	},
	{
		id: "gw.storage.data-folder.size",
		dialog: "gateway",
		section: "storage",
		group: "Data folder",
		label: "Size",
		keywords: "disk usage space",
	},
	{
		id: "gw.storage.data-folder.default-location",
		dialog: "gateway",
		section: "storage",
		group: "Data folder",
		label: "Default location",
	},
	{
		id: "gw.storage.backup-restore.export-backup",
		dialog: "gateway",
		section: "storage",
		group: "Backup & restore",
		label: "Export backup",
		desktopOnly: true,
	},
	{
		id: "gw.storage.backup-restore.restore-backup",
		dialog: "gateway",
		section: "storage",
		group: "Backup & restore",
		label: "Restore backup",
		desktopOnly: true,
	},
	{
		id: "gw.encryption.encryption-key.keychain-entry",
		dialog: "gateway",
		section: "encryption",
		group: "Encryption key",
		label: "Keychain entry",
	},
	{
		id: "gw.encryption.encryption-key.provided-by",
		dialog: "gateway",
		section: "encryption",
		group: "Encryption key",
		label: "Provided by",
	},
	{
		id: "gw.encryption.encryption-key.key-file",
		dialog: "gateway",
		section: "encryption",
		group: "Encryption key",
		label: "Key file",
	},
	{
		id: "gw.encryption.data-folder.location",
		dialog: "gateway",
		section: "encryption",
		group: "Data folder",
		label: "Location",
	},
	{
		id: "gw.updates.release-channel.channel",
		dialog: "gateway",
		section: "updates",
		group: "Release channel",
		label: "Channel",
		keywords: "stable beta nightly release preview",
	},
	{
		id: "gw.danger.reset-node.reset-node-to-a-fresh-state",
		dialog: "gateway",
		section: "danger",
		group: "Reset node",
		label: "Reset node to a fresh state",
		keywords: "wipe factory reset erase",
	},
	{
		id: "gw.danger.deep-clean.run-deep-clean",
		dialog: "gateway",
		section: "danger",
		group: "Deep clean",
		label: "Run deep clean",
		desktopOnly: true,
	},
	{
		id: "gw.integrations.artificial-analysis.live-data",
		dialog: "gateway",
		section: "integrations",
		group: "Artificial Analysis",
		label: "Live data",
	},
	{
		id: "gw.integrations.webhook-ingress.ingress-backend",
		dialog: "gateway",
		section: "integrations",
		group: "Webhook ingress",
		label: "Ingress backend",
		keywords: "webhook relay composio",
	},
	{
		id: "gw.network.mesh.enable-mesh",
		dialog: "gateway",
		section: "network",
		group: "Network (Tailscale / Headscale / Tailcat)",
		label: "Enable private network",
		keywords: "tailscale headscale tailcat vpn tailnet remote",
	},
	{
		id: "gw.network.mesh.status",
		dialog: "gateway",
		section: "network",
		group: "Network (Tailscale / Headscale / Tailcat)",
		label: "Status",
	},
	{
		id: "gw.routing.smart-routing.enable-smart-routing",
		dialog: "gateway",
		section: "routing",
		group: "Smart routing",
		label: "Enable smart routing",
		keywords: "route model auto pick cheaper",
	},
	{
		id: "gw.routing.smart-routing.similarity-threshold",
		dialog: "gateway",
		section: "routing",
		group: "Smart routing",
		label: "Similarity threshold",
	},
	{
		id: "gw.routing.model-mapping",
		dialog: "gateway",
		section: "routing",
		group: "Add model mapping",
		label: "Edit model mapping",
		keywords: "rewrite alias model map fallback",
	},
	{
		id: "gw.budgets.per-user",
		dialog: "gateway",
		section: "budgets",
		group: "Budgets",
		label: "Per-user",
		keywords: "budget spend cap limit",
	},
	{
		id: "gw.budgets.per-agent",
		dialog: "gateway",
		section: "budgets",
		group: "Budgets",
		label: "Per-agent",
		keywords: "budget spend cap limit",
	},
	{
		id: "gw.runtime.acp-session-lifetime",
		dialog: "gateway",
		section: "runtime",
		group: "ACP agent runtime",
		label: "Stop idle ACP sessions after",
		keywords: "acp idle timeout garbage collect memory thread process",
	},
	{
		id: "gw.runtime.max-parallel-agents",
		dialog: "gateway",
		section: "runtime",
		group: "ACP agent runtime",
		label: "Maximum parallel ACP agents",
		keywords: "acp concurrency parallel auto cpu ram oom memory limit",
	},
	{
		id: "gw.runtime.keep-computer-awake",
		dialog: "gateway",
		section: "runtime",
		group: "ACP agent runtime",
		label: "Keep this device awake while agents run",
		keywords: "acp sleep power caffeinate systemd inhibit battery",
	},
	{
		id: "gw.hooks.lifecycle",
		dialog: "gateway",
		section: "hooks",
		group: "Hooks",
		label: "Lifecycle hooks",
		keywords: "trust review plugin config automation enable disable",
	},
	{
		id: "gw.git.defaults",
		dialog: "gateway",
		section: "git",
		group: "Git",
		label: "Git defaults",
		keywords: "branch prefix merge squash force push draft pull request",
	},
	{
		id: "gw.worktrees.defaults",
		dialog: "gateway",
		section: "worktrees",
		group: "Worktrees",
		label: "Worktree defaults",
		keywords: "root fetch upstream cleanup retention auto delete",
	},
	{
		id: "gw.environments.projects",
		dialog: "gateway",
		section: "environments",
		group: "Environments",
		label: "Project environments",
		keywords: "setup cleanup variables actions worktree",
	},
	// Group-level entries for the bespoke panes (see COVERAGE above).
	{
		id: "gw.keys.byok",
		dialog: "gateway",
		section: "keys",
		group: "",
		label: "Provider API keys (BYOK)",
		keywords: "openai anthropic key secret token byok bring your own",
	},
	{
		id: "gw.keys.gateway-keys",
		dialog: "gateway",
		section: "keys",
		group: "",
		label: "Gateway keys",
		keywords: "api key token app access node key",
	},
	{
		id: "gw.guardrails.filters",
		dialog: "gateway",
		section: "guardrails",
		group: "",
		label: "Safety filters",
		keywords: "guardrails pii moderation firewall egress block",
	},
	{
		id: "gw.providers.list",
		dialog: "gateway",
		section: "providers",
		group: "",
		label: "AI providers",
		keywords: "openai anthropic ollama llamacpp local models engine",
	},
	{
		id: "gw.defaults.agent-model",
		dialog: "gateway",
		section: "defaults",
		group: "",
		label: "Default agent & model",
		keywords: "default model agent fallback global",
	},
	{
		id: "gw.access.devices",
		dialog: "gateway",
		section: "connections",
		group: "",
		label: "Connections",
		keywords: "pair pairing approve device token revoke remote nodes ssh hosts",
	},
	{
		id: "gw.permissions.overwrites",
		dialog: "gateway",
		section: "permissions",
		group: "",
		label: "Permissions",
		keywords: "acl roles teams grant deny spaces",
	},
	{
		id: "gw.workspace.members",
		dialog: "gateway",
		section: "workspace",
		group: "",
		label: "Team & workspace",
		keywords: "members seats invite org",
	},
	{
		id: "gw.usage.cost",
		dialog: "gateway",
		section: "usage",
		group: "",
		label: "Usage & cost",
		keywords: "spend tokens cost report",
	},
	{
		id: "gw.email-alerts.alerts",
		dialog: "gateway",
		section: "email-alerts",
		group: "",
		label: "Email & alerts",
		keywords: "notify email digest alert",
	},
	{
		id: "gw.audit.log",
		dialog: "gateway",
		section: "audit",
		group: "",
		label: "Activity log",
		keywords: "audit history events",
	},
	{
		id: "gw.evals.quality-tests",
		dialog: "gateway",
		section: "evals",
		group: "",
		label: "Quality tests",
		keywords: "evals benchmark score",
	},
	{
		id: "gw.health.preflight",
		dialog: "gateway",
		section: "health",
		group: "",
		label: "Health",
		keywords: "preflight status core gateway restart",
	},
];

export interface SettingsSearchHit {
	entry: SettingsEntry;
	score: number;
}

const WORD = /\s+/;

/**
 * Score one entry against one lowercase token. 0 means "no match", and because
 * matching is AND-across-tokens, a single 0 drops the entry entirely.
 *
 * The weights encode the ranking people expect: a label you typed exactly beats
 * a label that merely contains it, which beats a group header, which beats a
 * keyword you never saw on screen.
 */
function scoreToken(entry: SettingsEntry, token: string): number {
	const label = entry.label.toLowerCase();
	if (label === token) {
		return 120;
	}
	if (label.startsWith(token)) {
		return 80;
	}
	// Word-start inside the label ("mode" in "Theme mode") ranks above a match
	// that lands mid-word ("ode" in "mode"), which is usually a typo artifact.
	if (label.includes(` ${token}`)) {
		return 60;
	}
	if (label.includes(token)) {
		return 40;
	}
	const keywords = entry.keywords?.toLowerCase() ?? "";
	if (keywords.includes(token)) {
		return 30;
	}
	const group = entry.group.toLowerCase();
	if (group.includes(token)) {
		return 22;
	}
	const section = (
		SETTINGS_SECTION_LABELS[entry.section] ?? entry.section
	).toLowerCase();
	if (section.includes(token)) {
		return 12;
	}
	return 0;
}

/**
 * Rank the index against a free-text query. Tokens are ANDed: "dark diff" must
 * match both words somewhere on the same entry, which is what makes a two-word
 * query narrow rather than widen the list.
 *
 * Returns entries, best first, capped at `limit`. An empty query returns [] —
 * "show me everything" is the nav's job, not search's.
 */
export function searchSettings(query: string, limit = 40): SettingsEntry[] {
	const tokens = query
		.trim()
		.toLowerCase()
		.split(WORD)
		.filter((t) => t.length > 0);
	if (tokens.length === 0) {
		return [];
	}
	const hits: SettingsSearchHit[] = [];
	for (const entry of SETTINGS_ENTRIES) {
		let total = 0;
		let matchedAll = true;
		for (const token of tokens) {
			const score = scoreToken(entry, token);
			if (score === 0) {
				matchedAll = false;
				break;
			}
			total += score;
		}
		if (matchedAll) {
			hits.push({ entry, score: total });
		}
	}
	hits.sort((a, b) =>
		b.score === a.score
			? a.entry.label.localeCompare(b.entry.label)
			: b.score - a.score
	);
	return hits.slice(0, limit).map((h) => h.entry);
}

export function visibleSettingsEntries(
	entries: readonly SettingsEntry[],
	isDesktop: boolean
): SettingsEntry[] {
	return isDesktop
		? [...entries]
		: entries.filter((entry) => !entry.desktopOnly);
}

/** The section label a result should print as its "where it lives" line. */
export function sectionLabel(entry: SettingsEntry): string {
	return SETTINGS_SECTION_LABELS[entry.section] ?? entry.section;
}
