import { expect, test } from "bun:test";
import { join } from "node:path";
import { runIsolatedIslandScenario } from "./island-isolated-runtime.ts";

// Boots the shipping Island main process (`index.ts`) in its own Bun runtime
// against owned native HTTP Core fixtures (preferences, the preference SSE
// stream, plugin contributions). Every service the shortcut wiring uses is real:
// config, preferences and their stream, voice prefs, the plugin-shortcut
// refresh, registrar and plugin-host client. Replaced are only Electron itself
// (`globalShortcut` becomes an OS ledger that refuses a taken accelerator, and
// one fake window records what is sent to the renderer) and the window/OS
// modules that need a real display or native hooks. Key presses invoke the
// registered handler, so ownership is read from what the renderer receives.
const MAIN = import.meta.dirname;
const ELECTRON = Bun.resolveSync("electron", MAIN);
const TOKEN = "island-wiring-token";
const STUBS: Record<string, string> = {
	"auto-jump.ts": "initAutoJump(){},jumpNow(){},setAutoJump(){}",
	"control.ts": "startControlServer(){},stopControlServer(){}",
	"cursor-tracker.ts": "attachCursorTracking(){}",
	"edge-offset.ts": "setEdgeOffset(){}",
	"fullscreen.ts": "initFullscreenHide(){},setHideOnFullscreen(){}",
	"ghost-cursor.ts": "destroyGhostCursor(){}",
	"ipc/index.ts": "registerIpc(){}",
	"notch.ts":
		"isNotchModeEnabled(){return false;},refreshNotchGeometry(){},setNotchMode(){}",
	"overlay.ts": "initZoneOverlay(){},setOverlayContentProtection(){}",
	"position.ts": "applyEdgeOffset(){}",
	"visibility.ts":
		"focusForCommand(){},hideWindow(){},setAppActivator(){},setVisibilityTarget(){},showWindow(){}",
	"voice-control.ts":
		"acceleratorPrimaryKeycode(){return null;},configureHold(){},isHoldArmed(){return false;},noteHoldPressed(){},setRecording(){},setTabCycle(){},stopHooks(){}",
	"window.ts": "createIslandWindow(){return window;}",
};
const companion = (id: string, shortcut: string) => ({
	id: `${id}-companion`,
	plugin_id: id,
	label: id,
	shortcut,
});
const ALPHA = companion("alpha", "Mod+Alt+A");
const BETA = companion("beta", "Mod+Alt+B");
/** Defaults to dictation's own chord, so it is withheld while dictation is on. */
const GAMMA = companion("gamma", "Mod+Shift+D");
/** The only plugin Core two enables. */
const DELTA = companion("delta", "Mod+Alt+G");

interface Exchange {
	at: number;
	core: string;
	method: string;
	path: string;
}
interface WiringRun {
	exchanges: Exchange[];
	ledger: string[][];
	marks: Record<string, number>;
	owners: Record<string, Record<string, string>>;
	settled: Record<string, boolean>;
	stderr: string;
}

/**
 * `prefs` seeds Core one's preference store and `companions` its enabled
 * plugins (Core two enables only delta). The body drives Core
 * (`cores.one.companions = …`, `push(key, value)` on the live stream), the
 * Island (`saveConfig`, `quit()`), waits on the OS ledger (`waitFor`) and
 * records `owners(name)`: which surface each live chord reaches when pressed.
 */
