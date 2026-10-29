import { expect, test } from "bun:test";
import { join } from "node:path";
import { runIsolatedIslandScenario } from "../island-isolated-runtime.ts";

// The shipping refresh (`plugin-shortcuts.ts`), registrar, plugin-host client
// and config run in their own Bun runtime against an owned native HTTP Core
// fixture. Only Electron is replaced: `app.getPath` gives the real config a
// private userData directory, and an OS ledger stands in for `globalShortcut`
// (register answers a boolean, a taken accelerator is refused, unregister
// releases it). Island-owned chords (the command summon) are registered on the
// same ledger exactly like `index.ts` does, so collisions are real.
const SERVICES = import.meta.dirname;
const ELECTRON = Bun.resolveSync("electron", SERVICES);
const TOKEN = "island-lifecycle-token";
const ALPHA = {
	id: "alpha-companion",
	plugin_id: "alpha",
	label: "Alpha",
	shortcut: "Mod+Alt+A",
};
const BETA = {
	id: "beta-companion",
	plugin_id: "beta",
	label: "Beta",
	shortcut: "Mod+Alt+B",
};
const GAMMA = {
	id: "gamma-companion",
	plugin_id: "gamma",
	label: "Gamma",
	shortcut: "Mod+Alt+G",
};

interface Exchange {
	authorization: string | null;
	path: string;
	status: number;
}
interface Step {
	active: Record<string, string>;
	calls: [string, string][];
	exchanges: Exchange[];
}
interface LifecycleRun {
	dispatched: string[];
	settled: Record<string, boolean>;
	stderr: string;
	steps: Record<string, Step>;
}

/**
 * `options` is spliced verbatim as the refresh's second argument. The scenario
 * body drives Core (`core({companions, contributions, keybindings})`), the
 * refresh (`step`, `rebind`, `quit`), the Island-owned command chord
 * (`bindCommand`) and key presses (`press`), and records `observe(name)`
 * snapshots of the OS ledger and the Core reads since the previous snapshot.
 */
