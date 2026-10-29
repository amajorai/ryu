import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseAppearance } from "../shared/appearance.ts";
import { runIsolatedIslandScenario } from "./island-isolated-runtime.ts";

// Boots the shipping Island main process (`index.ts`) in its own Bun runtime
// against an owned native HTTP Core fixture (preferences and the preference SSE
// stream), with the Island Background preference Desktop Settings writes. The
// window path is real: `index.ts` startup and live-switch handling,
// `window.ts` (window options, native material, click-through), `position.ts`,
// `positioner.ts` and `anchor.ts` (the anchored resting geometry, its restore
// and the window glide), `material-mask.ts`, `ipc/index.ts` + `ipc/win.ts`
// (what the renderer's footprint and mouse reports do) and
// `ipc/appearance.ts` (the renderer's read). Replaced are only Electron (a
// `BrowserWindow` ledger that records every option and call), the Windows
// `mica-electron` and macOS `koffi`/`electron-liquid-glass` native modules,
// the OS release string, `process.platform`, and the Island modules that need
// a real display (the snap-zone overlay and the generated-screen window),
// global input hooks or other Core services.
const MAIN = import.meta.dirname;
const ELECTRON = Bun.resolveSync("electron", MAIN);
const TOKEN = "island-background-token";

/** Resolve an optional native module the way `window.ts` / `material-mask.ts` do. */
function nativeModule(name: string): string {
	try {
		return Bun.resolveSync(name, MAIN);
	} catch {
		return name;
	}
}
const MICA = nativeModule("mica-electron");
const KOFFI = nativeModule("koffi");
const LIQUID_GLASS = nativeModule("electron-liquid-glass");

const STUBS: Record<string, string> = {
	"auto-jump.ts": "initAutoJump(){},jumpNow(){},setAutoJump(){}",
	"control.ts": "startControlServer(){},stopControlServer(){}",
	"cursor-tracker.ts": "attachCursorTracking(){}",
	"fullscreen.ts": "initFullscreenHide(){},setHideOnFullscreen(){}",
	"ghost-cursor.ts": "destroyGhostCursor(){}",
	"screen-surface.ts":
		"registerScreenSurfaceIpc(){},followIslandWindow(){},forwardThemeToScreenSurface(){},setScreenSurfaceContentProtection(){},destroyScreenSurface(){}",
	"overlay.ts":
		"initZoneOverlay(){globalThis.overlayInits=(globalThis.overlayInits??0)+1;},setOverlayContentProtection(){},showZoneOverlay(){},setActiveZone(){},hideZoneOverlay(){},destroyZoneOverlay(){}",
	"voice-control.ts":
		"acceleratorPrimaryKeycode(){return null;},configureHold(){},isHoldArmed(){return false;},noteHoldPressed(){},setRecording(){},setTabCycle(){},stopHooks(){}",
	// Every IPC registrar except the window (`win.ts`) and appearance ones, which
	// stay real: they own what the renderer's reports and read do.
	"ipc/agents.ts": "registerAgentsIpc(){}",
	"ipc/catalog.ts": "registerCatalogIpc(){}",
	"ipc/consent.ts": "registerConsentIpc(){}",
	"ipc/core.ts": "registerCoreIpc(){}",
	"ipc/dictation.ts": "registerDictationIpc(){}",
	"ipc/keybindings.ts": "registerKeybindingsIpc(){}",
	"ipc/language-packs.ts": "registerLanguagePacksIpc(){}",
	"ipc/meetings.ts": "registerMeetingsIpc(){}",
	"ipc/plugins.ts": "registerPluginsIpc(){}",
	"ipc/quests.ts": "registerQuestsIpc(){}",
	"ipc/settings.ts": "registerSettingsIpc(){}",
	"ipc/shadow.ts": "registerShadowIpc(){}",
	"ipc/suggestions.ts": "registerSuggestionsIpc(){}",
	"ipc/system.ts": "registerSystemIpc(){}",
	"ipc/theme.ts": "registerThemeIpc(){}",
	"ipc/tts.ts": "registerTtsIpc(){}",
	"ipc/update.ts": "registerUpdateIpc(){}",
	"ipc/voice.ts": "registerVoiceIpc(){}",
	"ipc/window.ts": "registerWindowIpc(){}",
};

type Call = [string, ...unknown[]];
interface Rect {
	height: number;
	width: number;
	x: number;
	y: number;
}
interface Display {
	bounds: Rect;
	id: number;
	workArea: Rect;
}
/** One 1920x1080 display with a 40 px taskbar, as Electron reports it. */
const PRIMARY: Display = {
	id: 1,
	bounds: { x: 0, y: 0, width: 1920, height: 1080 },
	workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};
/** A second, identical display to the right of the primary one. */
const SECOND: Display = {
	id: 2,
	bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
	workArea: { x: 1920, y: 0, width: 1920, height: 1040 },
};
interface WindowRecord {
	bounds: { height: number; width: number; x: number; y: number };
	calls: Call[];
	destroyed: boolean;
	id: number;
	kind: string;
	options: Record<string, unknown>;
}
/**
 * A persisted Island position: an anchor (what current builds write), or the
 * bare window top-left older builds wrote, which startup converts.
 */
type StoredPosition =
	| { anchor: { h: Align; v: Align; x: number; y: number } }
	| { x: number; y: number };
type Align = "center" | "end" | "start";
interface BackgroundRun {
	observed: Record<string, unknown>;
	settled: Record<string, boolean>;
	stderr: string;
	windows: WindowRecord[];
}

