export type PluginSettingsOpener = (pluginId: string) => (() => void) | null;

export function usePluginSettingsOpener(): PluginSettingsOpener {
	return (id) =>
		id === "pocket-tts"
			? () => {
					window.dispatchEvent(
						new CustomEvent("marketplace-store:settings", { detail: id })
					);
				}
			: null;
}
