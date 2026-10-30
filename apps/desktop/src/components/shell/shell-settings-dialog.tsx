import { SettingsDialog } from "@/src/components/settings/LazySettingsDialog.tsx";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";

/**
 * The window's one App Settings dialog, driven by `useSettingsDialog` so any
 * surface (palette, menus, deep links) opens it by section. The dialog code is
 * lazy and stays unloaded until the first open.
 */
export function ShellSettingsDialog() {
	const open = useSettingsDialog((s) => s.open);
	const section = useSettingsDialog((s) => s.section);
	const setOpen = useSettingsDialog((s) => s.setOpen);
	return (
		<SettingsDialog
			defaultSection={section}
			onOpenChange={setOpen}
			open={open}
		/>
	);
}
