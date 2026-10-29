// Only native probes and the external reporting transport are substituted.
// The production action components, diagnostics collection, and consent gate run unchanged.
export const getVersion = async () => "1.0.0";
export const fetchHealth = async () => ({ version: "1.0.0" });
export const fetchSystemStatus = async () => ({ gatewayReachable: true });
export const getVersionInfo = async () => ({});
export const getConsoleBufferText = () => "";
export const getDevMetricsText = () => "";
export const fetchCatalog = async () => [];
export const getInstallId = () => "preflight-proof";
export const track = () => undefined;
export const init = () => undefined;
export const captureMessage = () => "proof-event";
export function captureException() {
	if (new URLSearchParams(location.search).get("mode") === "failed") {
		throw new Error("Report transport unavailable");
	}
	document.body.dataset.reportQueued = "true";
	return "proof-event";
}