async function wiringScenario(
	{
		prefs = {},
		companions = [ALPHA, BETA],
	}: {
		prefs?: Record<string, string>;
		companions?: ReturnType<typeof companion>[];
	},
	body: string,
	budgetMs = 12_000
): Promise<WiringRun> {
	const { result, stderr } = await runIsolatedIslandScenario(
		(root) => `
import {mock} from "bun:test";
import {writeFileSync} from "node:fs";
const exchanges=[];const ledger=[];const marks={};const settled={};const ownersSeen={};
const started=performance.now();
function fixture(name,companions,prefs){
 const core={name,companions,prefs:new Map(Object.entries(prefs)),streams:new Set()};
 core.server=Bun.serve({hostname:"127.0.0.1",port:0,idleTimeout:0,async fetch(req){
  const path=new URL(req.url).pathname;
  exchanges.push({core:name,method:req.method,path,at:performance.now()-started});
  if(req.headers.get("authorization")!==${JSON.stringify(`Bearer ${TOKEN}`)}){return Response.json({error:"unauthorized"},{status:401});}
  if(path==="/api/preferences/stream"){
   let sink;
   const body=new ReadableStream({start(controller){sink=controller;core.streams.add(controller);controller.enqueue(new TextEncoder().encode(": ok\\n\\n"));},cancel(){core.streams.delete(sink);}});
   return new Response(body,{headers:{"Content-Type":"text/event-stream"}});
  }
  if(path==="/api/plugins/contributions"){return Response.json({companions:core.companions,views:[]});}
  if(path.startsWith("/api/preferences/")){
   const key=decodeURIComponent(path.slice("/api/preferences/".length));
   if(req.method==="PUT"){core.prefs.set(key,(await req.json()).value);return Response.json({ok:true});}
   return core.prefs.has(key)?Response.json({key,value:core.prefs.get(key)}):Response.json({error:"not found"},{status:404});
  }
  return Response.json({error:"not found"},{status:404});
 }});
 core.base=core.server.url.toString().replace(/\\/$/,"");
 return core;
}
const cores={
 one:fixture("one",${JSON.stringify(companions)},${JSON.stringify(prefs)}),
 two:fixture("two",${JSON.stringify([DELTA])},{}),
};
function push(key,value){
 cores.one.prefs.set(key,value);
 const frame=new TextEncoder().encode("data: "+JSON.stringify({key,value})+"\\n\\n");
 for(const stream of cores.one.streams){stream.enqueue(frame);}
}
writeFileSync(${JSON.stringify(join(root, "island-services.json"))},JSON.stringify({coreBaseUrl:cores.one.base,coreToken:${JSON.stringify(TOKEN)}}));
const active=new Map();const sent=[];const appHandlers=new Map();
const window={isDestroyed:()=>false,isVisible:()=>false,isFocused:()=>false,setContentProtection(){},on(){},once(){},close(){},webContents:{send:(channel,...args)=>sent.push([channel,...args]),isDevToolsOpened:()=>false}};
mock.module(${JSON.stringify(ELECTRON)},()=>({
 app:{getPath:()=>${JSON.stringify(root)},setName(){},dock:undefined,focus(){},requestSingleInstanceLock:()=>true,whenReady:()=>Promise.resolve(),quit(){},getVersion:()=>"0.0.0",isPackaged:false,
  on(event,handler){const list=appHandlers.get(event)??[];list.push(handler);appHandlers.set(event,list);}},
 BrowserWindow:{getAllWindows:()=>[window]},
 globalShortcut:{
  register(accelerator,handler){ledger.push(["register",accelerator]);if(active.has(accelerator)){return false;}active.set(accelerator,handler);return true;},
  unregister(accelerator){ledger.push(["unregister",accelerator]);active.delete(accelerator);},
  unregisterAll(){ledger.push(["unregisterAll"]);active.clear();},
 },
 ipcMain:{on(){},handle(){}},
 screen:{on(){}},
}));
${Object.entries(STUBS)
	.map(
		([file, members]) =>
			`mock.module(${JSON.stringify(join(MAIN, file))},()=>({${members}}));`
	)
	.join("\n")}
const {saveConfig}=await import(${JSON.stringify(join(MAIN, "services/config.ts"))});
async function until(name,predicate,ms){const end=Date.now()+ms;while(!predicate()){if(Date.now()>end){settled[name]=false;return;}await Bun.sleep(5);}settled[name]=true;}
const mark=(name)=>{marks[name]=ledger.length;};
const since=(name)=>ledger.slice(marks[name]);
async function waitFor(name,call,ms=3000){await until(name,()=>since(name).some((entry)=>entry[0]===call[0]&&entry[1]===call[1]),ms);await Bun.sleep(20);}
const LABELS={"command:open":()=>"command","plugins:shortcut":(id)=>"plugin:"+id,"voice:toggle":()=>"voice","dictation:toggle":()=>"dictation"};
function owners(name){
 const seen={};
 for(const [accelerator,handler] of [...active.entries()]){
  const before=sent.length;handler();
  seen[accelerator]=sent.slice(before).map(([channel,...args])=>(LABELS[channel]??(()=>channel))(...args)).join(",");
 }
 ownersSeen[name]=seen;
}
function quit(){for(const handler of appHandlers.get("will-quit")??[]){handler();}}
const reads=(core,path)=>exchanges.filter((exchange)=>exchange.core===core&&exchange.path===path).length;
await import(${JSON.stringify(join(MAIN, "index.ts"))});
await until("booted",()=>reads("one","/api/plugins/contributions")>=1&&cores.one.streams.size>0&&ledger.some((entry)=>entry[1]==="CommandOrControl+Alt+B"),5000);
await Bun.sleep(50);
${body}
const output=JSON.stringify({exchanges,ledger,marks,owners:ownersSeen,settled});
await new Promise((resolve)=>process.stdout.write(output,resolve));
process.exit(0);
`,
		budgetMs
	);
	return { ...(result as Omit<WiringRun, "stderr">), stderr };
}