/**
 * Boot `index.ts` as `platform` (Windows reports 11 22H2, so built-in Acrylic is
 * available) with `prefs` in Core and, optionally, a saved window position.
 * Core answers the first read of each `refuseFirstRead` key with a 503, and a
 * closing window stays listed until it reports `closed` after `closeDelayMs`
 * (Electron's teardown). `displays` replaces the single 1920x1080 display, `real`
 * keeps listed modules (normally stubs, such as `auto-jump.ts`) real, and the
 * Nth window construction throws for each N in `failWindowBuilds`. As in
 * Electron's main process, an exception in a window event handler is logged
 * (recorded as a `handlerError` call) and the app keeps running. The body drives
 * Core (`push(key, value)` on the live stream), the app (`appEvent(name)`) and
 * the renderer side of the window IPC (`send(channel, payload)`,
 * `invoke(channel)`), waits with `until(name, predicate)`, and stores
 * observations in `observed`; `globalThis.overlayInits` counts snap-zone overlay
 * initialisations.
 */
async function backgroundScenario(
	{
		platform,
		prefs,
		storedPosition,
		refuseFirstRead = [],
		closeDelayMs = 0,
		displays = [PRIMARY],
		real = [],
		failWindowBuilds = [],
	}: {
		platform: "darwin" | "linux" | "win32";
		prefs: Record<string, string>;
		storedPosition?: StoredPosition;
		refuseFirstRead?: string[];
		closeDelayMs?: number;
		displays?: Display[];
		real?: string[];
		failWindowBuilds?: number[];
	},
	body = ""
): Promise<BackgroundRun> {
	const { result, stderr } = await runIsolatedIslandScenario(
		(root) => `
import {mock} from "bun:test";
import {mkdirSync,writeFileSync} from "node:fs";
import * as realOs from "node:os";
Object.defineProperty(process,"platform",{value:${JSON.stringify(platform)},configurable:true});
mock.module("node:os",()=>({...realOs,release:()=>${JSON.stringify(platform === "win32" ? "10.0.26100" : "25.0.0")}}));
const settled={};const observed={};const streams=new Set();const refusing=new Set(${JSON.stringify(refuseFirstRead)});const prefs=new Map(Object.entries(${JSON.stringify(prefs)}));
const server=Bun.serve({hostname:"127.0.0.1",port:0,idleTimeout:0,async fetch(req){
 const path=new URL(req.url).pathname;
 if(req.headers.get("authorization")!==${JSON.stringify(`Bearer ${TOKEN}`)}){return Response.json({error:"unauthorized"},{status:401});}
 if(path==="/api/preferences/stream"){
  let sink;
  const body=new ReadableStream({start(controller){sink=controller;streams.add(controller);controller.enqueue(new TextEncoder().encode(": ok\\n\\n"));},cancel(){streams.delete(sink);}});
  return new Response(body,{headers:{"Content-Type":"text/event-stream"}});
 }
 if(path==="/api/plugins/contributions"){return Response.json({companions:[],views:[]});}
 if(path.startsWith("/api/preferences/")){
  const key=decodeURIComponent(path.slice("/api/preferences/".length));
  if(req.method==="GET"&&refusing.delete(key)){return Response.json({error:"unavailable"},{status:503});}
  if(req.method==="PUT"){prefs.set(key,(await req.json()).value);return Response.json({ok:true});}
  return prefs.has(key)?Response.json({key,value:prefs.get(key)}):Response.json({error:"not found"},{status:404});
 }
 return Response.json({error:"not found"},{status:404});
}});
function push(key,value){
 prefs.set(key,value);
 const frame=new TextEncoder().encode("data: "+JSON.stringify({key,value})+"\\n\\n");
 for(const stream of streams){stream.enqueue(frame);}
}
writeFileSync(${JSON.stringify(join(root, "island-services.json"))},JSON.stringify({coreBaseUrl:server.url.toString().replace(/\\/$/,""),coreToken:${JSON.stringify(TOKEN)}}));
${
	storedPosition
		? `mkdirSync(${JSON.stringify(join(root, "island"))},{recursive:true});writeFileSync(${JSON.stringify(join(root, "island", "window.json"))},${JSON.stringify(JSON.stringify(storedPosition))});`
		: ""
}
const windows=[];let builds=0;const failBuilds=new Set(${JSON.stringify(failWindowBuilds)});
class BrowserWindow{
 static getAllWindows(){return windows.filter((win)=>!win.destroyed);}
 constructor(options){
  builds+=1;
  if(failBuilds.has(builds)){throw new Error("window build failed");}
  const {webPreferences,...shown}=options;
  this.id=windows.length+1;this.kind=new.target.name;this.options=shown;this.calls=[];this.destroyed=false;this.handlers=[];
  this.bounds={x:options.x??0,y:options.y??0,width:options.width??0,height:options.height??0};
  const calls=this.calls;
  this.webContents={session:{setPermissionRequestHandler(){},setPermissionCheckHandler(){}},send:(channel)=>calls.push(["send",channel]),isDevToolsOpened:()=>false};
  windows.push(this);
 }
 on(event,handler){this.handlers.push({event,handler,once:false});return this;}
 once(event,handler){this.handlers.push({event,handler,once:true});return this;}
 emit(event){
  const due=this.handlers.filter((entry)=>entry.event===event);
  this.handlers=this.handlers.filter((entry)=>!(entry.event===event&&entry.once));
  this.calls.push(["event",event]);
  for(const entry of due){try{entry.handler();}catch(error){this.calls.push(["handlerError",String(error?.message??error)]);}}
 }
 isDestroyed(){return this.destroyed;}
 isVisible(){return false;}
 isFocused(){return false;}
 getSize(){return [this.bounds.width,this.bounds.height];}
 getContentSize(){return [this.bounds.width,this.bounds.height];}
 getPosition(){return [this.bounds.x,this.bounds.y];}
 getNativeWindowHandle(){return Buffer.alloc(8);}
 setPosition(x,y){this.calls.push(["setPosition",x,y]);this.bounds={...this.bounds,x,y};}
 setBounds(bounds){this.calls.push(["setBounds",bounds]);this.bounds={...this.bounds,...bounds};}
 loadFile(){this.calls.push(["loadFile"]);setTimeout(()=>this.emit("ready-to-show"),0);}
 loadURL(){this.calls.push(["loadURL"]);setTimeout(()=>this.emit("ready-to-show"),0);}
 close(){this.calls.push(["close"]);setTimeout(()=>{this.destroyed=true;this.emit("closed");},${closeDelayMs});}
}
for(const name of ["setIgnoreMouseEvents","setAlwaysOnTop","setVisibleOnAllWorkspaces","setContentProtection","setShape","setBackgroundMaterial","setVibrancy","show","showInactive","moveTop","focus"]){
 BrowserWindow.prototype[name]=function(...args){this.calls.push([name,...args]);};
}
class MicaBrowserWindow extends BrowserWindow{}
for(const name of ["setDarkTheme","setRoundedCorner","setMicaAcrylicEffect","setAcrylic"]){
 MicaBrowserWindow.prototype[name]=function(...args){this.calls.push([name,...args]);};
}
mock.module(${JSON.stringify(MICA)},()=>({MicaBrowserWindow,IS_WINDOWS_11:true}));
mock.module(${JSON.stringify(KOFFI)},()=>({load(){throw new Error("no AppKit on this host");}}));
mock.module(${JSON.stringify(LIQUID_GLASS)},()=>({isGlassSupported:()=>false}));
const ipcOn=new Map();const ipcHandle=new Map();const appHandlers=new Map();
const displays=${JSON.stringify(displays)};
// The OS cursor; a case moves it with \`cursor={x,y}\`.
let cursor={x:960,y:540};
const within=(rect,point)=>point.x>=rect.x&&point.x<rect.x+rect.width&&point.y>=rect.y&&point.y<rect.y+rect.height;
const centre=(rect)=>({x:rect.x+rect.width/2,y:rect.y+rect.height/2});
function nearestDisplay(point){
 return displays.find((each)=>within(each.bounds,point))??displays.reduce((best,each)=>Math.hypot(centre(each.bounds).x-point.x,centre(each.bounds).y-point.y)<Math.hypot(centre(best.bounds).x-point.x,centre(best.bounds).y-point.y)?each:best);
}
mock.module(${JSON.stringify(ELECTRON)},()=>({
 app:{getPath:()=>${JSON.stringify(root)},setName(){},dock:undefined,focus(){},requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),quit(){},getVersion:()=>"0.0.0",isPackaged:false,
  on(event,handler){const list=appHandlers.get(event)??[];list.push(handler);appHandlers.set(event,list);}},
 BrowserWindow,
 globalShortcut:{register:()=>true,unregister(){},unregisterAll(){}},
 ipcMain:{
  on(channel,handler){const list=ipcOn.get(channel)??[];list.push(handler);ipcOn.set(channel,list);},
  handle(channel,handler){ipcHandle.set(channel,handler);},
  removeAllListeners(channel){ipcOn.delete(channel);},
 },
 nativeImage:{},
 screen:{on(){},removeListener(){},getPrimaryDisplay:()=>displays[0],getAllDisplays:()=>displays,getDisplayNearestPoint:nearestDisplay,getCursorScreenPoint:()=>cursor},
}));
${Object.entries(STUBS)
	.filter(([file]) => !real.includes(file))
	.map(
		([file, members]) =>
			`mock.module(${JSON.stringify(join(MAIN, file))},()=>({${members}}));`
	)
	.join("\n")}
async function until(name,predicate,ms=4000){const end=Date.now()+ms;while(!predicate()){if(Date.now()>end){settled[name]=false;return;}await Bun.sleep(5);}settled[name]=true;}
const ready=(id)=>windows[id-1]?.calls.some((call)=>call[0]==="event"&&call[1]==="ready-to-show")===true;
function appEvent(name){for(const handler of appHandlers.get(name)??[]){handler();}}
function send(channel,payload){for(const handler of ipcOn.get(channel)??[]){handler({},payload);}}
async function invoke(channel){return await ipcHandle.get(channel)?.({});}
/** Wait until \`win\` has stopped moving (a glide is ~360 ms), then read its bounds. */
async function rested(name,win=windows.at(-1)){
 const started=Date.now();let last=JSON.stringify(win.bounds);let still=Date.now();
 while(Date.now()-started<4000){
  await Bun.sleep(20);
  const now=JSON.stringify(win.bounds);
  if(now!==last){last=now;still=Date.now();}
  else if(Date.now()-still>=150&&Date.now()-started>=400){settled[name]=true;return {...win.bounds};}
 }
 settled[name]=false;return {...win.bounds};
}
await import(${JSON.stringify(join(MAIN, "index.ts"))});
await until("booted",()=>ready(1)&&streams.size>0);
await Bun.sleep(30);
${body}
const output=JSON.stringify({settled,observed,windows:windows.map(({id,kind,options,calls,destroyed,bounds})=>({id,kind,options,calls,destroyed,bounds}))});
await new Promise((resolve)=>process.stdout.write(output,resolve));
process.exit(0);
`,
		20_000
	);
	return { ...(result as Omit<BackgroundRun, "stderr">), stderr };
}

