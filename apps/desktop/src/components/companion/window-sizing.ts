export const COMPANION_COMPACT_HEIGHT = 80;
export const COMPANION_WIDTH = 400;
export const COMPANION_MAX_HEIGHT = 640;

export interface CompanionWindowFrame {
	position: { x: number; y: number };
	size: { width: number; height: number };
	workArea: { x: number; y: number; width: number; height: number };
}

export function logicalCompanionFrame(
	physical: CompanionWindowFrame,
	scale: number
): CompanionWindowFrame {
	if (!Number.isFinite(scale) || scale <= 0) {
		throw new Error("Invalid Companion scale factor");
	}
	return {
		position: {
			x: physical.position.x / scale,
			y: physical.position.y / scale,
		},
		size: {
			width: physical.size.width / scale,
			height: physical.size.height / scale,
		},
		workArea: {
			x: physical.workArea.x / scale,
			y: physical.workArea.y / scale,
			width: physical.workArea.width / scale,
			height: physical.workArea.height / scale,
		},
	};
}

/** All dimensions are logical pixels; callers convert native physical values. */
export function fitCompanionWindow(
	contentHeight: number,
	frame: CompanionWindowFrame
): CompanionWindowFrame["position"] & CompanionWindowFrame["size"] {
	if (
		![
			contentHeight,
			frame.position.x,
			frame.position.y,
			frame.size.width,
			frame.size.height,
			frame.workArea.x,
			frame.workArea.y,
			frame.workArea.width,
			frame.workArea.height,
		].every(Number.isFinite) ||
		frame.workArea.width <= 0 ||
		frame.workArea.height <= 0
	) {
		throw new Error("Invalid Companion window geometry");
	}
	const margin = Math.min(
		8,
		frame.workArea.width / 4,
		frame.workArea.height / 4
	);
	const width = Math.min(COMPANION_WIDTH, frame.workArea.width - margin * 2);
	const height = Math.min(
		Math.max(COMPANION_COMPACT_HEIGHT, Math.ceil(contentHeight)),
		COMPANION_MAX_HEIGHT,
		frame.workArea.height - margin * 2
	);
	const minX = frame.workArea.x + margin;
	const minY = frame.workArea.y + margin;
	return {
		width,
		height,
		x: Math.max(
			minX,
			Math.min(
				frame.position.x,
				frame.workArea.x + frame.workArea.width - margin - width
			)
		),
		y: Math.max(
			minY,
			Math.min(
				frame.position.y,
				frame.workArea.y + frame.workArea.height - margin - height
			)
		),
	};
}

export interface CompanionSizingBridge {
	readFrame: () => Promise<CompanionWindowFrame>;
	setPosition: (position: CompanionWindowFrame["position"]) => Promise<void>;
	setSize: (size: CompanionWindowFrame["size"]) => Promise<void>;
}

/** Serialize IPC; late measurements cannot overwrite newer content or unmount. */
export function createCompanionSizingController(bridge: CompanionSizingBridge) {
	let generation = 0;
	let disposed = false;
	let tail = Promise.resolve();
	return {
		request(contentHeight: number): Promise<void> {
			const requestedGeneration = ++generation;
			tail = tail
				.catch(() => undefined)
				.then(async () => {
					if (disposed || requestedGeneration !== generation) {
						return;
					}
					const frame = await bridge.readFrame();
					if (disposed || requestedGeneration !== generation) {
						return;
					}
					const fitted = fitCompanionWindow(contentHeight, frame);
					let placementFrame = frame;
					if (
						Math.abs(frame.size.width - fitted.width) >= 1 ||
						Math.abs(frame.size.height - fitted.height) >= 1
					) {
						await bridge.setSize({
							width: fitted.width,
							height: fitted.height,
						});
						if (disposed || requestedGeneration !== generation) {
							return;
						}
						// A user can drag while set_size is in flight. Never reposition
						// from the stale pre-resize origin.
						placementFrame = await bridge.readFrame();
					}
					if (disposed || requestedGeneration !== generation) {
						return;
					}
					const placement = fitCompanionWindow(contentHeight, placementFrame);
					if (
						Math.abs(placementFrame.position.x - placement.x) >= 1 ||
						Math.abs(placementFrame.position.y - placement.y) >= 1
					) {
						await bridge.setPosition({ x: placement.x, y: placement.y });
					}
				});
			return tail;
		},
		dispose() {
			disposed = true;
			generation++;
		},
	};
}