async function lifecycleScenario(
	options: string,
	body: string,
	budgetMs = 10_000
): Promise<LifecycleRun> {
	const { result, stderr } = await runIsolatedIslandScenario(
		(root) => `
import {mock} from "bun:test";
import {writeFileSync} from "node:fs";
const state={companions:${JSON.stringify([ALPHA, BETA])},contributions:200,keybindings:{status:200,value:null}};
let exchanges=[];
const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(req){
 const path=new URL(req.url).pathname;
 const authorization=req.headers.get("authorization");
 const exchange={path,authorization,status:200};
 exchanges.push(exchange);
 if(req.method!=="GET"||authorization!==${JSON.stringify(`Bearer ${TOKEN}`)}){exchange.status=401;return Response.json({error:"unauthorized"},{status:401});}
 if(path==="/api/plugins/contributions"){
  exchange.status=state.contributions;
  return state.contributions===200?Response.json({companions:state.companions,views:[]}):Response.json({error:"plugin host unavailable"},{status:state.contributions});
 }
 if(path==="/api/preferences/keybindings"){
  exchange.status=state.keybindings.status;
  return state.keybindings.status===200?Response.json({key:"keybindings",value:state.keybindings.value}):Response.json({error:"preference store unavailable"},{status:state.keybindings.status});
 }
 exchange.status=404;return Response.json({error:"undeclared"},{status:404});
}});
const base=server.url.toString().replace(/\\/$/,"");
writeFileSync(${JSON.stringify(join(root, "island-services.json"))},JSON.stringify({coreBaseUrl:base,coreToken:${JSON.stringify(TOKEN)}}));
mock.module(${JSON.stringify(ELECTRON)},()=>({app:{getPath:()=>${JSON.stringify(root)}}}));
const {createPluginShortcutRefresh}=await import(${JSON.stringify(join(SERVICES, "plugin-shortcuts.ts"))});
const {createPluginShortcutRegistrar}=await import(${JSON.stringify(join(SERVICES, "plugin-shortcut-registration.ts"))});
const active=new Map();const calls=[];const dispatched=[];
const os={
 register(accelerator,handler,owner){calls.push(["register",accelerator]);if(active.has(accelerator)){return false;}active.set(accelerator,{handler,owner});return true;},
 unregister(accelerator){calls.push(["unregister",accelerator]);active.delete(accelerator);},
};
const registrar=createPluginShortcutRegistrar({
 register:(accelerator,handler)=>os.register(accelerator,handler,"plugin"),
 unregister:(accelerator)=>os.unregister(accelerator),
 focus(){dispatched.push("focus");},
 sendShortcut(id){dispatched.push(id);},
});
// Island-owned chords, as index.ts computes them at apply time.
let command=null;
const refresh=createPluginShortcutRefresh((result,overrides)=>registrar(result,overrides,command?[command]:[]),${options});
// Old builds have no rebindReserved: the change then runs bare, so a missing
// implementation fails on behaviour (a refused or stranded chord), not a TypeError.
const rebind=(change)=>refresh.rebindReserved?refresh.rebindReserved(change):change();
// Mirrors index.ts applyCommandShortcut: release the previous chord, then bind the
// next one; the command owns a chord only when the OS accepted it.
function bindCommand(next){
 if(command){os.unregister(command);command=null;}
 if(next&&os.register(next,()=>dispatched.push("command"),"command")){command=next;}
}
function press(accelerator){active.get(accelerator)?.handler();}
function quit(){refresh.dispose?.();for(const accelerator of [...active.keys()]){active.delete(accelerator);}calls.push(["unregisterAll",""]);}
const core=(patch)=>{Object.assign(state,patch);};
const steps={};const settled={};
function observe(name){
 steps[name]={active:Object.fromEntries([...active.entries()].map(([accelerator,entry])=>[accelerator,entry.owner]).sort()),calls:calls.splice(0),exchanges};
 exchanges=[];
}
async function step(name,patch={}){core(patch);await refresh();observe(name);}
async function until(name,predicate,ms){const end=Date.now()+ms;while(!predicate()){if(Date.now()>end){settled[name]=false;return;}await Bun.sleep(5);}settled[name]=true;}
try{
${body}
 process.stdout.write(JSON.stringify({steps,settled,dispatched}));
}finally{server.stop(true);}
`,
		budgetMs
	);
	return { ...(result as Omit<LifecycleRun, "stderr">), stderr };
}

const paired = (keybindingsStatus = 200) => [
	{
		path: "/api/plugins/contributions",
		authorization: `Bearer ${TOKEN}`,
		status: 200,
	},
	{
		path: "/api/preferences/keybindings",
		authorization: `Bearer ${TOKEN}`,
		status: keybindingsStatus,
	},
];
const sorted = (exchanges: Exchange[]) =>
	[...exchanges].sort((a, b) => a.path.localeCompare(b.path));

