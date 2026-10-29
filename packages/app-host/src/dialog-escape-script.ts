// Installed only for a host-owned modal companion, never an ordinary app tab.
export function dialogEscapeScript(enabled: boolean): string {
	if (!enabled) {
		return "";
	}
	return `
    document.addEventListener("keydown", function (event) {
      if (!event.isTrusted || event.defaultPrevented || event.key !== "Escape" ||
          event.repeat || event.isComposing || event.altKey || event.ctrlKey ||
          event.metaKey || event.shiftKey) return;
      // Use the same authenticated MessagePort and mount-scoped service as ui/close.
      // The host must accept the request before this key is considered handled.
      call("ui.requestClose", []).then(function () {
        event.preventDefault();
      }, function () {});
    });
`;
}