const VOICE_V = JSON.stringify({
	enabled: true,
	mode: "toggle",
	shortcut: "CommandOrControl+Shift+V",
});

test("rebinding the command, push-to-talk or dictation chord in settings takes a plugin's chord and hands freed chords back to plugins", async () => {
	const run = await wiringScenario(
		{
			prefs: {
				"island-command-shortcut": "CommandOrControl+Alt+A",
				"voice-input": VOICE_V,
			},
			companions: [ALPHA, BETA, GAMMA],
		},
		`
owners("boot");
mark("command");push("island-command-shortcut","CommandOrControl+Alt+B");
await waitFor("command",["register","CommandOrControl+Alt+B"]);owners("command");
mark("voice");push("voice-input",JSON.stringify({enabled:true,mode:"toggle",shortcut:"CommandOrControl+Alt+A"}));
await waitFor("voice",["register","CommandOrControl+Alt+A"]);owners("voice");
mark("dictation");push("dictation",JSON.stringify({enabled:false}));
await waitFor("dictation",["unregister","CommandOrControl+Shift+D"]);owners("dictation");
mark("voiceBack");push("voice-input",${JSON.stringify(VOICE_V)});
await waitFor("voiceBack",["register","CommandOrControl+Shift+V"]);owners("voiceBack");
mark("end");
`
	);
	expect(run.stderr).toBe("");
	expect(run.settled.booted).toBe(true);
	// Boot: alpha's default A is withheld because the command summon owns it,
	// and gamma's default D because dictation owns it.
	expect(run.owners.boot).toEqual({
		"CommandOrControl+Alt+A": "command",
		"CommandOrControl+Alt+B": "plugin:beta-companion",
		"CommandOrControl+Shift+V": "voice",
		"CommandOrControl+Shift+D": "dictation",
	});
	for (const step of ["command", "voice", "dictation", "voiceBack"]) {
		expect({ step, settled: run.settled[step] }).toEqual({
			step,
			settled: true,
		});
	}
	// The command summon moves onto beta's chord and still opens the command
	// bar; alpha immediately receives the chord the command gave up.
	expect(run.owners.command).toEqual({
		"CommandOrControl+Alt+A": "plugin:alpha-companion",
		"CommandOrControl+Alt+B": "command",
		"CommandOrControl+Shift+V": "voice",
		"CommandOrControl+Shift+D": "dictation",
	});
	// Push-to-talk wins alpha's chord the same way.
	expect(run.owners.voice).toEqual({
		"CommandOrControl+Alt+A": "voice",
		"CommandOrControl+Alt+B": "command",
		"CommandOrControl+Shift+D": "dictation",
	});
	// Turning dictation off frees its chord, and gamma receives it.
	expect(run.owners.dictation).toEqual({
		"CommandOrControl+Alt+A": "voice",
		"CommandOrControl+Alt+B": "command",
		"CommandOrControl+Shift+D": "plugin:gamma-companion",
	});
	// Push-to-talk moving away hands A straight back to alpha.
	expect(run.owners.voiceBack).toEqual({
		"CommandOrControl+Alt+A": "plugin:alpha-companion",
		"CommandOrControl+Alt+B": "command",
		"CommandOrControl+Shift+V": "voice",
		"CommandOrControl+Shift+D": "plugin:gamma-companion",
	});
	// Re-applying the acknowledged plugin snapshot needs no Core round trip:
	// the startup read is the only contributions read.
	expect(
		run.exchanges.filter(
			(exchange) => exchange.path === "/api/plugins/contributions"
		)
	).toHaveLength(1);
}, 20_000);