test("a plugin disabled or enabled in Core reaches the OS chords on the next poll with no preference event, and a saved chord survives the round trip", async () => {
	const run = await lifecycleScenario(
		"{pollIntervalMs:50,retryDelayMs:20,maxRetryDelayMs:40}",
		`
await step("startup",{keybindings:{status:200,value:JSON.stringify({"plugin:beta":"CommandOrControl+Alt+J"})}});
core({companions:[${JSON.stringify(ALPHA)}]});
await until("betaDisabled",()=>!active.has("CommandOrControl+Alt+J"),3000);
observe("betaDisabled");
press("CommandOrControl+Alt+J");
core({companions:[${JSON.stringify(ALPHA)},${JSON.stringify(BETA)},${JSON.stringify(GAMMA)}]});
await until("reEnabled",()=>active.has("CommandOrControl+Alt+J")&&active.has("CommandOrControl+Alt+G"),3000);
observe("reEnabled");
await Bun.sleep(400);
observe("quiet");
press("CommandOrControl+Alt+J");
press("CommandOrControl+Alt+G");
press("CommandOrControl+Alt+B");
`
	);
	expect(run.stderr).toBe("");
	expect(run.steps.startup.active).toEqual({
		"CommandOrControl+Alt+A": "plugin",
		"CommandOrControl+Alt+J": "plugin",
	});
	expect(sorted(run.steps.startup.exchanges)).toEqual(paired());
	// Only time passed: the refresh re-read Core and released the disabled
	// plugin's chord without touching anything else's ownership.
	expect(run.settled.betaDisabled).toBe(true);
	expect(run.steps.betaDisabled.active).toEqual({
		"CommandOrControl+Alt+A": "plugin",
	});
	expect(run.steps.betaDisabled.calls).toEqual([
		["unregister", "CommandOrControl+Alt+A"],
		["unregister", "CommandOrControl+Alt+J"],
		["register", "CommandOrControl+Alt+A"],
	]);
	// Re-enabled beta gets the user's saved chord back, never its default B;
	// newly enabled gamma gets its manifest default.
	expect(run.settled.reEnabled).toBe(true);
	expect(run.steps.reEnabled.active).toEqual({
		"CommandOrControl+Alt+A": "plugin",
		"CommandOrControl+Alt+G": "plugin",
		"CommandOrControl+Alt+J": "plugin",
	});
	// Unchanged polls keep reading Core (paired, authenticated) but make no OS
	// calls: an enabled set that did not change never churns the chords.
	const quietReads = run.steps.quiet.exchanges;
	expect(quietReads.length).toBeGreaterThanOrEqual(4);
	expect(quietReads.length % 2).toBe(0);
	for (const read of quietReads) {
		expect(read.authorization).toBe(`Bearer ${TOKEN}`);
		expect(read.status).toBe(200);
	}
	expect(run.steps.quiet.calls).toEqual([]);
	expect(run.dispatched).toEqual([
		"focus",
		"beta-companion",
		"focus",
		"gamma-companion",
	]);
}, 15_000);

test("a poll that cannot read the saved shortcut document keeps acknowledged chords instead of applying the new plugin set", async () => {
	const run = await lifecycleScenario(
		"{pollIntervalMs:50,retryDelayMs:20,maxRetryDelayMs:40}",
		`
await step("startup",{keybindings:{status:200,value:JSON.stringify({"plugin:alpha":null})}});
core({companions:[${JSON.stringify(ALPHA)}],keybindings:{status:503}});
await until("refusedPolls",()=>exchanges.filter((read)=>read.path==="/api/preferences/keybindings").length>=3,3000);
observe("refused");
core({keybindings:{status:200,value:JSON.stringify({"plugin:alpha":null})}});
await until("readable",()=>!active.has("CommandOrControl+Alt+B"),3000);
observe("readable");
`
	);
	expect(run.stderr).toBe("");
	expect(run.steps.startup.active).toEqual({
		"CommandOrControl+Alt+B": "plugin",
	});
	expect(run.settled.refusedPolls).toBe(true);
	// Beta was disabled, but the saved document could not be read: nothing is
	// applied (no default for the user-cleared alpha chord, no OS calls).
	expect(run.steps.refused.active).toEqual({
		"CommandOrControl+Alt+B": "plugin",
	});
	expect(run.steps.refused.calls).toEqual([]);
	for (const read of run.steps.refused.exchanges.filter(
		(exchange) => exchange.path === "/api/preferences/keybindings"
	)) {
		expect(read.status).toBe(503);
	}
	// Once the document reads again, the disabled plugin's chord is released and
	// alpha's cleared chord stays cleared.
	expect(run.settled.readable).toBe(true);
	expect(run.steps.readable.active).toEqual({});
	expect(run.steps.readable.calls).toEqual([
		["unregister", "CommandOrControl+Alt+B"],
	]);
}, 15_000);

