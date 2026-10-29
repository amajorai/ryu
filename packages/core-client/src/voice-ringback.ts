/** Telephone-style double ring, followed by a pause. No downloaded audio. */
export function startVoiceRingback(): () => void {
	if (!globalThis.AudioContext) {
		return () => undefined;
	}
	const context = new AudioContext();
	const buffer = context.createBuffer(
		1,
		context.sampleRate * 3,
		context.sampleRate
	);
	const samples = buffer.getChannelData(0);
	for (let index = 0; index < samples.length; index += 1) {
		const time = index / context.sampleRate;
		const pulseTime =
			time < 0.4 ? time : time >= 0.6 && time < 1 ? time - 0.6 : -1;
		if (pulseTime < 0) {
			continue;
		}
		const envelope = Math.min(1, pulseTime / 0.01, (0.4 - pulseTime) / 0.01);
		samples[index] =
			envelope *
			0.08 *
			(Math.sin(2 * Math.PI * 400 * time) + Math.sin(2 * Math.PI * 450 * time));
	}
	const source = context.createBufferSource();
	source.buffer = buffer;
	source.loop = true;
	source.connect(context.destination);
	source.start();
	context.resume().catch(() => undefined);
	let stopped = false;
	return () => {
		if (stopped) {
			return;
		}
		stopped = true;
		source.stop();
		source.disconnect();
		context.close().catch(() => undefined);
	};
}
