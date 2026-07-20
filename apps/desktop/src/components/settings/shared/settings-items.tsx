// Re-export shim. The presentational iOS-style settings primitives now live in
// @ryu/blocks/desktop/settings-items so the storyboard can render the real
// components. Every settings tab + the Gateway dialog imports from here
// unchanged; this file just forwards to the shared block.
export {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@ryu/blocks/desktop/settings-items";