const background = (value: string) => JSON.stringify({ background: value });
/** A fixed edge offset keeps the dock geometry the same on every platform. */
const EDGE = { "island-edge-offset": "20" };
/** What the renderer reports at rest: the logo circle, the gap, the idle pill. */
const RESTING_FOOTPRINT = {
	width: 144,
	height: 40,
	expanded: false,
	shapes: [
		{ x: 0, y: 0, width: 40, height: 40, radius: 20 },
		{ x: 48, y: 0, width: 96, height: 40, radius: 20 },
	],
};
/** Calls that apply or change a native OS material, shape mask or Mica effect. */
const NATIVE_MATERIAL_CALLS = new Set([
	"setShape",
	"setBackgroundMaterial",
	"setVibrancy",
	"setDarkTheme",
	"setRoundedCorner",
	"setMicaAcrylicEffect",
	"setAcrylic",
]);
const names = (calls: Call[]) => calls.map((call) => call[0]);
const after = (calls: Call[], marker: string) =>
	calls.slice(calls.findIndex((call) => call[0] === marker) + 1);
/** Everything the window did before the renderer probe started. */
const startup = (calls: Call[]) => {
	const mark = calls.findIndex((call) => call[0] === "mark");
	return mark === -1 ? calls : calls.slice(0, mark);
};
/** The renderer-side probe every scenario below runs after boot. */
const RENDERER_PROBE = `
const win=windows.at(-1);
observed.read=await invoke("appearance:get");
win.calls.push(["mark"]);
send("win:setContentSize",${JSON.stringify(RESTING_FOOTPRINT)});
send("win:setMaterialShapes",${JSON.stringify(RESTING_FOOTPRINT.shapes)});
send("win:setMouseCapture",{capture:true});
send("win:setMouseCapture",{capture:false});
await Bun.sleep(20);
`;

