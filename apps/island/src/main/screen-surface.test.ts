// The on-screen generative UI window: sandboxed, and kept with the Island — it
// hides while the Island is hidden, comes back with it, and follows it when the
// Island moves.
//
// Runs in a child process with a virtual `electron` module: several test files
// mock `electron` with different shapes, and Bun's module mocks collide when
// they share one test process.

import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { screenSurfaceBounds } from "../shared/screen-surface.ts";

const workArea = { x: 0, y: 25, width: 1440, height: 875 };
const topIsland = { x: 530, y: 30, width: 380, height: 48 };
const bottomIsland = { x: 530, y: 840, width: 380, height: 48 };

const scenario = (modules: { screenSurface: string; shared: string }) => `
import { EventEmitter } from "node:events";
const workArea = ${JSON.stringify(workArea)};
const handlers = new Map();
class FakeWindow extends EventEmitter {
	static created = [];
	bounds = { x: 0, y: 0, width: 0, height: 0 };
	destroyed = false;
	sent = [];
	visible = false;
	webContents = {
		on: () => undefined,
		send: (channel, value) => this.sent.push([channel, value]),
		setWindowOpenHandler: () => undefined,
	};
	constructor(options = {}) { super(); this.options = options; FakeWindow.created.push(this); }
	destroy() { this.destroyed = true; this.emit("closed"); }
	getBounds() { return { ...this.bounds }; }
	hide() { this.visible = false; this.emit("hide"); }
	isDestroyed() { return this.destroyed; }
	isVisible() { return this.visible; }
	loadFile() { return Promise.resolve(); }
	loadURL() { return Promise.resolve(); }
	setAlwaysOnTop() {}
	setBounds(bounds) { this.bounds = { ...bounds }; }
	setContentProtection() {}
	setIgnoreMouseEvents() {}
	setVisibleOnAllWorkspaces() {}
	showInactive() { this.visible = true; this.emit("show"); }
}
Bun.plugin({
	setup(build) {
		build.module("electron", () => ({
			exports: {
				BrowserWindow: FakeWindow,
				ipcMain: { on: (channel, handler) => handlers.set(channel, handler) },
				screen: {
					getDisplayMatching: () => ({ workArea }),
					getPrimaryDisplay: () => ({ workArea }),
				},
			},
			loader: "object",
		}));
	},
});
const { SURFACE_CHANNELS } = await import(${JSON.stringify(modules.shared)});
const { followIslandWindow, registerScreenSurfaceIpc } = await import(${JSON.stringify(modules.screenSurface)});
const emit = (channel, sender, payload) => handlers.get(channel)?.({ sender }, payload);
const lastState = (win) => win.sent.filter(([channel]) => channel === SURFACE_CHANNELS.state).at(-1)?.[1];
const screenOf = (id) => ({ surface: { id, spec: { root: id } }, updating: false });

const island = new FakeWindow();
island.bounds = ${JSON.stringify(bottomIsland)};
island.visible = true;
registerScreenSurfaceIpc(() => island);
followIslandWindow(island);
const result = {};
emit(SURFACE_CHANNELS.show, island.webContents, screenOf("call-1"));
const screenWindow = FakeWindow.created.at(-1);
result.created = screenWindow !== island;
result.webPreferences = screenWindow.options.webPreferences;
// The Island moves while the screen page is still loading (window hidden).
island.bounds = ${JSON.stringify(topIsland)};
island.emit("move");
emit(SURFACE_CHANNELS.ready, screenWindow.webContents);
result.shownWithIsland = screenWindow.visible;
result.firstBounds = screenWindow.bounds;
island.hide();
result.hiddenWithIsland = !screenWindow.visible;
emit(SURFACE_CHANNELS.show, island.webContents, screenOf("call-2"));
result.waitsForIsland = !screenWindow.visible;
island.showInactive();
result.backWithIsland = screenWindow.visible;
result.backWithLatest = lastState(screenWindow)?.surface?.id;
island.bounds = ${JSON.stringify(bottomIsland)};
island.emit("move");
await Bun.sleep(200);
result.movedBounds = screenWindow.bounds;
result.movedAnchor = lastState(screenWindow)?.anchor;
emit(SURFACE_CHANNELS.show, screenWindow.webContents, screenOf("forged"));
result.afterForgedShow = lastState(screenWindow)?.surface?.id;
process.stdout.write(JSON.stringify(result));
process.exit(0);
`;

test("the screen window is sandboxed and follows the Island", async () => {
	const root = await mkdtemp(join(tmpdir(), "ryu-island-screen-surface-"));
	try {
		await writeFile(
			join(root, "run.ts"),
			scenario({
				screenSurface: join(import.meta.dirname, "screen-surface.ts"),
				shared: join(import.meta.dirname, "../shared/screen-surface.ts"),
			})
		);
		const child = Bun.spawn([process.execPath, join(root, "run.ts")], {
			stderr: "pipe",
			stdout: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		expect(JSON.parse(stdout)).toEqual({
			created: true,
			webPreferences: expect.objectContaining({
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
			}),
			shownWithIsland: true,
			// Shown beside where the Island is now, not where it was at `show`.
			firstBounds: screenSurfaceBounds(workArea, topIsland),
			// Tray/hotkey hide and hide-on-fullscreen both hide the Island window.
			hiddenWithIsland: true,
			// A screen that arrives while the Island is hidden waits for it.
			waitsForIsland: true,
			backWithIsland: true,
			backWithLatest: "call-2",
			// Dragged (or auto-jumped) to the bottom edge: window and anchor move.
			movedBounds: screenSurfaceBounds(workArea, bottomIsland),
			movedAnchor: "bottom",
			// Only the Island's renderer may drive the screen.
			afterForgedShow: "call-2",
		});
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});
