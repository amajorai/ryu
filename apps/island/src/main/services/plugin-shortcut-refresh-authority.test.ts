import { expect, test } from "bun:test";
import {
	copyFile,
	mkdir,
	mkdtemp,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The shipping refresh + registrar run in a detached Bun runtime against an
// owned native HTTP Core fixture. Only Electron's `globalShortcut` is replaced:
// the OS boundary below keeps its contract (register answers a boolean, a taken
// accelerator is refused, unregister releases it) and records every call.
const TOKEN = "island-node-token";
// The refresh's real import closure (type-only imports are erased).
const SERVICE_FILES = [
	"plugin-shortcuts",
	"plugin-shortcut-registration",
	"plugin-host",
	"plugin-host-contract",
	"response-deadline",
	"sse",
];
const COMPANIONS = [
	{
		id: "alpha-companion",
		plugin_id: "alpha",
		label: "Alpha",
		shortcut: "Mod+Alt+A",
	},
	{
		id: "beta-companion",
		plugin_id: "beta",
		label: "Beta",
		shortcut: "Mod+Alt+B",
	},
];

interface Reply {
	/** Hold the answer this long after the request arrives (keybindings only). */
	delayMs?: number;
	status: number;
	value?: string | null;
}
interface Exchange {
	at: number;
	authorization: string | null;
	path: string;
	status: number;
}
interface OsStep {
	active: string[];
	/** OS boundary ledger; `quit()` records a bare `["unregisterAll"]`. */
	calls: ([string, string] | ["unregisterAll"])[];
	exchanges: Exchange[];
}

interface ScenarioResult {
	dispatched: string[];
	settled: Record<string, boolean>;
	stderr: string;
	steps: Record<string, OsStep>;
}

/**
 * `options` is spliced verbatim as the refresh's second argument; omit it to
 * run the shipping retry schedule.
 */
async function runScenario(
	script: string,
	{ options, budgetMs = 8000 }: { options?: string; budgetMs?: number } = {}
): Promise<ScenarioResult> {
	const root = await mkdtemp(join(tmpdir(), "ryu-shortcut-authority-"));
	let contributions: Reply = { status: 200 };
	let keybindings: Reply = { status: 200, value: null };
	let exchanges: Exchange[] = [];
	let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
	let childTimer: ReturnType<typeof setTimeout> | null = null;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === "/control") {
				const body: {
					contributions?: Reply;
					keybindings?: Reply;
					take?: true;
				} = await req.json();
				contributions = body.contributions ?? contributions;
				keybindings = body.keybindings ?? keybindings;
				const taken = exchanges;
				if (body.take) {
					exchanges = [];
				}
				return Response.json(body.take ? taken : []);
			}
			const authorization = req.headers.get("authorization");
			const exchange: Exchange = {
				at: performance.now(),
				path,
				authorization,
				status: 200,
			};
			exchanges.push(exchange);
			if (req.method !== "GET" || authorization !== `Bearer ${TOKEN}`) {
				exchange.status = 401;
				return Response.json({ error: "unauthorized" }, { status: 401 });
			}
			if (path === "/api/plugins/contributions") {
				exchange.status = contributions.status;
				return contributions.status === 200
					? Response.json({ companions: COMPANIONS, views: [] })
					: Response.json(
							{ error: "plugin host unavailable" },
							{
								status: contributions.status,
							}
						);
			}
			if (path === "/api/preferences/keybindings") {
				const reply = keybindings;
				exchange.status = reply.status;
				if (reply.delayMs) {
					await Bun.sleep(reply.delayMs);
				}
				return reply.status === 200
					? Response.json({ key: "keybindings", value: reply.value })
					: Response.json(
							{ error: "preference store unavailable" },
							{
								status: reply.status,
							}
						);
			}
			exchange.status = 404;
			return Response.json({ error: "undeclared" }, { status: 404 });
		},
	});
	try {
		// Detached runtime uses the owning app's authentic locked closure.
		await symlink(
			resolve(import.meta.dirname, "../../../node_modules"),
			join(root, "node_modules")
		);
		const services = join(root, "main/services");
		await mkdir(services, { recursive: true });
		await mkdir(join(root, "shared"));
		for (const name of SERVICE_FILES) {
			await copyFile(
				join(import.meta.dirname, `${name}.ts`),
				join(services, `${name}.ts`)
			);
		}
		await copyFile(
			join(import.meta.dirname, "../../shared/host-json.ts"),
			join(root, "shared/host-json.ts")
		);
		const base = server.url.toString().replace(/\/$/, "");
		await writeFile(
			join(services, "config.ts"),
			`export const coreHeaders=(extra={})=>({Authorization:${JSON.stringify(`Bearer ${TOKEN}`)},...extra});export const loadConfig=()=>({coreBaseUrl:${JSON.stringify(base)}});`
		);
		await writeFile(
			join(root, "run.ts"),
			`
import {createPluginShortcutRefresh} from "./main/services/plugin-shortcuts.ts";
import {createPluginShortcutRegistrar} from "./main/services/plugin-shortcut-registration.ts";
const base=${JSON.stringify(base)};
const active=new Map();const calls=[];const dispatched=[];
const registrar=createPluginShortcutRegistrar({
 register(accelerator,handler){calls.push(["register",accelerator]);if(active.has(accelerator))return false;active.set(accelerator,handler);return true;},
 unregister(accelerator){calls.push(["unregister",accelerator]);active.delete(accelerator);},
 focus(){dispatched.push("focus");},
 sendShortcut(id){dispatched.push(id);},
});
const refresh=createPluginShortcutRefresh((result,overrides)=>registrar(result,overrides,["CommandOrControl+Shift+Space"])${options ? `,${options}` : ""});
const control=(body)=>fetch(base+"/control",{method:"POST",body:JSON.stringify(body)}).then(r=>r.json());
const steps={};const settled={};
async function observe(name){steps[name]={active:[...active.keys()].sort(),calls:calls.splice(0),exchanges:await control({take:true})};}
async function step(name,body){await control(body);await refresh();await observe(name);}
async function until(name,predicate,ms){const end=Date.now()+ms;while(!predicate()){if(Date.now()>end){settled[name]=false;return;}await Bun.sleep(5);}settled[name]=true;}
function press(accelerator){active.get(accelerator)?.();}
function quit(){refresh.dispose?.();calls.push(["unregisterAll"]);active.clear();}
${script}
process.stdout.write(JSON.stringify({steps,settled,dispatched}));
`
		);
		child = Bun.spawn([process.execPath, join(root, "run.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		childTimer = setTimeout(() => child?.kill("SIGKILL"), budgetMs);
		const [output, errors, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (exit !== 0) {
			throw new Error(`Shortcut runtime exited ${exit}: ${errors}`);
		}
		return { ...JSON.parse(output), stderr: errors };
	} finally {
		if (childTimer) {
			clearTimeout(childTimer);
		}
		if (child?.exitCode === null) {
			child.kill("SIGKILL");
		}
		if (child) {
			await child.exited;
		}
		server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}

const reads = (status: number) => [
	{
		path: "/api/plugins/contributions",
		authorization: `Bearer ${TOKEN}`,
		status: 200,
	},
	{
		path: "/api/preferences/keybindings",
		authorization: `Bearer ${TOKEN}`,
		status,
	},
];
const sortedReads = (step: OsStep) =>
	[...step.exchanges]
		.sort((a, b) => a.path.localeCompare(b.path))
		.map(({ path, authorization, status }) => ({
			path,
			authorization,
			status,
		}));
const keybindingReads = (step: OsStep) =>
	step.exchanges.filter((read) => read.path === "/api/preferences/keybindings");

test("unreadable or malformed saved shortcuts keep acknowledged registrations instead of reinstating defaults", async () => {
	const saved = JSON.stringify({
		"plugin:alpha": null,
		"plugin:beta": "CommandOrControl+Alt+J",
		"chat.new": "Control+N",
	});
	const { steps, dispatched, stderr } = await runScenario(`
await step("acknowledged",{keybindings:{status:200,value:${JSON.stringify(saved)}}});
await step("refused",{keybindings:{status:503}});
await step("serverError",{keybindings:{status:500}});
await step("malformed",{keybindings:{status:200,value:"{not-json"}});
await step("array",{keybindings:{status:200,value:"[\\"CommandOrControl+Alt+A\\"]"}});
await step("invalidEntry",{keybindings:{status:200,value:JSON.stringify({"plugin:alpha":42,"plugin:beta":"CommandOrControl+Alt+J"})}});
press("CommandOrControl+Alt+A");
press("CommandOrControl+Alt+J");
await step("recovered",{keybindings:{status:200,value:JSON.stringify({"plugin:alpha":"CommandOrControl+Alt+K","plugin:beta":null,"chat.new":"Control+N"})}});
press("CommandOrControl+Alt+J");
press("CommandOrControl+Alt+K");
`);
	expect(steps.acknowledged.active).toEqual(["CommandOrControl+Alt+J"]);
	expect(steps.acknowledged.calls).toEqual([
		["register", "CommandOrControl+Alt+J"],
	]);
	expect(sortedReads(steps.acknowledged)).toEqual(reads(200));
	for (const [name, status] of [
		["refused", 503],
		["serverError", 500],
		["malformed", 200],
		["array", 200],
		["invalidEntry", 200],
	] as const) {
		// A user-cleared alpha chord and beta's custom chord must survive: no
		// manifest default may be registered from a document Ryu could not read.
		expect({ name, active: steps[name].active }).toEqual({
			name,
			active: ["CommandOrControl+Alt+J"],
		});
		expect({ name, calls: steps[name].calls }).toEqual({ name, calls: [] });
		expect(sortedReads(steps[name])).toEqual(reads(status));
	}
	expect(steps.recovered.active).toEqual(["CommandOrControl+Alt+K"]);
	expect(steps.recovered.calls).toEqual([
		["unregister", "CommandOrControl+Alt+J"],
		["register", "CommandOrControl+Alt+K"],
	]);
	expect(sortedReads(steps.recovered)).toEqual(reads(200));
	// Real key dispatch: the retained beta chord opened beta while it was
	// current; after recovery only alpha's acknowledged chord is live.
	expect(stderr).toBe("");
	expect(dispatched).toEqual([
		"focus",
		"beta-companion",
		"focus",
		"alpha-companion",
	]);
});

test("startup with an unreadable shortcut document registers no defaults until a saved document is acknowledged; Core outage still releases chords", async () => {
	const { steps, dispatched, stderr } = await runScenario(`
await step("startupRefused",{keybindings:{status:503}});
press("CommandOrControl+Alt+A");
press("CommandOrControl+Alt+B");
await step("unset",{keybindings:{status:200,value:null}});
press("CommandOrControl+Alt+A");
await step("coreOffline",{contributions:{status:503},keybindings:{status:503}});
press("CommandOrControl+Alt+A");
await step("coreBack",{contributions:{status:200},keybindings:{status:200,value:JSON.stringify({"plugin:beta":null})}});
press("CommandOrControl+Alt+B");
press("CommandOrControl+Alt+A");
`);
	expect(steps.startupRefused.active).toEqual([]);
	expect(steps.startupRefused.calls).toEqual([]);
	expect(sortedReads(steps.startupRefused)).toEqual(reads(503));
	// A genuinely unset document is acknowledged: manifest defaults apply.
	expect(steps.unset.active).toEqual([
		"CommandOrControl+Alt+A",
		"CommandOrControl+Alt+B",
	]);
	expect(steps.unset.calls).toEqual([
		["register", "CommandOrControl+Alt+A"],
		["register", "CommandOrControl+Alt+B"],
	]);
	// Core's plugin host being unavailable still releases every OS chord.
	expect(steps.coreOffline.active).toEqual([]);
	expect(steps.coreOffline.calls).toEqual([
		["unregister", "CommandOrControl+Alt+A"],
		["unregister", "CommandOrControl+Alt+B"],
	]);
	expect(sortedReads(steps.coreOffline)).toEqual([
		{
			path: "/api/plugins/contributions",
			authorization: `Bearer ${TOKEN}`,
			status: 503,
		},
		{
			path: "/api/preferences/keybindings",
			authorization: `Bearer ${TOKEN}`,
			status: 503,
		},
	]);
	expect(steps.coreBack.active).toEqual(["CommandOrControl+Alt+A"]);
	expect(steps.coreBack.calls).toEqual([
		["register", "CommandOrControl+Alt+A"],
	]);
	expect(stderr).toBe("");
	expect(dispatched).toEqual([
		"focus",
		"alpha-companion",
		"focus",
		"alpha-companion",
	]);
});

// Production re-reads shortcuts on events (startup, a live `keybindings`
// preference event, a Core switch) and on a 10 s idle poll, and Core's
// preference stream does not replay on connect. These scenarios make exactly one
// startup refresh() and then let only time pass, finishing well inside the idle
// poll interval: any recovery here must come from the refresh's own retry.
const SHORT_RETRY = "{retryDelayMs:20,maxRetryDelayMs:40}";

test("an unreadable startup document recovers on its own once Core answers, never registering defaults, and stops retrying once acknowledged", async () => {
	const saved = JSON.stringify({
		"plugin:alpha": null,
		"plugin:beta": "CommandOrControl+Alt+J",
	});
	const rebound = JSON.stringify({
		"plugin:alpha": "CommandOrControl+Alt+K",
		"plugin:beta": null,
	});
	const { steps, settled, dispatched, stderr } = await runScenario(
		`
await step("startupRefused",{keybindings:{status:503}});
await Bun.sleep(700);
await observe("outage");
await control({keybindings:{status:200,value:${JSON.stringify(saved)}}});
await until("recovered",()=>active.size>0,3000);
await observe("recovered");
press("CommandOrControl+Alt+J");
await Bun.sleep(500);
await observe("quiet");
await step("eventRefused",{keybindings:{status:503}});
await step("eventAcknowledged",{keybindings:{status:200,value:${JSON.stringify(rebound)}}});
await Bun.sleep(500);
await observe("quietAfterEvent");
press("CommandOrControl+Alt+K");
`,
		{ options: SHORT_RETRY, budgetMs: 12_000 }
	);
	expect(stderr).toBe("");
	expect(steps.startupRefused.active).toEqual([]);
	expect(steps.startupRefused.calls).toEqual([]);
	expect(sortedReads(steps.startupRefused)).toEqual(reads(503));

	// While Core keeps refusing, the refresh re-reads by itself on a capped
	// backoff: paired authenticated snapshots, never a hot loop, no OS calls.
	// 700 ms at 20/40/40… ms allows ~17 reads; an uncapped doubling allows 5.
	const outageReads = keybindingReads(steps.outage);
	expect(outageReads.length).toBeGreaterThanOrEqual(8);
	expect(outageReads.length).toBeLessThanOrEqual(20);
	expect(steps.outage.exchanges).toHaveLength(outageReads.length * 2);
	for (const read of steps.outage.exchanges) {
		expect({ authorization: read.authorization, status: read.status }).toEqual({
			authorization: `Bearer ${TOKEN}`,
			status: read.path === "/api/preferences/keybindings" ? 503 : 200,
		});
	}
	const timeline = [
		...keybindingReads(steps.startupRefused),
		...outageReads,
	].map((read) => read.at);
	for (let index = 1; index < timeline.length; index++) {
		const expectedDelay = Math.min(20 * 2 ** (index - 1), 40);
		expect({
			index,
			gapAtLeastBackoff:
				timeline[index] - timeline[index - 1] >= expectedDelay - 5,
		}).toEqual({ index, gapAtLeastBackoff: true });
	}
	expect(steps.outage.active).toEqual([]);
	expect(steps.outage.calls).toEqual([]);

	// Recovery without any preference event: the saved document is applied
	// as-is (alpha stays cleared, beta keeps its custom chord).
	expect(settled.recovered).toBe(true);
	expect(steps.recovered.active).toEqual(["CommandOrControl+Alt+J"]);
	expect(steps.recovered.calls).toEqual([
		["register", "CommandOrControl+Alt+J"],
	]);
	// Every retry snapshot is a paired, authenticated read; the reads before
	// Core answered were refused and only the final one was acknowledged.
	const recoveredReads = keybindingReads(steps.recovered).map(
		(read) => read.status
	);
	expect(recoveredReads.length).toBeGreaterThanOrEqual(1);
	expect(recoveredReads).toEqual([
		...Array.from({ length: recoveredReads.length - 1 }, () => 503),
		200,
	]);
	expect(steps.recovered.exchanges).toHaveLength(recoveredReads.length * 2);
	for (const read of steps.recovered.exchanges) {
		expect(read.authorization).toBe(`Bearer ${TOKEN}`);
	}
	// Once acknowledged, the retry loop ends: no further Core reads.
	expect(steps.quiet.exchanges).toEqual([]);
	expect(steps.quiet.calls).toEqual([]);

	// A later live preference event whose read fails starts the loop again;
	// the next acknowledged event settles it and no timer read follows.
	expect(steps.eventRefused.active).toEqual(["CommandOrControl+Alt+J"]);
	expect(steps.eventRefused.calls).toEqual([]);
	expect(steps.eventAcknowledged.active).toEqual(["CommandOrControl+Alt+K"]);
	expect(steps.eventAcknowledged.calls.at(-1)).toEqual([
		"register",
		"CommandOrControl+Alt+K",
	]);
	expect(steps.quietAfterEvent.exchanges).toEqual([]);
	expect(steps.quietAfterEvent.calls).toEqual([]);
	expect(dispatched).toEqual([
		"focus",
		"beta-companion",
		"focus",
		"alpha-companion",
	]);
}, 15_000);

test("a plugin host that is unavailable at startup gets its saved shortcuts back on the shipping retry schedule with only time passing", async () => {
	const { steps, settled, dispatched, stderr } = await runScenario(
		`
await step("startupOffline",{contributions:{status:503},keybindings:{status:503}});
await control({contributions:{status:200},keybindings:{status:200,value:JSON.stringify({"plugin:beta":null})}});
await until("hostBack",()=>active.size>0,6000);
await observe("hostBack");
press("CommandOrControl+Alt+A");
press("CommandOrControl+Alt+B");
`,
		{ budgetMs: 12_000 }
	);
	expect(stderr).toBe("");
	expect(steps.startupOffline.active).toEqual([]);
	expect(steps.startupOffline.calls).toEqual([]);
	expect(settled.hostBack).toBe(true);
	// beta's cleared chord stays cleared; alpha's manifest default applies.
	expect(steps.hostBack.active).toEqual(["CommandOrControl+Alt+A"]);
	expect(steps.hostBack.calls).toEqual([
		["register", "CommandOrControl+Alt+A"],
	]);
	// Exactly one retry snapshot, issued no sooner than the shipping delay.
	expect(sortedReads(steps.hostBack)).toEqual(reads(200));
	const first = keybindingReads(steps.startupOffline)[0]?.at ?? 0;
	const retry = keybindingReads(steps.hostBack)[0]?.at ?? 0;
	expect(retry - first).toBeGreaterThanOrEqual(1995);
	expect(dispatched).toEqual(["focus", "alpha-companion"]);
}, 15_000);

// `quit()` mirrors the Island's will-quit handler: dispose the refresh, then
// release every OS chord. `dispose` is called optionally so an implementation
// without it fails on behavior (late reads and re-registered chords), not on a
// TypeError.
test("quitting cancels a scheduled shortcut re-read and drops a snapshot still in flight; refresh after quit is inert", async () => {
	const saved = JSON.stringify({
		"plugin:alpha": null,
		"plugin:beta": "CommandOrControl+Alt+J",
	});
	const rebound = JSON.stringify({
		"plugin:alpha": "CommandOrControl+Alt+K",
		"plugin:beta": null,
	});
	const scheduled = await runScenario(
		`
await step("startupRefused",{keybindings:{status:503}});
quit();
await control({keybindings:{status:200,value:${JSON.stringify(saved)}}});
await Bun.sleep(400);
await observe("afterQuit");
await refresh();
await observe("refreshAfterQuit");
`,
		{ options: SHORT_RETRY }
	);
	expect(scheduled.stderr).toBe("");
	expect(sortedReads(scheduled.steps.startupRefused)).toEqual(reads(503));
	expect(scheduled.steps.startupRefused.calls).toEqual([]);
	// The re-read was due 20 ms after the refusal; quitting cancelled it.
	expect(scheduled.steps.afterQuit).toEqual({
		active: [],
		calls: [["unregisterAll"]],
		exchanges: [],
	});
	expect(scheduled.steps.refreshAfterQuit).toEqual({
		active: [],
		calls: [],
		exchanges: [],
	});

	const inFlight = await runScenario(
		`
await step("acknowledged",{keybindings:{status:200,value:${JSON.stringify(saved)}}});
await control({keybindings:{status:200,value:${JSON.stringify(rebound)},delayMs:500}});
const read=refresh();
await Bun.sleep(100);
quit();
await read;
await Bun.sleep(200);
await observe("quitDuringRead");
press("CommandOrControl+Alt+K");
`,
		{ options: SHORT_RETRY }
	);
	expect(inFlight.stderr).toBe("");
	expect(inFlight.steps.acknowledged.active).toEqual([
		"CommandOrControl+Alt+J",
	]);
	// The read was issued before quit and answered after it: the rebound
	// snapshot must not register K (or touch J) once the chords are released.
	expect(inFlight.steps.quitDuringRead.active).toEqual([]);
	expect(inFlight.steps.quitDuringRead.calls).toEqual([["unregisterAll"]]);
	expect(sortedReads(inFlight.steps.quitDuringRead)).toEqual(reads(200));
	expect(inFlight.dispatched).toEqual([]);
}, 15_000);
