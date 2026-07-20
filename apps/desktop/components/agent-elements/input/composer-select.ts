// Shared styling for the chat composer's inline selects (agent, model, branch,
// project). One trigger class + one popover class + one item class so every
// composer select looks pixel-identical. Each trigger is rendered as a
// <Button variant="ghost" size="sm"> carrying COMPOSER_SELECT_TRIGGER, and each
// popover row carries COMPOSER_SELECT_ITEM.

// The single lever for every composer picker's trigger size (agent/team, model,
// permission "approval preset", and each ACP option). Tightened from px-2/gap-1.5
// to px-1.5/gap-1 so the controls read compact; the className overrides the
// Button `size="sm"` defaults via tailwind-merge.
export const COMPOSER_SELECT_TRIGGER =
	"h-7 gap-1 rounded-md px-1.5 text-[12px] leading-4 text-muted-foreground";

// The workspace strip pickers (project folder · git branch · worktree run mode)
// sit in a connected footer bar BELOW the textarea (inside the composer card), so
// they read as part of the composer, not as floating pills. Borderless to match
// the in-textarea chips (COMPOSER_SELECT_TRIGGER): the ghost Button supplies the
// hover background, the label stays muted, and there's no dropdown chevron.
export const WORKSPACE_SELECT_TRIGGER =
	"h-7 gap-1.5 rounded-md px-1.5 font-medium text-[12px] leading-4 text-muted-foreground";

// The workspace pickers' dropdown bodies. Codex keeps these tight: a modest
// rounded-xl card (not the app's bulbous rounded-3xl), 4px padding, compact rows
// at px-2/py-1.5 with a small 8px corner, and a quiet uppercase section label.
// Everything aligns to px-2 so headers, rows, and dividers share one left edge
// (our old popovers mixed px-3 rows with px-1.5 items, which read loose/ragged).
export const WORKSPACE_SELECT_POPOVER =
	"w-auto min-w-[200px] max-w-[300px] rounded-xl p-1";

export const WORKSPACE_SELECT_ITEM =
	"h-auto w-full items-center justify-start gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium";

export const WORKSPACE_SELECT_LABEL =
	"px-2 py-1 font-medium text-[11px] text-foreground/40";

export const COMPOSER_SELECT_POPOVER =
	"w-auto min-w-[200px] max-w-[280px] rounded-3xl p-1 gap-0";

// Matches the standard dropdown menu item padding (px-1.5 py-1 / gap-1.5) so the
// composer pickers read identical to every other dropdown in the app.
export const COMPOSER_SELECT_ITEM =
	"h-auto w-full items-center justify-start gap-1.5 rounded-2xl px-1.5 py-1 text-left text-sm font-medium";