/** The options of the floating Translucent window, before its position. */
const TRANSLUCENT_WINDOW = {
	width: 600,
	height: 620,
	frame: false,
	transparent: true,
	resizable: false,
	skipTaskbar: true,
	hasShadow: false,
	show: false,
};
/**
 * The space the fixed Translucent window keeps around the island group it
 * aligns inside (`TRANSLUCENT_WINDOW_INSET`): 8 px on top, 48 px on the other
 * sides for the shapes' shadows.
 */
const INSET = { top: 8, side: 48 };
/**
 * The bottom-right dock: the island's footprint is pinned by its bottom-right
 * corner 20 px in from the work area's bottom-right corner, so every footprint
 * grows up and to the left from that point.
 */
const DOCK = { x: 1920 - 20, y: 1040 - 20 };
/** The exact options of the floating Translucent window docked bottom-right. */
const TRANSLUCENT_OPTIONS = {
	...TRANSLUCENT_WINDOW,
	// The window aligns the island group to its own bottom-right corner inside
	// the inset, so the window overflows the screen there, which is fine because
	// it is click-through.
	x: DOCK.x + INSET.side - 600,
	y: DOCK.y + INSET.side - 620,
};

for (const platform of ["win32", "darwin", "linux"] as const) {
	test(`a saved Translucent background starts the oversized click-through window with no native material (${platform})`, async () => {
		const run = await backgroundScenario(
			{
				platform,
				prefs: { "island-appearance": background("translucent"), ...EDGE },
				// An older build's saved window top-left: its resting island sat
				// centred in the 600px window, 8px below its top, at (1728, 108).
				storedPosition: { x: 1500, y: 100 },
			},
			RENDERER_PROBE
		);
		expect(run.stderr).toBe("");
		expect(run.settled.booted).toBe(true);
		expect(run.windows).toHaveLength(1);
		const [win] = run.windows;
		expect(win.kind).toBe("BrowserWindow");
		// No backgroundMaterial, vibrancy, visualEffectState or backgroundColor.
		// The saved spot is kept as an anchor in the top-right zone: the island
		// stays at (1728, 108) and grows down and to the left from its top-right
		// corner, so the window aligns the group to its own top-right.
		const savedIsland = { x: 1500 + (600 - 144) / 2, y: 100 + 8 };
		const savedWindow = {
			x: savedIsland.x + 144 + INSET.side - 600,
			y: savedIsland.y - INSET.top,
		};
		expect(win.options).toEqual({ ...TRANSLUCENT_WINDOW, ...savedWindow });
		expect(
			names(win.calls).filter((name) => NATIVE_MATERIAL_CALLS.has(name))
		).toEqual([]);
		// Click-through from the first frame, before the window is shown. Electron
		// honours `forward` on macOS and Windows only; on Linux the renderer's
		// polled-cursor hit-test takes the pointer instead (Island.background.test.ts).
		const beforeReady = win.calls.slice(
			0,
			win.calls.findIndex((call) => call[0] === "event")
		);
		expect(beforeReady).toContainEqual([
			"setIgnoreMouseEvents",
			true,
			{ forward: true },
		]);
		// The window is built in place and never moves to get there.
		expect(names(win.calls)).not.toContain("setPosition");
		expect(names(win.calls)).not.toContain("setBounds");
		// The renderer reads the same preference and parses it as translucent.
		expect(run.observed.read).toBe(background("translucent"));
		expect(parseAppearance(run.observed.read as string)).toEqual({
			background: "translucent",
		});
		// Its footprint report neither resizes nor masks the fixed window, so the
		// logo and pill float as separate shapes; mouse capture toggles
		// click-through.
		expect(after(win.calls, "mark")).toEqual([
			["setIgnoreMouseEvents", false, { forward: true }],
			["setIgnoreMouseEvents", true, { forward: true }],
		]);
		expect(win.bounds).toEqual({ ...savedWindow, width: 600, height: 620 });
	}, 30_000);
}

