import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runIsolatedIslandScenario } from "./island-isolated-runtime.ts";

// Each case runs the shipping `cursor-tracker.ts` (and the `x11-pointer.ts` it
// reads on Linux) in its own Bun runtime. Replaced are only the OS boundaries:
// Electron's `screen`, the Koffi FFI that reaches libX11, `process.platform`,
// the session environment and command line that decide which windowing system
// Electron itself runs on, and the poll timer (captured, then ticked by hand).
// The window is a ledger of what the tracker sends the renderer.
//
// The Linux cases model what an X11 session does to a click-through window:
// Electron's own cursor reading stays at its first value while the X server's
// pointer moves. The renderer hit-tests these samples to take the pointer, so a
// sample over the resting Island is what lets it open from rest.
const TRACKER = join(import.meta.dirname, "cursor-tracker.ts");
const ELECTRON = Bun.resolveSync("electron", import.meta.dirname);
const KOFFI = Bun.resolveSync("koffi", import.meta.dirname);

interface TrackerRun {
	/** The `screen` events the tracker listens to, sorted. */
	displayEvents: string[];
	/** `screen.getAllDisplays()` calls. */
	displayReads: number;
	/** Calls into Electron's `screen.getCursorScreenPoint()`. */
	electronReads: number;
	/** Every libX11 symbol the module bound, in order. */
	functions: string[];
	/** Every `koffi.load` call. */
	loads: string[];
	/** `XOpenDisplay` calls. */
	opens: number;
	/** `XQueryPointer` calls. */
	queries: number;
	/** `window:cursorMove` payloads, grouped by the step that produced them. */
	sent: Record<string, unknown[]>;
	stderr: string;
}

/**
 * Run `body` against one tracked window. In `body`: `tick(label)` runs one poll
 * and records what it sent under `label`; `x11` is the X pointer (physical px)
 * or `null` for "another X screen"; `electron` is Electron's frozen reading;
 * `displays` is Electron's display list (one 1920x1080 display at scale 1) and
 * `emitDisplays(event)` fires one of Electron's `screen` events; `queryError`
 * makes `XQueryPointer` throw; `bounds`, `win.visible` and `emit(event)` drive
 * the window; `attach()` tracks a further window. `options.env` and
 * `options.argv` are the session environment and the Electron command line,
 * and `options.electronVersion` the running Electron (default: the pinned 33);
 * the Wayland session variables are cleared first, so a case never depends on
 * the host running the suite.
 */
async function trackerScenario(
	platform: "linux" | "darwin" | "win32",
	options: {
		argv?: string[];
		electronVersion?: string;
		env?: Record<string, string>;
		xDisplay: boolean;
	},
	body: string
): Promise<TrackerRun> {
	const { result, stderr } = await runIsolatedIslandScenario(
		() => `
import {mock} from "bun:test";
Object.defineProperty(process,"platform",{value:${JSON.stringify(platform)},configurable:true});
delete process.env.WAYLAND_DISPLAY;delete process.env.ELECTRON_OZONE_PLATFORM_HINT;
Object.assign(process.env,${JSON.stringify(options.env ?? {})});
process.argv=[...process.argv,...${JSON.stringify(options.argv ?? [])}];
Object.defineProperty(process.versions,"electron",{value:${JSON.stringify(options.electronVersion ?? "33.4.11")},configurable:true});
let electron={x:5,y:5};
let x11={x:100,y:100};
let displays=[{id:1,bounds:{x:0,y:0,width:1920,height:1080},nativeOrigin:{x:0,y:0},scaleFactor:1}];
let electronReads=0;let displayReads=0;const displayListeners={};
mock.module(${JSON.stringify(ELECTRON)},()=>({screen:{
 getCursorScreenPoint:()=>{electronReads+=1;return {...electron};},
 getAllDisplays:()=>{displayReads+=1;return displays.map((display)=>({...display}));},
 on:(event,listener)=>{(displayListeners[event]??=[]).push(listener);},
}}));
const emitDisplays=(event)=>{for(const listener of displayListeners[event]??[]){listener({},displays[0]);}};
let queryError=null;let queries=0;
const loads=[];const functions=[];let opens=0;
mock.module(${JSON.stringify(KOFFI)},()=>({load:(library)=>{loads.push(library);return {func:(declaration)=>{
 const name=String(declaration).match(/(X[A-Za-z]+)\\(/)[1];
 functions.push(name);
 if(name==="XOpenDisplay"){return (screen)=>{opens+=1;return screen===null&&${options.xDisplay}?{display:":0"}:null;};}
 if(name==="XDefaultRootWindow"){return ()=>0x1e0;}
 return (dpy,root,rootReturn,childReturn,rootX,rootY)=>{
  queries+=1;
  if(queryError){throw queryError;}
  if(dpy?.display!==":0"||root!==0x1e0){throw new Error("bad XQueryPointer target");}
  if(x11===null){return 0;}
  rootX[0]=x11.x;rootY[0]=x11.y;return 1;
 };
}};}}));
const timers=[];
globalThis.setInterval=(callback,ms)=>{timers.push({callback,ms,live:true});return timers.length;};
globalThis.clearInterval=(id)=>{if(timers[id-1]){timers[id-1].live=false;}};
const sent={};let step="attach";
let bounds={x:1320,y:452,width:600,height:620};
function makeWindow(){
 const handlers={};
 const win={visible:true,destroyed:false,
  isDestroyed:()=>win.destroyed,isVisible:()=>win.visible,getBounds:()=>({...bounds}),
  on:(event,handler)=>{(handlers[event]??=[]).push(handler);return win;},
  once:(event,handler)=>{(handlers[event]??=[]).push(handler);return win;},
  emit:(event)=>{for(const handler of handlers[event]??[]){handler();}},
  webContents:{send:(channel,payload)=>{(sent[step]??=[]).push([channel,payload]);}},
 };
 return win;
}
const {attachCursorTracking}=await import(${JSON.stringify(TRACKER)});
const win=makeWindow();
const attach=()=>{const next=makeWindow();attachCursorTracking(next);return next;};
attachCursorTracking(win);
const emit=(event)=>win.emit(event);
const tick=(label)=>{step=label;sent[label]??=[];for(const timer of timers){if(timer.live){if(timer.ms!==16){throw new Error("unexpected poll interval "+timer.ms);}timer.callback();}}};
${body}
process.stdout.write(JSON.stringify({sent,displayReads,displayEvents:Object.keys(displayListeners).sort(),electronReads,loads,functions,opens,queries}));
`
	);
	return { ...(result as Omit<TrackerRun, "stderr">), stderr };
}

