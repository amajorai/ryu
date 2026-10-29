import { createRoot } from "react-dom/client";
import { DevicePermissionsSettings } from "../../src/components/settings/DevicePermissionsSettings.tsx";
import "../../src/index.css";

if (new URLSearchParams(location.search).get("native") !== "1") {
	const scenario =
		new URLSearchParams(location.search).get("platform") ?? "macos";
	const userAgent =
		scenario === "windows"
			? "Windows NT 10.0"
			: scenario === "macos"
				? "Macintosh"
				: "Linux";
	Object.defineProperty(navigator, "userAgent", {
		configurable: true,
		value: userAgent,
	});
	const calls: string[] = [];
	const unexpected: string[] = [];
	let refuseSettings = false;
	const checks = [
		"check_screen_recording_permission",
		"check_accessibility_permission",
		"check_input_monitoring_permission",
	];
	const requests = [
		"request_screen_recording_permission",
		"request_accessibility_permission",
		"request_input_monitoring_permission",
	];
	let granted = scenario === "windows";
	let micRequests = 0;
	let stopped = 0;
	const fixture = {
		calls,
		unexpected,
		failNextSettings() {
			refuseSettings = true;
		},
		setGranted(value: boolean) {
			granted = value;
		},
		get stopped() {
			return stopped;
		},
	};
	Object.assign(window, {
		permissionFixture: fixture,
		__TAURI_INTERNALS__: {
			transformCallback: () => 1,
			invoke: async (command: string, args?: { capability?: string }) => {
				calls.push(command + (args?.capability ? `:${args.capability}` : ""));
				if (
					command === "open_privacy_settings" &&
					args &&
					Object.keys(args).length === 1 &&
					[
						"screenRecording",
						"accessibility",
						"inputMonitoring",
						"microphone",
					].includes(args.capability ?? "")
				) {
					if (refuseSettings) {
						refuseSettings = false;
						throw new Error("Owned OS settings refusal");
					}
					return;
				}
				if (
					(!args || Object.keys(args).length === 0) &&
					requests.includes(command)
				)
					return false;
				if (
					(!args || Object.keys(args).length === 0) &&
					checks.includes(command)
				)
					return granted;
				unexpected.push(command);
				throw new Error(`Unexpected command: ${command}`);
			},
		},
	});
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: {
			getUserMedia: async () => {
				micRequests++;
				if (micRequests === 1) {
					throw new DOMException("Permission denied", "NotAllowedError");
				}
				return {
					getTracks: () => [
						{
							stop: () => {
								stopped++;
							},
						},
					],
				};
			},
		},
	});
}
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<main className="min-h-screen bg-background p-8 text-foreground">
			<div className="mx-auto max-w-3xl">
				<DevicePermissionsSettings />
			</div>
		</main>
	);
}