test("Native glass and Mica keep their native-material windows", async () => {
	const material = {
		width: 144,
		height: 44,
		frame: false,
		transparent: true,
		backgroundColor: "#00000000",
		resizable: false,
		skipTaskbar: true,
		hasShadow: false,
		show: false,
		x: 1920 - 20 - 144,
		y: 1040 - 20 - 44,
	};
	const acrylic = await backgroundScenario(
		{
			platform: "win32",
			prefs: { "island-appearance": background("acrylic"), ...EDGE },
		},
		RENDERER_PROBE
	);
	expect(acrylic.stderr).toBe("");
	expect(acrylic.settled.booted).toBe(true);
	const [acrylicWin] = acrylic.windows;
	expect(acrylicWin.kind).toBe("BrowserWindow");
	expect(acrylicWin.options).toEqual({
		...material,
		backgroundMaterial: "acrylic",
	});
	expect(names(startup(acrylicWin.calls))).not.toContain(
		"setIgnoreMouseEvents"
	);
	// The resting logo is masked before the window is shown.
	expect(names(after(startup(acrylicWin.calls), "event"))).toEqual([
		"setShape",
		"show",
	]);
	// The window tracks the footprint and the mask follows the shapes.
	expect(names(after(acrylicWin.calls, "mark"))).toEqual([
		"setBounds",
		"setShape",
		"setShape",
		"setIgnoreMouseEvents",
		"setIgnoreMouseEvents",
	]);
	// The window wraps the 144x40 footprint, pinned by its bottom-right corner.
	expect(acrylicWin.bounds).toEqual({
		x: DOCK.x - 144,
		y: DOCK.y - 40,
		width: 144,
		height: 40,
	});

	const mica = await backgroundScenario({
		platform: "win32",
		prefs: { "island-appearance": background("mica"), ...EDGE },
	});
	expect(mica.stderr).toBe("");
	const [micaWin] = mica.windows;
	expect(micaWin.kind).toBe("MicaBrowserWindow");
	expect(micaWin.options).toEqual(material);
	expect(names(micaWin.calls).slice(0, 3)).toEqual([
		"setDarkTheme",
		"setRoundedCorner",
		"setMicaAcrylicEffect",
	]);
	expect(names(micaWin.calls)).not.toContain("setIgnoreMouseEvents");

	const mac = await backgroundScenario({
		platform: "darwin",
		prefs: { "island-appearance": background("acrylic"), ...EDGE },
	});
	expect(mac.stderr).toBe("");
	const [macWin] = mac.windows;
	expect(macWin.options).toEqual({
		...material,
		vibrancy: "sidebar",
		visualEffectState: "active",
	});
	expect(names(macWin.calls)).not.toContain("setIgnoreMouseEvents");
}, 60_000);

test("switching Background in Settings rebuilds the running Island window, both ways", async () => {
	const run = await backgroundScenario(
		{
			platform: "win32",
			prefs: { "island-appearance": background("acrylic"), ...EDGE },
		},
		`
push("island-appearance",${JSON.stringify(background("translucent"))});
await until("toTranslucent",()=>ready(2));
await Bun.sleep(20);
observed.readTranslucent=await invoke("appearance:get");
windows[1]?.calls.push(["mark"]);
send("win:setContentSize",${JSON.stringify(RESTING_FOOTPRINT)});
send("win:setMaterialShapes",${JSON.stringify(RESTING_FOOTPRINT.shapes)});
push("island-appearance",${JSON.stringify(background("translucent"))});
await Bun.sleep(150);
observed.afterRepeat=windows.length;
push("island-appearance",${JSON.stringify(background("acrylic"))});
await until("toAcrylic",()=>ready(3));
await Bun.sleep(20);
windows[2]?.calls.push(["mark"]);
send("win:setContentSize",${JSON.stringify(RESTING_FOOTPRINT)});
`
	);
	expect(run.stderr).toBe("");
	expect(run.settled).toEqual({
		booted: true,
		toTranslucent: true,
		toAcrylic: true,
	});
	expect(run.windows.map((win) => [win.kind, win.destroyed])).toEqual([
		["BrowserWindow", true],
		["BrowserWindow", true],
		["BrowserWindow", false],
	]);
	const [first, translucent, acrylic] = run.windows;
	expect(first.options.backgroundMaterial).toBe("acrylic");
	// Acrylic → Translucent: the oversized, click-through, material-free window.
	expect(translucent.options).toEqual(TRANSLUCENT_OPTIONS);
	expect(translucent.calls).toContainEqual([
		"setIgnoreMouseEvents",
		true,
		{ forward: true },
	]);
	expect(
		names(translucent.calls).filter((name) => NATIVE_MATERIAL_CALLS.has(name))
	).toEqual([]);
	expect(run.observed.readTranslucent).toBe(background("translucent"));
	// The rebuilt window's IPC is the translucent one: a footprint report does
	// not resize or mask it. The repeated value does not rebuild it again.
	expect(after(translucent.calls, "mark")).toEqual([
		["close"],
		["event", "closed"],
	]);
	expect(run.observed.afterRepeat).toBe(2);
	// Translucent → Acrylic: the native-material window again.
	expect(acrylic.options.backgroundMaterial).toBe("acrylic");
	expect(acrylic.options.width).toBe(144);
	expect(names(acrylic.calls)).not.toContain("setIgnoreMouseEvents");
	expect(names(after(acrylic.calls, "mark"))).toEqual([
		"setBounds",
		"setShape",
	]);
}, 30_000);

