import type { DownloadTask } from "../../src/lib/api/downloads.ts";
import type { BackgroundContract } from "../chat-page-native-http-background.ts";

// Since 2643ab5fab ("ui(P2): quiet sidebar footer…") the footer DownloadCenter
// tray only renders while a download is in flight or failed. The
// `window-tray-downloads` scenario seeds exactly one of each through Core's
// unified event stream (`GET /api/events/all`, SSE `event: downloads`), whose
// first downloads frame is always a full `snapshot` (see lib/api/downloads.ts).
// It replaces the idle stream contract, so the shared background ledger still
// records the stream as an owned, expected request.
const SEEDED_AT = 1_724_000_000_000;

export const WINDOW_TRAY_DOWNLOADS: DownloadTask[] = [
	{
		id: "download-in-flight-fixture",
		kind: "model",
		role: "chat_model",
		label: "Qwen3 4B Instruct",
		url: "https://models.example.test/qwen3-4b.gguf",
		dest_path: "/tmp/ryu-window-tray/models/qwen3-4b.gguf",
		total_bytes: 2_400_000_000,
		received_bytes: 960_000_000,
		state: "active",
		error: null,
		retryable: true,
		speed_bps: 24_000_000,
		created_at: SEEDED_AT,
		updated_at: SEEDED_AT + 40_000,
	},
	{
		id: "download-failed-fixture",
		kind: "engine",
		role: "engine",
		label: "llama.cpp engine",
		url: "https://engines.example.test/llama-cpp.tar.zst",
		dest_path: null,
		total_bytes: 48_000_000,
		received_bytes: 12_000_000,
		state: "failed",
		error: "Connection reset while downloading",
		retryable: true,
		speed_bps: null,
		created_at: SEEDED_AT,
		updated_at: SEEDED_AT + 20_000,
	},
];

/**
 * Contracts for the `window-tray*` scenarios: the account menu's Help feed and
 * the full Downloads page reads (idle history and concurrency settings), plus,
 * when `seeded`, an event stream whose downloads snapshot holds the fixtures.
 */
export function windowTrayContracts(seeded: boolean): {
	backend: ReadonlyMap<string, BackgroundContract>;
	core: ReadonlyMap<string, BackgroundContract>;
} {
	const core = new Map<string, BackgroundContract>([
		["GET /api/downloads/history", { body: { history: [] } }],
		[
			"GET /api/downloads/settings",
			{
				body: {
					effective_slots: 3,
					env_locked: false,
					manual_slots: 3,
					max_slots: 8,
					measured_bps: 0,
					min_slots: 1,
					mode: "auto",
				},
			},
		],
	]);
	if (seeded) {
		const snapshot = { type: "snapshot", tasks: WINDOW_TRAY_DOWNLOADS };
		core.set("GET /api/events/all", {
			body: `event: downloads\ndata: ${JSON.stringify(snapshot)}\n\n`,
			stream: true,
		});
	}
	return {
		backend: new Map([
			["GET /api/updates/recent?limit=8", { body: { items: [] } }],
		]),
		core,
	};
}
