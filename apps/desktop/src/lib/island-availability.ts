// apps/desktop/src/lib/island-availability.ts
//
// Release gate for Island (apps/island), the device-local Electron companion
// overlay. Island is not part of the current release, so every desktop entry
// point that installs, launches, shows, or configures it is rendered behind
// this one constant instead of being commented out: the code stays live, typed,
// and maintained, and re-enabling Island is a single flip here plus the
// matching `ISLAND_ENABLED` constant in `src-tauri/src/lib.rs` (tray item and
// autostart).
//
// Gated surfaces: the NodeSelector "Island" service row, the PreflightPage
// Island accordion item, the onboarding install-and-launch, the User Nav
// Show/Hide Island item, the Keyboard Shortcuts "Summon Command Bar" /
// "Push-To-Talk" global rows, and the Island settings tab body in
// `components/settings/EntitySettings.tsx` (an explanatory notice replaces
// `IslandSettings`). Copy that mentions the companion reads
// {@link ISLAND_UNAVAILABLE_NOTE} while the gate is off.
//
// The Store listing is gated separately by `"hidden": true` in
// `apps/island/manifest.json` (Core reads the manifest, not this constant);
// remove that flag in the same change that flips this gate.

/** Whether the Island companion ships in this release. */
export const ISLAND_ENABLED = false as boolean;

/** User-facing sentence for copy that would otherwise point at Island. */
export const ISLAND_UNAVAILABLE_NOTE =
	"The Island companion that registers system-wide shortcuts is not available in this release.";
