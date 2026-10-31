// apps/desktop/src/hooks/useDialogOverlayBlur.ts
//
// Re-export of THE shared "Dim dialog backgrounds" toggle, which now lives in
// `@ryu/ui` (`hooks/use-dialog-overlay-blur.ts`) so the desktop, `apps/web` and
// any other surface read one module-level store rather than a copy each.
//
// This file stays as the desktop's import path because several surfaces already
// import it (App boot, the Appearance tab, the settings registry). It
// deliberately holds no logic: the previous local copy kept its own listener
// set, and since the `storage` event never fires in the writing document, a
// duplicate store elsewhere would not re-render when the Appearance toggle
// flips. Re-adding logic here re-opens that split.

export {
	DEFAULT_DIALOG_OVERLAY_BLUR,
	DIALOG_OVERLAY_BLUR_STORAGE_KEY,
	initDialogOverlayBlur,
	readDialogOverlayBlur,
	setDialogOverlayBlur,
	useDialogOverlayBlur,
} from "@ryu/ui/hooks/use-dialog-overlay-blur.ts";
