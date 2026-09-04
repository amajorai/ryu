// Shared styling for the chat composer's inline selects (agent, model, branch,
// project). One trigger class + one popover class + one item class so every
// composer select looks pixel-identical. Each trigger is rendered as a
// <Button variant="ghost" size="sm"> carrying COMPOSER_SELECT_TRIGGER, and each
// popover row carries COMPOSER_SELECT_ITEM.

// The single lever for every composer picker's trigger size (agent/team, model,
// permission "approval preset", and each ACP option). Tightened from px-2/gap-1.5
// to px-1.5/gap-1 so the controls read compact; the className overrides the
// Button `size="sm"` defaults via the shared cn merge engine.
export const COMPOSER_SELECT_TRIGGER =
	"h-7 gap-1 rounded-md px-1.5 text-[12px] leading-4 text-muted-foreground";

// The workspace strip pickers (project folder · git branch · worktree run mode)
// sit in a connected footer bar BELOW the textarea (inside the composer card), so
// they read as part of the composer, not as floating pills. Borderless to match
// the in-textarea chips (COMPOSER_SELECT_TRIGGER): the ghost Button supplies the
// hover background, the label stays muted, and there's no dropdown chevron.
export const WORKSPACE_SELECT_TRIGGER =
	"h-7 gap-1.5 rounded-md px-1.5 font-medium text-[12px] text-foreground/90 leading-4 data-popup-open:bg-foreground/10";

// The ONE width for every workspace picker menu body (folder · branch · run
// mode), whether it is the inline picker's root menu, one of its submenus, or a
// stacked row's menu in the pinned summary panel. It replaces a 220/256/260/280
// spread that made the same three lists three different widths depending on
// which trigger you came from. `DropdownMenuContent` sizes to `--anchor-width`,
// so this floor is load-bearing: without it the menu would size itself to a
// 28px-tall chip.
//
// Rows inside these menus carry no width class of their own — they take
// `COMPOSER_SELECT_ITEM` (or the `DropdownMenuItem` primitive, which already
// matches it), so the workspace pickers read identical to every other dropdown
// in the app. There is deliberately no WORKSPACE_SELECT_ITEM/POPOVER/LABEL any
// more: they were the second, near-identical copy of that styling, and having
// two is what let the two picker families drift apart in the first place.
export const WORKSPACE_MENU_CONTENT = "min-w-[280px]";

// The cap + scroller is part of the shared look ON PURPOSE, because the lists
// these popovers hold are not ours to bound: an ACP agent advertises its own
// permission modes, reasoning levels and config options (`acp-pickers.tsx`), a
// plugin advertises its own composer control options, and one of those lists can
// be a 36-entry model roster. `PopoverContent` sets no max-height of its own, so
// every one of those rendered at full height and simply ran off the top of the
// screen with nothing to scroll — the rows past the viewport edge were
// unreachable, not merely awkward.
//
// A popover that brings its OWN scroller (the model picker, whose search field
// has to stay pinned while the rows move) overrides this with `overflow-hidden`;
// nesting two scrollers is what makes a list feel stuck.
export const COMPOSER_SELECT_POPOVER =
	"w-auto min-w-[200px] max-w-[280px] max-h-80 overflow-y-auto rounded-3xl p-1 gap-0";

// Matches the standard dropdown menu item padding (px-1.5 py-1 / gap-1.5) so the
// composer pickers read identical to every other dropdown in the app.
export const COMPOSER_SELECT_ITEM =
	"h-auto w-full items-center justify-start gap-1.5 rounded-2xl px-1.5 py-1 text-left text-sm font-medium";
