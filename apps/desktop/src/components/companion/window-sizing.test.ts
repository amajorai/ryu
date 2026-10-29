import { expect, test } from "bun:test";
import {
	type CompanionWindowFrame,
	createCompanionSizingController,
	fitCompanionWindow,
	logicalCompanionFrame,
} from "./window-sizing.ts";

const frame = (): CompanionWindowFrame => ({
	position: { x: 160, y: 40 },
	size: { width: 400, height: 80 },
	workArea: { x: 0, y: 24, width: 1280, height: 776 },
});

test("content growth and compact restoration preserve the dragged position", () => {
	expect(fitCompanionWindow(430.2, frame())).toEqual({
		x: 160,
		y: 40,
		width: 400,
		height: 431,
	});
	expect(
		fitCompanionWindow(20, { ...frame(), size: { width: 400, height: 431 } })
	).toEqual({ x: 160, y: 40, width: 400, height: 80 });
	expect(fitCompanionWindow(2000, frame()).height).toBe(640);
});

test("edge expansion moves only far enough to fit the monitor work area", () => {
	const moved = { ...frame(), position: { x: 1000, y: 700 } };
	expect(fitCompanionWindow(500, moved)).toEqual({
		x: 872,
		y: 292,
		width: 400,
		height: 500,
	});
	const negativeMonitor = {
		...frame(),
		position: { x: -1900, y: -150 },
		workArea: { x: -1920, y: -200, width: 1920, height: 1080 },
	};
	expect(fitCompanionWindow(500, negativeMonitor)).toEqual({
		x: -1900,
		y: -150,
		width: 400,
		height: 500,
	});
});

test("small displays clamp both dimensions and leave all bounds inside usable area", () => {
	const small = {
		...frame(),
		workArea: { x: 50, y: 30, width: 320, height: 260 },
	};
	expect(fitCompanionWindow(640, small)).toEqual({
		x: 58,
		y: 38,
		width: 304,
		height: 244,
	});
	expect(() => fitCompanionWindow(Number.NaN, frame())).toThrow(
		"Invalid Companion window geometry"
	);
	expect(() =>
		fitCompanionWindow(200, {
			...frame(),
			workArea: { x: 0, y: 0, width: 0, height: 200 },
		})
	).toThrow();
});

test("HiDPI physical work area and dragged position convert before fitting", () => {
	const logical = logicalCompanionFrame(
		{
			position: { x: 320, y: 80 },
			size: { width: 800, height: 160 },
			workArea: { x: 0, y: 48, width: 2560, height: 1552 },
		},
		2
	);
	expect(logical).toEqual(frame());
	expect(fitCompanionWindow(500, logical)).toEqual({
		x: 160,
		y: 40,
		width: 400,
		height: 500,
	});
	expect(() => logicalCompanionFrame(frame(), 0)).toThrow(
		"Invalid Companion scale factor"
	);
});

test("native bridge skips identical sizes and clamps position after resizing", async () => {
	let current = frame();
	const calls: unknown[] = [];
	const controller = createCompanionSizingController({
		readFrame: async () => current,
		setSize: async (size) => {
			calls.push({ size });
			current = { ...current, size };
		},
		setPosition: async (position) => {
			calls.push({ position });
			current = { ...current, position };
		},
	});
	await controller.request(80);
	expect(calls).toEqual([]);
	current = { ...current, position: { x: 1000, y: 700 } };
	await controller.request(500);
	expect(calls).toEqual([
		{ size: { width: 400, height: 500 } },
		{ position: { x: 872, y: 292 } },
	]);
	await controller.request(500);
	expect(calls).toHaveLength(2);
});

test("a late native measurement cannot apply an obsolete expanded height", async () => {
	let release: ((value: CompanionWindowFrame) => void) | undefined;
	let started: (() => void) | undefined;
	const measured = new Promise<void>((resolve) => {
		started = resolve;
	});
	let reads = 0;
	const sizes: unknown[] = [];
	const controller = createCompanionSizingController({
		readFrame: () =>
			++reads === 1
				? new Promise((resolve) => {
						release = resolve;
						started?.();
					})
				: Promise.resolve(frame()),
		setSize: async (size) => {
			sizes.push(size);
		},
		setPosition: async () => {
			throw new Error("In-bounds position must be retained");
		},
	});
	const oldRequest = controller.request(600);
	await measured;
	const newRequest = controller.request(240);
	release?.(frame());
	await Promise.all([oldRequest, newRequest]);
	expect(sizes).toEqual([{ width: 400, height: 240 }]);
});

test("IPC refusal propagates and a later request can recover", async () => {
	let refused = true;
	const sizes: unknown[] = [];
	const controller = createCompanionSizingController({
		readFrame: async () => frame(),
		setSize: async (size) => {
			if (refused) {
				refused = false;
				throw new Error("Window sizing permission denied");
			}
			sizes.push(size);
		},
		setPosition: async () => undefined,
	});
	await expect(controller.request(300)).rejects.toThrow(
		"Window sizing permission denied"
	);
	await controller.request(300);
	expect(sizes).toEqual([{ width: 400, height: 300 }]);
});

test("a user drag during native resize is preserved when the new origin fits", async () => {
	let current = { ...frame(), position: { x: 1000, y: 700 } };
	const controller = createCompanionSizingController({
		readFrame: async () => current,
		setSize: async (size) => {
			current = { ...current, size, position: { x: 200, y: 100 } };
		},
		setPosition: async () => {
			throw new Error("User drag was overwritten by stale geometry");
		},
	});
	await controller.request(500);
	expect(current.position).toEqual({ x: 200, y: 100 });
});

test("unmount during a native measurement prevents all mutations", async () => {
	let release: ((value: CompanionWindowFrame) => void) | undefined;
	let started: (() => void) | undefined;
	const measured = new Promise<void>((resolve) => {
		started = resolve;
	});
	const controller = createCompanionSizingController({
		readFrame: () =>
			new Promise((resolve) => {
				release = resolve;
				started?.();
			}),
		setSize: async () => {
			throw new Error("Disposed controller mutated size");
		},
		setPosition: async () => {
			throw new Error("Disposed controller mutated position");
		},
	});
	const pending = controller.request(600);
	await measured;
	controller.dispose();
	release?.(frame());
	await pending;
});