test("rebinding an Island-owned chord releases a plugin's chord to it, hands a freed chord back to its plugin, and reads nothing from Core", async () => {
	const run = await lifecycleScenario(
		"{pollIntervalMs:60000}",
		`
bindCommand("CommandOrControl+Alt+A");
observe("command");
await step("startup");
rebind(()=>bindCommand("CommandOrControl+Alt+B"));
observe("commandTakesBeta");
press("CommandOrControl+Alt+A");
press("CommandOrControl+Alt+B");
rebind(()=>bindCommand("CommandOrControl+Alt+C"));
observe("commandMoves");
press("CommandOrControl+Alt+A");
press("CommandOrControl+Alt+B");
press("CommandOrControl+Alt+C");
`
	);
	expect(run.stderr).toBe("");
	// Startup: the command summon owns A, so alpha's default A is withheld.
	expect(run.steps.startup.active).toEqual({
		"CommandOrControl+Alt+A": "command",
		"CommandOrControl+Alt+B": "plugin",
	});
	expect(run.steps.startup.calls).toEqual([
		["register", "CommandOrControl+Alt+B"],
	]);
	// The command moves onto beta's chord: beta yields it before the command
	// binds, and alpha immediately gets the chord the command freed.
	expect(run.steps.commandTakesBeta.active).toEqual({
		"CommandOrControl+Alt+A": "plugin",
		"CommandOrControl+Alt+B": "command",
	});
	expect(run.steps.commandTakesBeta.calls).toEqual([
		["unregister", "CommandOrControl+Alt+B"],
		["unregister", "CommandOrControl+Alt+A"],
		["register", "CommandOrControl+Alt+B"],
		["register", "CommandOrControl+Alt+A"],
	]);
	// Re-applying the acknowledged snapshot needs no Core read.
	expect(run.steps.commandTakesBeta.exchanges).toEqual([]);
	expect(run.steps.commandMoves.active).toEqual({
		"CommandOrControl+Alt+A": "plugin",
		"CommandOrControl+Alt+B": "plugin",
		"CommandOrControl+Alt+C": "command",
	});
	expect(run.steps.commandMoves.exchanges).toEqual([]);
	expect(run.dispatched).toEqual([
		"focus",
		"alpha-companion",
		"command",
		"focus",
		"alpha-companion",
		"focus",
		"beta-companion",
		"command",
	]);
});

test("rebinding before any acknowledged snapshot never registers plugin defaults, and quitting stops polling", async () => {
	const run = await lifecycleScenario(
		"{pollIntervalMs:50,retryDelayMs:5000,maxRetryDelayMs:5000}",
		`
bindCommand("CommandOrControl+Alt+A");
await step("startupRefused",{keybindings:{status:503}});
rebind(()=>bindCommand("CommandOrControl+Alt+C"));
observe("rebindUnacknowledged");
await step("acknowledged",{keybindings:{status:200,value:null}});
quit();
core({companions:[${JSON.stringify(GAMMA)}]});
await Bun.sleep(300);
observe("afterQuit");
rebind(()=>bindCommand("CommandOrControl+Alt+D"));
observe("rebindAfterQuit");
`
	);
	expect(run.stderr).toBe("");
	expect(run.steps.startupRefused.active).toEqual({
		"CommandOrControl+Alt+A": "command",
	});
	expect(sorted(run.steps.startupRefused.exchanges)).toEqual(paired(503));
	// No snapshot was acknowledged, so the rebind binds only the command chord.
	expect(run.steps.rebindUnacknowledged.calls).toEqual([
		["unregister", "CommandOrControl+Alt+A"],
		["register", "CommandOrControl+Alt+C"],
	]);
	expect(run.steps.rebindUnacknowledged.active).toEqual({
		"CommandOrControl+Alt+C": "command",
	});
	expect(run.steps.acknowledged.active).toEqual({
		"CommandOrControl+Alt+A": "plugin",
		"CommandOrControl+Alt+B": "plugin",
		"CommandOrControl+Alt+C": "command",
	});
	// After quit: no poll reads Core and no plugin chord is registered again,
	// even though Core's enabled set changed.
	expect(run.steps.afterQuit).toEqual({
		active: {},
		calls: [["unregisterAll", ""]],
		exchanges: [],
	});
	expect(run.steps.rebindAfterQuit.calls).toEqual([
		["unregister", "CommandOrControl+Alt+C"],
		["register", "CommandOrControl+Alt+D"],
	]);
	expect(run.steps.rebindAfterQuit.exchanges).toEqual([]);
});