/**
 * A stored anchor whose island grows downward from near the bottom of the
 * screen: its resting 144x40 island fits there (inside the 20 px edge offset),
 * but a taller footprint must be pulled up on-screen. The anchor is the
 * island's top-centre point, (960, 960).
 */
const LOW_TOP_ANCHOR: StoredPosition = {
	anchor: { x: 960, y: 960, h: "center", v: "start" },
};
/** Where the window rests for {@link LOW_TOP_ANCHOR}: the group centred, 8 px down. */
const LOW_TOP_WINDOW = { x: 960 - 600 / 2, y: 960 - INSET.top };

test("an expanded Translucent panel grows from its dock inside the fixed window, and glides only when it must be pulled on-screen", async () => {
	// Docked bottom-right, the panel grows up and to the left from the pinned
	// corner inside the fixed window, so the window does not move at all.
	const docked = await backgroundScenario(
		{
			platform: "win32",
			prefs: { "island-appearance": background("translucent"), ...EDGE },
		},
		`
const win=windows.at(-1);
send("win:setContentSize",${JSON.stringify(RESTING_FOOTPRINT)});
win.calls.push(["mark"]);
send("win:setContentSize",{width:400,height:480,expanded:true,shapes:[]});
observed.expanded=await rested("expanded");
send("win:setContentSize",${JSON.stringify(RESTING_FOOTPRINT)});
observed.collapsed=await rested("collapsed");
`
	);
	expect(docked.stderr).toBe("");
	expect(docked.settled).toEqual({
		booted: true,
		expanded: true,
		collapsed: true,
	});
	const dockedWindow = {
		x: TRANSLUCENT_OPTIONS.x,
		y: TRANSLUCENT_OPTIONS.y,
		width: 600,
		height: 620,
	};
	expect(docked.observed.expanded).toEqual(dockedWindow);
	expect(docked.observed.collapsed).toEqual(dockedWindow);
	expect(after(docked.windows[0].calls, "mark")).toEqual([]);

	// Growing down from near the bottom, the 400x480 panel is pulled up so its
	// bottom sits 20 px above the work area's: the window glides there in
	// several steps rather than jumping, then glides back when it collapses.
	const pulled = await backgroundScenario(
		{
			platform: "win32",
			prefs: { "island-appearance": background("translucent"), ...EDGE },
			storedPosition: LOW_TOP_ANCHOR,
		},
		`
const win=windows.at(-1);
send("win:setContentSize",${JSON.stringify(RESTING_FOOTPRINT)});
observed.resting=await rested("resting");
win.calls.push(["mark"]);
send("win:setContentSize",{width:400,height:480,expanded:true,shapes:[]});
observed.expanded=await rested("expanded");
observed.steps=win.calls.filter((call)=>call[0]==="setPosition").length;
send("win:setContentSize",${JSON.stringify(RESTING_FOOTPRINT)});
observed.collapsed=await rested("collapsed");
`
	);
	expect(pulled.stderr).toBe("");
	expect(pulled.settled).toEqual({
		booted: true,
		resting: true,
		expanded: true,
		collapsed: true,
	});
	const [win] = pulled.windows;
	expect(win.options).toEqual({ ...TRANSLUCENT_WINDOW, ...LOW_TOP_WINDOW });
	const restingWindow = { ...LOW_TOP_WINDOW, width: 600, height: 620 };
	expect(pulled.observed.resting).toEqual(restingWindow);
	expect(pulled.observed.expanded).toEqual({
		...restingWindow,
		y: 1040 - 20 - 480 - INSET.top,
	});
	expect(pulled.observed.steps).toBeGreaterThan(2);
	// Collapsing returns to exactly the resting spot, and the window is never
	// resized.
	expect(pulled.observed.collapsed).toEqual(restingWindow);
	expect([...new Set(names(after(win.calls, "mark")))]).toEqual([
		"setPosition",
	]);
}, 30_000);

test("two Background changes in quick succession leave the window and the renderer on the last one", async () => {
	const run = await backgroundScenario(
		{
			platform: "win32",
			prefs: { "island-appearance": background("acrylic"), ...EDGE },
			// Both later pushes land while the first rebuild is still tearing down.
			closeDelayMs: 50,
		},
		`
push("island-appearance",${JSON.stringify(background("mica"))});
await Bun.sleep(1);
push("island-appearance",${JSON.stringify(background("translucent"))});
await Bun.sleep(1);
// A notch-mode change forces a rebuild too; it must keep the requested mode.
push("island-notch-mode","false");
await until("rebuilt",()=>windows.length>=2&&ready(windows.length));
await Bun.sleep(300);
observed.read=await invoke("appearance:get");
`
	);
	expect(run.stderr).toBe("");
	expect(run.settled).toEqual({ booted: true, rebuilt: true });
	const live = run.windows.filter((win) => !win.destroyed);
	expect(live).toHaveLength(1);
	const [win] = live;
	// The last change wins: one rebuild, straight to a plain Translucent window
	// with no native material; the Mica request in between is never built.
	expect(run.windows.map((each) => [each.kind, each.destroyed])).toEqual([
		["BrowserWindow", true],
		["BrowserWindow", false],
	]);
	expect(win.options).toEqual(TRANSLUCENT_OPTIONS);
	expect(
		names(win.calls).filter((name) => NATIVE_MATERIAL_CALLS.has(name))
	).toEqual([]);
	// The renderer is told the mode main built.
	expect(parseAppearance(run.observed.read as string)).toEqual({
		background: "translucent",
	});
}, 30_000);