const MOVE = "window:cursorMove";
const DISPLAY_EVENTS = [
	"display-added",
	"display-metrics-changed",
	"display-removed",
];

describe("Linux X11 cursor source", () => {
	test("a click-through Island sees the pointer arrive from rest, where Electron's reading stays frozen", async () => {
		// The resting Island window sits at (1320,452); its logo is near the top
		// center of the 600-wide window. Electron keeps answering (5,5) throughout.
		const run = await trackerScenario(
			"linux",
			{ xDisplay: true },
			`
tick("rest, pointer elsewhere");
x11={x:1620,y:472};
tick("pointer over the logo");
tick("pointer still");
x11={x:1900,y:1000};
tick("pointer leaves to the margin");
`
		);
		expect(run).toEqual({
			sent: {
				"rest, pointer elsewhere": [[MOVE, { x: -1220, y: -352 }]],
				"pointer over the logo": [[MOVE, { x: 300, y: 20 }]],
				"pointer still": [],
				"pointer leaves to the margin": [[MOVE, { x: 580, y: 548 }]],
			},
			electronReads: 0,
			// One display list serves every tick; the tracker refreshes it only
			// when Electron reports a display change.
			displayReads: 1,
			displayEvents: DISPLAY_EVENTS,
			loads: ["libX11.so.6"],
			functions: ["XOpenDisplay", "XDefaultRootWindow", "XQueryPointer"],
			opens: 1,
			queries: 4,
			stderr: "",
		});
	});

	test("samples follow the window through a drag or glide, and physical pixels become DIP per display", async () => {
		// A 2x 3840x2160 panel (1920x1080 DIP), then a 1x primary beside a 2x
		// secondary: X pixels map through the display the pointer is on.
		const run = await trackerScenario(
			"linux",
			{ xDisplay: true },
			`
displays=[{id:1,bounds:{x:0,y:0,width:1920,height:1080},nativeOrigin:{x:0,y:0},scaleFactor:2}];
x11={x:3241,y:945};
tick("scale 2");
bounds={...bounds,x:1000,y:300};
tick("window dragged, pointer still");
bounds={...bounds,x:1010,y:310};
tick("glide frame");
displays=[
 {id:1,bounds:{x:0,y:0,width:1920,height:1080},nativeOrigin:{x:0,y:0},scaleFactor:1},
 {id:2,bounds:{x:1920,y:0,width:1280,height:720},nativeOrigin:{x:1920,y:0},scaleFactor:2},
];
emitDisplays("display-added");
bounds={...bounds,x:2000,y:0};
x11={x:2520,y:101};
tick("pointer on the 2x secondary display");
x11={x:1900,y:101};
tick("pointer back on the 1x primary display");
`
		);
		expect(run.sent).toEqual({
			"scale 2": [[MOVE, { x: 300, y: 20 }]],
			"window dragged, pointer still": [[MOVE, { x: 620, y: 172 }]],
			"glide frame": [[MOVE, { x: 610, y: 162 }]],
			"pointer on the 2x secondary display": [[MOVE, { x: 220, y: 50 }]],
			"pointer back on the 1x primary display": [[MOVE, { x: -100, y: 101 }]],
		});
		expect(run.electronReads).toBe(0);
		expect(run.stderr).toBe("");
	});

	test("polling stops while hidden, resumes on show, and a recreated window reuses one X connection", async () => {
		const run = await trackerScenario(
			"linux",
			{ xDisplay: true },
			`
tick("shown");
win.visible=false;emit("hide");
x11={x:1620,y:472};
tick("hidden");
win.visible=true;emit("show");
tick("shown again");
win.destroyed=true;emit("closed");
attach();
x11={x:1625,y:480};
tick("recreated window");
`
		);
		expect(run.sent).toEqual({
			shown: [[MOVE, { x: -1220, y: -352 }]],
			hidden: [],
			"shown again": [[MOVE, { x: 300, y: 20 }]],
			"recreated window": [[MOVE, { x: 305, y: 28 }]],
		});
		expect(run.opens).toBe(1);
		expect(run.loads).toEqual(["libX11.so.6"]);
	});

	test("without an X display, or with the pointer on another X screen, Electron's reading is used", async () => {
		const noDisplay = await trackerScenario(
			"linux",
			{ xDisplay: false },
			`
tick("first");
electron={x:1620,y:472};
tick("second");
`
		);
		expect(noDisplay).toEqual({
			sent: {
				first: [[MOVE, { x: -1315, y: -447 }]],
				second: [[MOVE, { x: 300, y: 20 }]],
			},
			electronReads: 2,
			displayReads: 0,
			displayEvents: [],
			loads: ["libX11.so.6"],
			functions: ["XOpenDisplay", "XDefaultRootWindow", "XQueryPointer"],
			// A failed open is remembered: no reconnect attempt on every tick.
			opens: 1,
			queries: 0,
			stderr: "",
		});

		const otherScreen = await trackerScenario(
			"linux",
			{ xDisplay: true },
			`
x11=null;electron={x:1620,y:472};
tick("other screen");
`
		);
		expect(otherScreen.sent).toEqual({
			"other screen": [[MOVE, { x: 300, y: 20 }]],
		});
		expect(otherScreen.electronReads).toBe(1);
	});

	// A Wayland session sets WAYLAND_DISPLAY and also keeps an XWayland display
	// open, so `XOpenDisplay` succeeds there. The X server's pointer is then not
	// the one Electron renders against unless Electron itself was started on X11.
	const WAYLAND_SESSION = { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" };
	const waylandCases: Array<{
		argv?: string[];
		electronVersion?: string;
		env: Record<string, string>;
		name: string;
		usesX11: boolean;
	}> = [
		{
			name: "Wayland session, Electron on Wayland by hint",
			env: { ...WAYLAND_SESSION, ELECTRON_OZONE_PLATFORM_HINT: "wayland" },
			usesX11: false,
		},
		{
			name: "Wayland session, Electron's auto hint",
			env: { ...WAYLAND_SESSION, ELECTRON_OZONE_PLATFORM_HINT: "auto" },
			usesX11: false,
		},
		{
			// Electron before 38 defaults to X11 and runs through XWayland.
			name: "Wayland session, no hint, Electron 33",
			env: WAYLAND_SESSION,
			usesX11: true,
		},
		{
			name: "Wayland session, no hint, Electron 38 defaults to Wayland",
			electronVersion: "38.0.0",
			env: WAYLAND_SESSION,
			usesX11: false,
		},
		{
			name: "Wayland session, Electron 38 ignores the removed env hint",
			electronVersion: "38.0.0",
			env: { ...WAYLAND_SESSION, ELECTRON_OZONE_PLATFORM_HINT: "x11" },
			usesX11: false,
		},
		{
			name: "Wayland session, Electron 38 forced to X11 by --ozone-platform",
			argv: ["--ozone-platform=x11"],
			electronVersion: "38.0.0",
			env: WAYLAND_SESSION,
			usesX11: true,
		},
		{
			name: "Wayland session, --ozone-platform=wayland beats an x11 hint",
			argv: ["--ozone-platform=wayland"],
			env: { ...WAYLAND_SESSION, ELECTRON_OZONE_PLATFORM_HINT: "x11" },
			usesX11: false,
		},
		{
			name: "Wayland session, Electron forced to X11 by hint",
			env: { ...WAYLAND_SESSION, ELECTRON_OZONE_PLATFORM_HINT: "x11" },
			usesX11: true,
		},
		{
			name: "Wayland session, Electron forced to X11 by --ozone-platform",
			argv: ["--ozone-platform=x11"],
			env: WAYLAND_SESSION,
			usesX11: true,
		},
		{
			name: "Wayland session, Electron forced to X11 by --ozone-platform-hint",
			argv: ["--ozone-platform-hint=x11"],
			env: WAYLAND_SESSION,
			usesX11: true,
		},
		{
			name: "X11 session",
			env: { DISPLAY: ":0" },
			usesX11: true,
		},
	];
	for (const { argv, electronVersion, env, name, usesX11 } of waylandCases) {
		test(`${name}: ${usesX11 ? "the X server's pointer is read" : "Electron's reading is used and libX11 is never opened"}`, async () => {
			const run = await trackerScenario(
				"linux",
				{ argv, electronVersion, env, xDisplay: true },
				`
electron={x:1620,y:472};
tick("pointer over the logo");
`
			);
			expect(run.sent).toEqual({
				"pointer over the logo": [
					usesX11 ? [MOVE, { x: -1220, y: -352 }] : [MOVE, { x: 300, y: 20 }],
				],
			});
			expect(run.electronReads).toBe(usesX11 ? 0 : 1);
			expect(run.opens).toBe(usesX11 ? 1 : 0);
			expect(run.loads).toEqual(usesX11 ? ["libX11.so.6"] : []);
			expect(run.queries).toBe(usesX11 ? 1 : 0);
			expect(run.stderr).toBe("");
		});
	}

	test("a failing X query hands the tick to Electron's reading and is not retried", async () => {
		// An exception from the per-tick native call would escape the 16 ms timer
		// callback in the main process, so the tracker latches to Electron's reading.
		const run = await trackerScenario(
			"linux",
			{ xDisplay: true },
			`
x11={x:1620,y:472};
tick("X answers");
queryError=new Error("X connection lost");
electron={x:1625,y:480};
tick("query throws");
queryError=null;x11={x:1700,y:500};
tick("after the failure");
electron={x:1630,y:490};
tick("Electron moves");
`
		);
		expect(run.sent).toEqual({
			"X answers": [[MOVE, { x: 300, y: 20 }]],
			"query throws": [[MOVE, { x: 305, y: 28 }]],
			"after the failure": [],
			"Electron moves": [[MOVE, { x: 310, y: 38 }]],
		});
		// The throwing call is the last one made to libX11.
		expect(run.queries).toBe(2);
		expect(run.electronReads).toBe(3);
		expect(run.stderr).toBe("");
	});

	test("the display list is read once and refreshed when Electron reports a display change", async () => {
		const run = await trackerScenario(
			"linux",
			{ xDisplay: true },
			`
x11={x:2520,y:101};
tick("one display");
x11={x:2530,y:101};
tick("same display list");
displays=[
 {id:1,bounds:{x:0,y:0,width:1920,height:1080},nativeOrigin:{x:0,y:0},scaleFactor:1},
 {id:2,bounds:{x:1920,y:0,width:1280,height:720},nativeOrigin:{x:1920,y:0},scaleFactor:2},
];
tick("second display plugged in, no event yet");
emitDisplays("display-added");
tick("after display-added");
displays=[
 {id:1,bounds:{x:0,y:0,width:1920,height:1080},nativeOrigin:{x:0,y:0},scaleFactor:1},
 {id:2,bounds:{x:1920,y:0,width:1280,height:720},nativeOrigin:{x:1920,y:0},scaleFactor:1},
];
emitDisplays("display-metrics-changed");
tick("after display-metrics-changed");
displays=[displays[0]];
emitDisplays("display-removed");
tick("after display-removed");
`
		);
		// Pixel x 2530 is past the lone 1920-wide display; with the 2x secondary
		// listed it maps to DIP 1920 + (2530 - 1920) / 2, and at 1x to 2530.
		expect(run.sent).toEqual({
			"one display": [[MOVE, { x: 1200, y: -351 }]],
			"same display list": [[MOVE, { x: 1210, y: -351 }]],
			"second display plugged in, no event yet": [],
			"after display-added": [[MOVE, { x: 905, y: -402 }]],
			"after display-metrics-changed": [[MOVE, { x: 1210, y: -351 }]],
			"after display-removed": [],
		});
		expect(run.displayReads).toBe(4);
		expect(run.displayEvents).toEqual(DISPLAY_EVENTS);
		expect(run.electronReads).toBe(0);
	});
});

describe("macOS and Windows keep Electron's cursor reading", () => {
	for (const platform of ["darwin", "win32"] as const) {
		test(`${platform} never loads libX11`, async () => {
			const run = await trackerScenario(
				platform,
				{ xDisplay: true },
				`
electron={x:1620,y:472};
tick("over the logo");
`
			);
			expect(run).toEqual({
				sent: { "over the logo": [[MOVE, { x: 300, y: 20 }]] },
				electronReads: 1,
				displayReads: 0,
				displayEvents: [],
				loads: [],
				functions: [],
				opens: 0,
				queries: 0,
				stderr: "",
			});
		});
	}
});
