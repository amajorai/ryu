// The `$`-anchored path patterns of the built-in route table (see `../builtins.ts`).
// Every pattern needs a deeper path segment than its exact sibling, so no path
// matches both an exact route and a pattern.

// /channels/:id — manage a channel bot ("new" opens create mode).
export const CHANNEL_DETAIL = /^\/channels\/[^/]+$/;
// /identities/profile/:profileId — manage identities with a profile focused.
export const IDENTITY_PROFILE = /^\/identities\/profile\/[^/]+$/;
// A Notion-style markdown page inside a Space: /spaces/:spaceId/doc/:docId
export const SPACE_DOC = /^\/spaces\/[^/]+\/doc\/[^/]+$/;
// A stored binary file in its native viewer/editor: /spaces/:spaceId/file/:docId
export const SPACE_FILE = /^\/spaces\/[^/]+\/file\/[^/]+$/;
// A single database row's detail: /spaces/:spaceId/db/:databaseId/row/:rowId
export const SPACE_DB_ROW = /^\/spaces\/[^/]+\/db\/[^/]+\/row\/[^/]+$/;
// A Space's data-grid database: /spaces/:spaceId/db/:databaseId
export const SPACE_DB = /^\/spaces\/[^/]+\/db\/[^/]+$/;
// A Space's document-link graph: /spaces/:spaceId/graph
export const SPACE_GRAPH = /^\/spaces\/[^/]+\/graph$/;
// A Space's whiteboard (ported to the Whiteboard Ryu App): /spaces/:spaceId/wb/:documentId
export const SPACE_WB = /^\/spaces\/[^/]+\/wb\/[^/]+$/;
// A Space document owned by a Ryu App: /spaces/:spaceId/app/:pluginId/:documentId
export const SPACE_APP = /^\/spaces\/[^/]+\/app\/[^/]+\/[^/]+$/;
// /spaces/:spaceId — a single trailing segment (the doc/db patterns above are
// deeper), opening the Spaces page with that space pre-selected.
export const SPACE_DETAIL = /^\/spaces\/[^/]+$/;
// /library/<section> — opens the unified Library on a specific collection tab.
export const LIBRARY_SECTION = /^\/library\/([^/]+)$/;
// A Store section without its own exact route: /store/:section
export const STORE_SECTION = /^\/store\/([^/]+)$/;
// Memory keeps its Dream and Reflect views as deep links so a review can be
// reopened from notifications, command palette results, or a shared tab.
export const MEMORY_VIEW = /^\/library\/memory\/(dream|reflect)$/;
/** `/chat/agent/<agentId>` — the messaging-style merged view: every thread with
 *  that agent in one scroll, with the composer choosing which one a send joins. */
export const CHAT_MERGED_AGENT = /^\/chat\/agent\/([^/]+)$/;
// /workflows/:id (":id" is a workflow id, or "new" for an empty canvas). Single
// segment ([^/]+, not .+) so it does NOT swallow the two-segment builder path
// `/workflows/build/:id`.
export const WORKFLOW_DETAIL = /^\/workflows\/[^/]+$/;
// App-owned record details opened from contributed sidebar sections. The list
// lives in the host sidebar; the companion receives the selected id as mount
// context so its content surface never needs to rebuild that picker.
export const BLUEPRINT_DETAIL = /^\/blueprint\/[^/]+$/;
export const MAIL_DETAIL = /^\/mail\/[^/]+$/;
export const MONITOR_DETAIL = /^\/monitors\/[^/]+$/;
export const REASONING_DETAIL = /^\/reasoning\/[^/]+$/;
export const RLM_DETAIL = /^\/rlm\/[^/]+$/;
// /workflows/build/:id — the NL workflow builder for an existing workflow (the
// `/workflows/build` new-draft entry is an exact route). The builder is shell-
// only (see WorkflowsPage): host.runAgent's PermissionPreset never exposes the
// `workflow_builder.*` tools to the sandboxed canvas companion.
export const WORKFLOW_BUILD = /^\/workflows\/build\/[^/]+$/;
// /meetings/:id — a specific meeting's transcript + notes.
export const MEETING_DETAIL = /^\/meetings\/[^/]+$/;
// /social/:id — one scheduled post inside Outpost.
export const SOCIAL_DETAIL = /^\/social\/[^/]+$/;
// A deep-linked "open captured moment" into the Timeline: /timeline/:ts (ts in
// Unix µs). The command palette's "Search everything" opens this so the scrubber
// jumps straight to that moment; the ts is baked into the companion mount context
// as `window.ryu.context.focusTs` (the sandbox cannot receive the shell's
// `ryu:timeline-focus` window event the desktop page used).
export const TIMELINE_FOCUS = /^\/timeline\/[^/]+$/;
// /agents/new/edit or /agents/:id/edit.
export const AGENT_EDIT = /^\/agents\/.+\/edit$/;
// /artifact/:id — a session-local artifact surfaced by the agent, rendered
// full-size in a workspace tab (see ArtifactViewPage + useArtifactStore).
export const ARTIFACT_VIEW = /^\/artifact\/[^/]+$/;
// Project-scoped workspace surfaces can be opened as first-class main tabs. The
// folder is encoded into one segment so Windows drives and nested paths survive
// the tab router without being mistaken for additional route segments.
export const PROJECT_VIEW = /^\/project\/(diff|files|graph)\/([^/]+)$/;
// /skills/:id/edit — the SKILL.md editor for an existing skill (the `/skills/new`
// fresh-draft entry is an exact route). Single id segment ([^/]+), deeper than the
// `/skills` store exact, so no collision. The skill id is baked into the sandboxed
// @ryu/skill-editor companion as `window.ryu.context.skillId`.
export const SKILL_EDIT = /^\/skills\/[^/]+\/edit$/;
// The legacy short-path catch-all: ANY single top-level segment the exact map and
// every pattern above declined (`/calendar`, `/timeline`, `/inbox`, …). Registered
// LAST so it can only ever see paths that used to fall through to `null`; it hands
// them to `CompanionAliasRoute`, which either finds a live companion in the
// contributions feed or renders blank — the same blank the fallthrough produced.
// Every pattern above needs at least two segments, so the two never compete.
export const COMPANION_ALIAS = /^\/[^/]+$/;