test("a saved-shortcut event and a switch to another Core re-read plugin shortcuts; quitting releases every chord and stops re-reads", async () => {
	const run = await wiringScenario(
		{},
		`
owners("boot");
mark("keybindings");push("keybindings",JSON.stringify({"plugin:beta":"CommandOrControl+Alt+J"}));
await waitFor("keybindings",["register","CommandOrControl+Alt+J"]);owners("keybindings");
mark("switch");saveConfig({coreBaseUrl:cores.two.base});
await waitFor("switch",["register","CommandOrControl+Alt+G"]);owners("switch");
mark("quit");quit();
const quitAt=exchanges.length;
saveConfig({coreBaseUrl:cores.one.base});
push("keybindings",JSON.stringify({"plugin:beta":"CommandOrControl+Alt+K"}));
await Bun.sleep(300);
marks.afterQuitReads=exchanges.slice(quitAt).filter((exchange)=>exchange.path==="/api/plugins/contributions"||exchange.path==="/api/preferences/keybindings").length;
owners("afterQuit");
`
	);
	expect(run.stderr).toBe("");
	expect(run.settled.booted).toBe(true);
	expect(run.owners.boot).toEqual({
		"CommandOrControl+Alt+A": "plugin:alpha-companion",
		"CommandOrControl+Alt+B": "plugin:beta-companion",
		"CommandOrControl+Shift+Space": "command",
		"CommandOrControl+Shift+A": "voice",
		"CommandOrControl+Shift+D": "dictation",
	});
	expect(run.settled.keybindings).toBe(true);
	expect(run.owners.keybindings).toEqual({
		"CommandOrControl+Alt+A": "plugin:alpha-companion",
		"CommandOrControl+Alt+J": "plugin:beta-companion",
		"CommandOrControl+Shift+Space": "command",
		"CommandOrControl+Shift+A": "voice",
		"CommandOrControl+Shift+D": "dictation",
	});
	// Core two enables only delta and has no saved shortcuts: Core one's chords
	// (including beta's saved J) are released and delta's default is registered.
	expect(run.settled.switch).toBe(true);
	expect(run.owners.switch).toEqual({
		"CommandOrControl+Alt+G": "plugin:delta-companion",
		"CommandOrControl+Shift+Space": "command",
		"CommandOrControl+Shift+A": "voice",
		"CommandOrControl+Shift+D": "dictation",
	});
	expect(run.ledger.slice(run.marks.switch, run.marks.quit)).toEqual([
		["unregister", "CommandOrControl+Alt+A"],
		["unregister", "CommandOrControl+Alt+J"],
		["register", "CommandOrControl+Alt+G"],
	]);
	expect(
		run.exchanges
			.filter(
				(exchange) =>
					exchange.path === "/api/plugins/contributions" ||
					exchange.path === "/api/preferences/keybindings"
			)
			.map(({ core, path }) => `${core}${path}`)
			.slice(-2)
			.sort()
	).toEqual([
		"two/api/plugins/contributions",
		"two/api/preferences/keybindings",
	]);
	// Quitting releases every chord at once; later Core switches and saved
	// shortcut events never read Core or register a chord again.
	expect(run.ledger.slice(run.marks.quit)).toEqual([["unregisterAll"]]);
	expect(run.marks.afterQuitReads).toBe(0);
	expect(run.owners.afterQuit).toEqual({});
}, 20_000);

test("a plugin disabled in Core loses its chord on the shipping poll cadence with no preference event", async () => {
	const run = await wiringScenario(
		{},
		`
mark("disable");cores.one.companions=[${JSON.stringify(ALPHA)}];
await waitFor("disable",["unregister","CommandOrControl+Alt+B"],13000);
owners("disabled");
`,
		16_000
	);
	expect(run.stderr).toBe("");
	expect(run.settled.disable).toBe(true);
	expect(run.owners.disabled).toEqual({
		"CommandOrControl+Alt+A": "plugin:alpha-companion",
		"CommandOrControl+Shift+Space": "command",
		"CommandOrControl+Shift+A": "voice",
		"CommandOrControl+Shift+D": "dictation",
	});
	const contributionReads = run.exchanges.filter(
		(exchange) => exchange.path === "/api/plugins/contributions"
	);
	// One startup read and one idle re-read 10 s later; nothing in between.
	expect(contributionReads).toHaveLength(2);
	const gap = (contributionReads[1]?.at ?? 0) - (contributionReads[0]?.at ?? 0);
	expect(gap).toBeGreaterThanOrEqual(9900);
	expect(gap).toBeLessThan(12_000);
	expect(run.ledger.slice(run.marks.disable)).toEqual([
		["unregister", "CommandOrControl+Alt+A"],
		["unregister", "CommandOrControl+Alt+B"],
		["register", "CommandOrControl+Alt+A"],
	]);
}, 20_000);