test("when the startup read of Background fails, the renderer is told the mode main actually built", async () => {
	const run = await backgroundScenario(
		{
			platform: "win32",
			prefs: { "island-appearance": background("translucent"), ...EDGE },
			refuseFirstRead: ["island-appearance"],
		},
		`
observed.read=await invoke("appearance:get");
`
	);
	expect(run.stderr).toBe("");
	expect(run.settled.booted).toBe(true);
	// Core refused the startup read, so main built the default Native glass
	// window; the renderer's later read agrees with it instead of re-reading Core.
	const [win] = run.windows;
	expect(win.options.backgroundMaterial).toBe("acrylic");
	expect(parseAppearance(run.observed.read as string)).toEqual({
		background: "acrylic",
	});
}, 30_000);

interface Bounds {
	height: number;
	width: number;
	x: number;
	y: number;
}
interface JumpRun {
	final: Bounds;
	landings: number;
	opened: Bounds;
	settled: Record<string, boolean>;
	stderr: string;
	whileOpen: Bounds;
}

/**
 * Auto-jump on, two side-by-side displays, the cursor on the first. The
 * renderer reports its resting footprint and then `open`; the cursor moves to
 * the second display for three auto-jump ticks (700 ms each); then the island
 * returns to rest. `landings` counts moves onto the second display.
 */
async function autoJumpRun(
	appearance: string,
	open: { expanded: boolean; height: number; width: number },
	storedPosition?: StoredPosition
): Promise<JumpRun> {
	const run = await backgroundScenario(
		{
			platform: "win32",
			prefs: {
				"island-appearance": background(appearance),
				"island-auto-jump": "true",
				...EDGE,
			},
			storedPosition,
			displays: [PRIMARY, SECOND],
			real: ["auto-jump.ts"],
		},
		`
const win=windows.at(-1);
send("win:setContentSize",${JSON.stringify(RESTING_FOOTPRINT)});
await Bun.sleep(50);
win.calls.push(["mark"]);
send("win:setContentSize",${JSON.stringify({ ...open, shapes: [] })});
observed.opened=await rested("opened");
cursor={x:2880,y:540};
await Bun.sleep(2300);
observed.whileOpen={...win.bounds};
send("win:setContentSize",${JSON.stringify(RESTING_FOOTPRINT)});
await until("landed",()=>win.bounds.x>=1920,5000);
await Bun.sleep(1600);
observed.final={...win.bounds};
observed.landings=win.calls.filter((call)=>(call[0]==="setPosition"&&call[1]>=1920)||(call[0]==="setBounds"&&call[1].x>=1920)).length;
`
	);
	return {
		...(run.observed as Omit<JumpRun, "settled" | "stderr">),
		settled: run.settled,
		stderr: run.stderr,
	};
}

const OPEN_PANEL = { width: 448, height: 480, expanded: true };
const TRANSLUCENT_SIZE = { width: 600, height: 620 };

test("auto-jump leaves an open or shifted Translucent island in place and lands it once on the active display after it rests", async () => {
	const settled = { booted: true, opened: true, landed: true };
	const dockedWindow = { x: TRANSLUCENT_OPTIONS.x, y: TRANSLUCENT_OPTIONS.y };
	// (a) The panel opens from the bottom-right dock. It grows inside the fixed
	// window, so the window stays put; only the expanded state keeps it home.
	const corner = await autoJumpRun("translucent", OPEN_PANEL);
	expect(corner.stderr).toBe("");
	expect(corner.settled).toEqual(settled);
	expect(corner.opened).toEqual({ ...dockedWindow, ...TRANSLUCENT_SIZE });
	expect(corner.whileOpen).toEqual(corner.opened);
	// After it collapses it lands bottom-right on the second display, once.
	expect(corner.final).toEqual({
		x: 1920 + dockedWindow.x,
		y: dockedWindow.y,
		...TRANSLUCENT_SIZE,
	});
	expect(corner.landings).toBe(1);

	// (b) Docked top-centre (an older build's saved window top-left), the open
	// panel grows down from the island's top-centre and fits without shifting.
	const top = await autoJumpRun("translucent", OPEN_PANEL, { x: 660, y: 12 });
	expect(top.stderr).toBe("");
	expect(top.settled).toEqual(settled);
	expect(top.opened).toEqual({ x: 660, y: 12, ...TRANSLUCENT_SIZE });
	expect(top.whileOpen).toEqual(top.opened);
	expect(top.final).toEqual({ x: 1920 + 660, y: 12, ...TRANSLUCENT_SIZE });
	expect(top.landings).toBe(1);

	// (c) A wide compact footprint (a suggestion) growing down from near the
	// bottom is pulled up on-screen without expanding: the shift alone keeps it
	// home. Once it rests it re-docks top-centre on the second display, the zone
	// its placement names.
	const shifted = await autoJumpRun(
		"translucent",
		{ width: 348, height: 100, expanded: false },
		LOW_TOP_ANCHOR
	);
	expect(shifted.stderr).toBe("");
	expect(shifted.settled).toEqual(settled);
	expect(shifted.opened).toEqual({
		x: LOW_TOP_WINDOW.x,
		y: 1040 - 20 - 100 - INSET.top,
		...TRANSLUCENT_SIZE,
	});
	expect(shifted.whileOpen).toEqual(shifted.opened);
	expect(shifted.final).toEqual(top.final);
	expect(shifted.landings).toBe(1);
}, 90_000);

