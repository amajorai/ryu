/// <reference lib="dom" />
// Browser entry for the services-auth voice hang-up proof
// (`voice-session.services-auth.browser-proof.ts`). It is bundled for Chromium
// and drives the shipping `VoiceSessionConnection` with the real browser
// WebSocket, Web Audio and (fake-device) microphone. It only records what the
// connection reports; it never replaces a transport or audio API.
import { VoiceSessionConnection } from "./voice-session.ts";

interface ProofState {
	events: string[];
	micStops: number;
	streams: MediaStream[];
}

const state: ProofState = { events: [], micStops: 0, streams: [] };
let connection: VoiceSessionConnection | null = null;

// Observe (not replace) microphone acquisition and release.
const acquire = navigator.mediaDevices.getUserMedia.bind(
	navigator.mediaDevices
);
navigator.mediaDevices.getUserMedia = async (constraints) => {
	const stream = await acquire(constraints);
	state.streams.push(stream);
	for (const track of stream.getTracks()) {
		const stop = track.stop.bind(track);
		track.stop = () => {
			state.micStops += 1;
			stop();
		};
	}
	return stream;
};

function startCall(url: string): Promise<string> {
	connection = new VoiceSessionConnection(
		{ token: "browser-proof-node", url },
		{
			handlers: {
				onCallEnded: (summary) =>
					state.events.push(`call_ended:${summary.messageId}`),
				onClose: () => state.events.push("close"),
				onError: (code, message) =>
					state.events.push(`error:${code}:${message}`),
				onOpen: () => state.events.push("open"),
				onReady: () => state.events.push("ready"),
			},
		}
	);
	return connection.start().then(
		() => "started",
		(error: unknown) => `start failed: ${String(error)}`
	);
}

function hangUp(): void {
	connection?.close();
}

function snapshot() {
	return {
		events: [...state.events],
		micLive: state.streams.flatMap((stream) =>
			stream.getTracks().map((track) => track.readyState)
		),
		micStops: state.micStops,
	};
}

Object.assign(window, { voiceProof: { hangUp, snapshot, startCall } });
