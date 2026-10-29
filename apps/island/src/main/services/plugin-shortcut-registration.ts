import type { PluginContributionsResult } from "../../shared/ipc.ts";
import type { KeybindingOverrides } from "../../shared/keybindings.ts";

function toElectronAccelerator(shortcut: string): string | null {
	const parts = shortcut
		.toLowerCase()
		.split("+")
		.map((part) => part.trim());
	const key = parts.pop();
	if (!key || parts.length === 0) {
		return null;
	}
	// Same mapping as `toElectronAccelerator` in `@ryu/hotkeys`: only `Mod` is
	// Command-or-Control; `Ctrl` stays the Control key on macOS too.
	const modifiers = parts.map((part) => {
		if (part === "mod" || part === "commandorcontrol" || part === "cmdorctrl") {
			return "CommandOrControl";
		}
		if (part === "ctrl" || part === "control") {
			return "Control";
		}
		if (part === "cmd" || part === "command") {
			return "Command";
		}
		if (part === "alt" || part === "option") {
			return "Alt";
		}
		if (part === "shift") {
			return "Shift";
		}
		return null;
	});
	if (modifiers.some((part) => part === null)) {
		return null;
	}
	return [
		...new Set(modifiers.filter((part) => part !== null)),
		key.length === 1 ? key.toUpperCase() : key,
	].join("+");
}

function hasNonShiftModifier(accelerator: string): boolean {
	return accelerator
		.split("+")
		.slice(0, -1)
		.some((modifier) => modifier !== "Shift");
}

export interface PluginShortcutBoundary {
	focus(): void;
	register(accelerator: string, handler: () => void): boolean;
	sendShortcut(companionId: string): void;
	unregister(accelerator: string): void;
}

/** Reconcile the Core-owned snapshot into acknowledged OS registrations. */
export function createPluginShortcutRegistrar(
	boundary: PluginShortcutBoundary
) {
	const registered = new Map<string, string>();
	return (
		result: PluginContributionsResult,
		overrides: KeybindingOverrides,
		reserved: readonly string[]
	) => {
		for (const accelerator of registered.values()) {
			boundary.unregister(accelerator);
		}
		registered.clear();
		const occupied = new Set(reserved);
		if (!result.available) {
			return;
		}
		for (const companion of result.companions) {
			const actionId = `plugin:${companion.pluginId}`;
			const userConfigured = Object.hasOwn(overrides, actionId);
			const configured = userConfigured
				? overrides[actionId]
				: companion.shortcut;
			if (!configured) {
				continue;
			}
			const accelerator = toElectronAccelerator(configured);
			if (!accelerator || occupied.has(accelerator)) {
				continue;
			}
			// A manifest may not claim a Shift-only chord system-wide: it would
			// swallow ordinary typing (capital letters, symbols) in every app. The
			// user's own override is their choice and is honoured as-is.
			if (!(userConfigured || hasNonShiftModifier(accelerator))) {
				continue;
			}
			try {
				if (
					boundary.register(accelerator, () => {
						boundary.focus();
						boundary.sendShortcut(companion.id);
					})
				) {
					registered.set(companion.id, accelerator);
					occupied.add(accelerator);
				}
			} catch {
				// OS registration refusal must not make the app unusable.
			}
		}
	};
}