test("auto-jump keeps leaving an open Native glass panel in place", async () => {
	const run = await autoJumpRun("acrylic", OPEN_PANEL);
	expect(run.stderr).toBe("");
	expect(run.settled).toEqual({ booted: true, opened: true, landed: true });
	expect(run.opened).toEqual({
		x: 1920 - 20 - 448,
		y: 1040 - 20 - 480,
		width: 448,
		height: 480,
	});
	expect(run.whileOpen).toEqual(run.opened);
	expect(run.final).toEqual({
		x: 1920 + 1920 - 20 - 144,
		y: 1040 - 20 - 40,
		width: 144,
		height: 40,
	});
	expect(run.landings).toBe(1);
}, 60_000);

test("auto-jump never moves an Island that is being dragged; it lands once after the drag ends", async () => {
	const run = await backgroundScenario(
		{
			platform: "win32",
			prefs: {
				"island-appearance": background("translucent"),
				"island-auto-jump": "true",
				...EDGE,
			},
			displays: [PRIMARY, SECOND],
			real: ["auto-jump.ts"],
		},
		`
const win=windows.at(-1);
send("win:setContentSize",${JSON.stringify(RESTING_FOOTPRINT)});
await Bun.sleep(50);
win.calls.push(["mark"]);
// The pointer goes down on the resting island and starts dragging it; the
// window is held near the seam while the cursor sits on the second display.
send("win:dragStart");
cursor={x:2880,y:540};
await Bun.sleep(2300);
observed.duringDrag={...win.bounds};
observed.movesDuringDrag=win.calls.slice(win.calls.findIndex((call)=>call[0]==="mark")).filter((call)=>call[0]==="setPosition").length;
send("win:dragEnd");
await until("landed",()=>win.bounds.x>=1920,5000);
await Bun.sleep(1600);
observed.final={...win.bounds};
observed.landings=win.calls.filter((call)=>call[0]==="setPosition"&&call[1]>=1920).length;
`
	);
	expect(run.stderr).toBe("");
	expect(run.settled).toEqual({ booted: true, landed: true });
	expect(run.observed.movesDuringDrag).toBe(0);
	expect(run.observed.duringDrag).toEqual({
		x: TRANSLUCENT_OPTIONS.x,
		y: TRANSLUCENT_OPTIONS.y,
		...TRANSLUCENT_SIZE,
	});
	expect(run.observed.final).toEqual({
		x: 1920 + TRANSLUCENT_OPTIONS.x,
		y: TRANSLUCENT_OPTIONS.y,
		...TRANSLUCENT_SIZE,
	});
	expect(run.observed.landings).toBe(1);
}, 60_000);

test("quitting while a Background rebuild is tearing down builds no new window", async () => {
	const run = await backgroundScenario(
		{
			platform: "win32",
			prefs: { "island-appearance": background("acrylic"), ...EDGE },
			closeDelayMs: 50,
		},
		`
push("island-appearance",${JSON.stringify(background("translucent"))});
await until("closing",()=>windows[0].calls.some((call)=>call[0]==="close"));
appEvent("before-quit");
await Bun.sleep(300);
`
	);
	expect(run.stderr).toBe("");
	expect(run.settled).toEqual({ booted: true, closing: true });
	expect(run.windows.map((win) => [win.kind, win.destroyed])).toEqual([
		["BrowserWindow", true],
	]);
}, 30_000);

test("a rebuild whose new window fails to build does not block the next Background change", async () => {
	const run = await backgroundScenario(
		{
			platform: "win32",
			prefs: { "island-appearance": background("acrylic"), ...EDGE },
			// The first rebuild's window construction throws.
			failWindowBuilds: [2],
		},
		`
push("island-appearance",${JSON.stringify(background("translucent"))});
await until("failed",()=>windows[0].calls.some((call)=>call[0]==="handlerError"));
push("island-appearance",${JSON.stringify(background("mica"))});
await until("rebuilt",()=>windows.length>=2&&ready(windows.length));
await Bun.sleep(100);
`
	);
	expect(run.stderr).toBe("");
	expect(run.settled).toEqual({ booted: true, failed: true, rebuilt: true });
	// The failure is logged on the old window's close, like any handler error.
	expect(run.windows[0].calls).toContainEqual([
		"handlerError",
		"window build failed",
	]);
	// The next change still rebuilds: Mica is built and live.
	expect(run.windows.map((win) => [win.kind, win.destroyed])).toEqual([
		["BrowserWindow", true],
		["MicaBrowserWindow", false],
	]);
}, 30_000);

test("re-activating the app after the Island window was closed rebuilds it with its drag overlay", async () => {
	const run = await backgroundScenario(
		{
			platform: "darwin",
			prefs: { "island-appearance": background("translucent"), ...EDGE },
		},
		`
observed.overlaysAtBoot=globalThis.overlayInits??0;
// Something other than a rebuild closes the only window (macOS keeps the app).
windows[0].close();
await until("closed",()=>windows[0].destroyed);
appEvent("activate");
await until("reattached",()=>windows.length>=2&&ready(2));
observed.overlaysAfter=globalThis.overlayInits??0;
`
	);
	expect(run.stderr).toBe("");
	expect(run.settled).toEqual({ booted: true, closed: true, reattached: true });
	const [, reattached] = run.windows;
	expect(reattached.options).toEqual(TRANSLUCENT_OPTIONS);
	// The closed window took its snap-zone overlay with it; a new one is built.
	expect(run.observed.overlaysAfter).toBe(
		(run.observed.overlaysAtBoot as number) + 1
	);
}, 30_000);
