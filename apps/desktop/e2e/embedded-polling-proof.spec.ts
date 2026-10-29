import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	newProject,
	newSegment,
} from "../../../apps-store/video-studio/shared/project.ts";

const proofDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/performance-sweep"
);
function readCompanionHtml(build: string): Promise<string> {
	const app =
		build === "broadcast"
			? "chat-broadcast"
			: build === "video"
				? "video-studio"
				: build;
	const fixture = path.resolve(
		import.meta.dirname,
		"../../../apps/core/src/plugin_manifest/fixtures",
		`${app}.ui.html`
	);
	const html =
		process.env.RYU_PERF_USE_CORE_FIXTURES === "1" && existsSync(fixture)
			? fixture
			: `/tmp/ryu-${build}-performance-build/index.html`;
	return readFile(html, "utf8");
}

/**
 * Switches to "Another tab" and resolves once the companion frame has observed
 * itself hidden. The probe observer is created after the app's own shared
 * visibility observer, so Chromium delivers the hidden entry to the app first in
 * the same intersection-observer task; read baselines taken afterwards cannot
 * race a late pause signal.
 */
async function hideCompanion(page: Page): Promise<void> {
	const companion = await page
		.locator('iframe[title="Companion workspace"]')
		.elementHandle();
	const frame = await companion?.contentFrame();
	if (!frame) {
		throw new Error("companion frame is not attached");
	}
	await frame.evaluate(() => {
		const hidden = new Promise<void>((resolve) => {
			const observer = new IntersectionObserver((entries) => {
				if (entries.at(-1)?.isIntersecting === false) {
					observer.disconnect();
					resolve();
				}
			});
			observer.observe(document.documentElement);
		});
		Reflect.set(globalThis, "__ryuProofCompanionHidden", hidden);
	});
	await page.getByRole("button", { name: "Another tab", exact: true }).click();
	await frame.evaluate(() =>
		Reflect.get(globalThis, "__ryuProofCompanionHidden")
	);
}

test("CSS-hidden sandboxed companions pause shared polls and resume without remounting", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.clock.install();
	await page.goto("/embedded-polling-proof.html");
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	await expect(
		frame.getByRole("heading", { name: "Warmup", exact: true })
	).toBeVisible();
	const reads = async () =>
		Number(await page.getByTestId("reads").textContent());
	await frame.getByLabel("Ping message").fill("Draft kept across tabs");
	await page.clock.fastForward(31_000);
	await expect.poll(reads).toBeGreaterThan(3);
	await hideCompanion(page);
	await page
		.getByRole("button", { name: "Inspect visibility", exact: true })
		.click();
	await expect(page.getByTestId("visibility")).toHaveText("false/visible");
	const hiddenReads = await reads();
	await page.clock.fastForward(61_000);
	expect(await reads()).toBe(hiddenReads);
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect.poll(reads).toBeGreaterThan(hiddenReads);
	await expect(
		frame.getByRole("heading", { name: "Warmup", exact: true })
	).toBeVisible();
	await expect(frame.getByLabel("Ping message")).toHaveValue(
		"Draft kept across tabs"
	);
	await frame
		.getByRole("button", { name: "Close panels", exact: true })
		.click();
	// The toggle relabels in the same commit that unmounts the polling panels.
	await expect(
		frame.getByRole("button", { name: "Open panels", exact: true })
	).toBeVisible();
	const closedReads = await reads();
	await page.clock.fastForward(61_000);
	expect(await reads()).toBe(closedReads);
	await frame.getByRole("button", { name: "Open panels", exact: true }).click();
	await expect.poll(reads).toBeGreaterThan(closedReads);
	await page
		.getByRole("button", { name: "Inspect visibility", exact: true })
		.click();
	await expect(page.getByTestId("visibility")).toHaveText("true/visible");
	await mkdir(proofDir, { recursive: true });
	await page.screenshot({
		path: path.join(proofDir, "embedded-companion-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
	expect(errors).toEqual([]);
	await writeFile(
		path.join(proofDir, "embedded-companion-polling.json"),
		`${JSON.stringify(
			{
				sandbox: "allow-scripts without same-origin",
				hiddenDocumentVisibility: "visible",
				hiddenAutomaticReads: 0,
				resumedWithoutRemount: true,
				closedAutomaticReads: 0,
			},
			null,
			2
		)}\n`
	);
});

test("production Warmup bundle retains drafts while hidden polls stop", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const html = await readCompanionHtml("warmup");
	const bridge = `<script>let proofReads=0;function result(value){parent.postMessage({kind:"proof-read",reads:++proofReads},"*");return Promise.resolve(value)}window.ryu={warmup:{detect:()=>result({tz:"UTC",agents:[{id:"sample",name:"Codex",available:true,plan:"Subscription",reason:null,models:[],windows:[{label:"Current window",usedPercent:12,resetsAt:null,windowSeconds:18000}]}]}),list:()=>result([])},catalog:{snapshot:()=>result(null)}};</script>`;
	await page.route("**/embedded-polling-child.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: html.replace("<head>", `<head>${bridge}`),
		})
	);
	await page.clock.install();
	await page.goto("/embedded-polling-proof.html");
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	await expect(
		frame.getByRole("heading", { name: "Warmup", exact: true })
	).toBeVisible();
	await frame.getByLabel("Ping message").fill("Draft kept across tabs");
	const reads = async () =>
		Number(await page.getByTestId("reads").textContent());
	await page.clock.fastForward(31_000);
	await expect.poll(reads).toBeGreaterThan(3);
	await hideCompanion(page);
	const hiddenReads = await reads();
	await page.clock.fastForward(61_000);
	expect(await reads()).toBe(hiddenReads);
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect.poll(reads).toBeGreaterThan(hiddenReads);
	await expect(frame.getByLabel("Ping message")).toHaveValue(
		"Draft kept across tabs"
	);
	expect(errors).toEqual([]);
	await mkdir(proofDir, { recursive: true });
	await page.screenshot({
		path: path.join(proofDir, "embedded-companion-production.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("production Inbox waits for its refreshed decision list and pauses inactive reads", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const html = await readCompanionHtml("approvals");
	const bridge = `<script>let reads=0;let decided=false;function track(value){parent.postMessage({kind:"proof-read",reads:++reads},"*");return value}function approval(){return {id:"proof",kind:"tool_call",title:"Review generated report",summary:"Controlled local approval",created_at:"2026-09-11T00:00:00Z",risk_tags:[],status:decided?"approved":"pending"}}window.ryu={approvals:{list:async()=>{const rows=track([approval()]);if(decided)await new Promise(r=>{const done=e=>{if(e.data!=="proof-release-decision")return;removeEventListener("message",done);r()};addEventListener("message",done)});return rows},approve:async()=>{decided=true;document.body.dataset.proofDecided="true";return approval()}},quests:{list:async()=>track([])},notifications:{list:async()=>[],appIcons:async()=>({})},suggestions:{list:async()=>[]}};</script>`;
	await page.route("**/embedded-polling-child.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: html.replace("<head>", `<head>${bridge}`),
		})
	);
	await page.clock.install();
	await page.goto("/embedded-polling-proof.html");
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	const approve = frame.getByRole("button", { name: /Approve/ });
	await expect(approve).toBeVisible();
	const reads = async () =>
		Number(await page.getByTestId("reads").textContent());
	await hideCompanion(page);
	const hiddenReads = await reads();
	await page.clock.fastForward(61_000);
	expect(await reads()).toBe(hiddenReads);
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect.poll(reads).toBeGreaterThan(hiddenReads);
	await approve.press("Enter");
	await expect(frame.locator("body")).toHaveAttribute(
		"data-proof-decided",
		"true"
	);
	await expect(approve).toBeDisabled();
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("proof-release-decision", "*")
		);
	await expect(approve).toHaveCount(0);
	expect(errors).toEqual([]);
	await mkdir(proofDir, { recursive: true });
	await page.screenshot({
		path: path.join(proofDir, "inbox-polling-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("production Inbox refreshes notifications without repeating icon downloads", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const html = await readCompanionHtml("approvals");
	const bridge = `<script>let lists=0,icons=0;window.ryu={approvals:{list:async()=>[]},quests:{list:async()=>[]},suggestions:{list:async()=>[]},notifications:{list:async()=>{document.body.dataset.notificationReads=String(++lists);return [{id:"notice",title:"Build complete",body:"Workspace is ready",created_at:"2026-09-12T00:00:00Z",level:"info",user_id:"fixture",ack_required:false,acked:false,source_app_id:"com.test.sender"}]},appIcons:async()=>{document.body.dataset.iconReads=String(++icons);return {"com.test.sender":{name:"Workspace",glyph:"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Crect width='24' height='24' rx='6' fill='%230088ff'/%3E%3C/svg%3E",background:null}}}}};</script>`;
	await page.route("**/embedded-polling-child.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: html.replace("<head>", `<head>${bridge}`),
		})
	);
	await page.clock.install();
	await page.goto("/embedded-polling-proof.html");
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	await expect(
		frame.getByText("Build complete", { exact: true })
	).toBeVisible();
	await expect(frame.locator("body")).toHaveAttribute("data-icon-reads", "1");
	await page.clock.fastForward(16_000);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-notification-reads",
		"2"
	);
	await expect(frame.locator("body")).toHaveAttribute("data-icon-reads", "1");
	await frame
		.getByRole("button", { name: "Refresh", exact: true })
		.press("Enter");
	await expect(frame.locator("body")).toHaveAttribute(
		"data-notification-reads",
		"3"
	);
	await expect(frame.locator("body")).toHaveAttribute("data-icon-reads", "2");
	await hideCompanion(page);
	await page.clock.fastForward(61_000);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-notification-reads",
		"3"
	);
	await expect(frame.locator("body")).toHaveAttribute("data-icon-reads", "2");
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect(frame.locator("body")).toHaveAttribute(
		"data-notification-reads",
		"4"
	);
	await expect(
		frame.getByText("Build complete", { exact: true })
	).toBeVisible();
	const titleBox = await frame
		.getByText("Build complete", { exact: true })
		.boundingBox();
	const bodyBox = await frame
		.getByText("Workspace is ready", { exact: true })
		.boundingBox();
	expect(titleBox).not.toBeNull();
	expect(bodyBox).not.toBeNull();
	expect(bodyBox!.y).toBeGreaterThan(titleBox!.y);
	expect(errors).toEqual([]);
	await mkdir(proofDir, { recursive: true });
	await page.screenshot({
		path: path.join(proofDir, "notifications-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("production Quests pauses list polls and preserves typing ahead of scratchpad load", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const html = await readCompanionHtml("quests");
	const bridge = `<script>let reads=0;window.ryu={quests:{list:async()=>{document.body.dataset.questReads=String(++reads);return []},scratchpad:()=>new Promise(resolve=>{const ready=e=>{if(e.data!=="release-scratchpad")return;removeEventListener("message",ready);resolve("Old stored text")};addEventListener("message",ready)}),setScratchpad:async({text})=>{document.body.dataset.savedScratchpad=text}}};</script>`;
	await page.route("**/embedded-polling-child.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: html.replace("<head>", `<head>${bridge}`),
		})
	);
	await page.clock.install();
	await page.goto("/embedded-polling-proof.html");
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	await frame.getByRole("button", { name: /Scratchpad/ }).click();
	await frame
		.getByRole("textbox", { name: "Scratchpad", exact: true })
		.fill("Keep my new draft");
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("release-scratchpad", "*")
		);
	await expect(
		frame.getByRole("textbox", { name: "Scratchpad", exact: true })
	).toHaveValue("Keep my new draft");
	await page.clock.fastForward(1000);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-saved-scratchpad",
		"Keep my new draft"
	);
	await hideCompanion(page);
	const before = await frame.locator("body").getAttribute("data-quest-reads");
	await page.clock.fastForward(31_000);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-quest-reads",
		before!
	);
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect
		.poll(async () =>
			Number(await frame.locator("body").getAttribute("data-quest-reads"))
		)
		.toBeGreaterThan(Number(before));
	await expect(
		frame.getByRole("textbox", { name: "Scratchpad", exact: true })
	).toHaveValue("Keep my new draft");
	expect(errors).toEqual([]);
	await mkdir(proofDir, { recursive: true });
	await page.screenshot({
		path: path.join(proofDir, "quests-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("production Broadcast keeps its draft and selection while hidden reads stop", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const html = await readCompanionHtml("broadcast");
	const bridge = `<script>let reads=0;window.ryu={chat:{list:async()=>{document.body.dataset.broadcastReads=String(++reads);return [{id:"chat-a",title:"Planning",agent_id:"agent-a",message_count:3,run_status:"running",archived:false}]},send:async()=>{document.body.dataset.sent="true";throw Error("Sending is not part of this read-only proof")}}};</script>`;
	await page.route("**/embedded-polling-child.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: html.replace("<head>", `<head>${bridge}`),
		})
	);
	await page.clock.install();
	await page.goto("/embedded-polling-proof.html");
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	await frame.getByRole("tab", { name: /Selected/ }).click();
	await frame.getByRole("checkbox", { name: /^Select Planning/ }).check();
	await frame
		.getByRole("textbox", { name: "Broadcast message", exact: true })
		.fill("Draft only — do not send");
	await hideCompanion(page);
	await page.clock.fastForward(31_000);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-broadcast-reads",
		"1"
	);
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect(frame.locator("body")).toHaveAttribute(
		"data-broadcast-reads",
		"2"
	);
	await expect(
		frame.getByRole("checkbox", { name: /^Select Planning/ })
	).toBeChecked();
	await expect(
		frame.getByRole("textbox", { name: "Broadcast message", exact: true })
	).toHaveValue("Draft only — do not send");
	expect(await frame.locator("body").getAttribute("data-sent")).toBeNull();
	expect(errors).toEqual([]);
	await mkdir(proofDir, { recursive: true });
	await page.screenshot({
		path: path.join(proofDir, "broadcast-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("production Monitors avoids overlapping details and rejects a previous selection", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const html = await readCompanionHtml("monitors");
	const bridge = `<script>let aReads=0;let held="a";addEventListener("message",e=>{if(e.data==="hold-monitor-b")held="b"});window.ryu={monitors:{list:async()=>["a","b"].map(id=>({id,name:"Monitor "+id.toUpperCase(),url:"https://example.com/"+id,backend:"http",check:{type:"uptime"},interval:"5m",enabled:true,notify:[],created_at:"2026-09-12T00:00:00Z",updated_at:"2026-09-12T00:00:00Z"})),snapshots:async({id})=>{if(id==="a")document.body.dataset.aReads=String(++aReads);if(id===held){await new Promise(resolve=>{const done=e=>{if(e.data!=="release-monitor-"+id)return;removeEventListener("message",done);resolve()};addEventListener("message",done)})}return []},alerts:async({id})=>[{id:1,monitor_id:id,monitor_name:"Monitor "+id.toUpperCase(),title:"Alert "+id.toUpperCase(),message:"Controlled monitor detail",kind:"uptime",acknowledged:false,created_at:"2026-09-12T00:00:00Z"}]}};</script>`;
	await page.route("**/embedded-polling-child.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: html.replace("<head>", `<head>${bridge}`),
		})
	);
	await page.clock.install();
	await page.goto("/embedded-polling-proof.html");
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	await frame.getByRole("button", { name: /Monitor A/ }).press("Enter");
	await expect(frame.locator("body")).toHaveAttribute("data-a-reads", "1");
	await page.clock.fastForward(16_000);
	await expect(frame.locator("body")).toHaveAttribute("data-a-reads", "1");
	await frame.getByRole("button", { name: /Monitor B/ }).press("Enter");
	await expect(frame.getByText("Alert B", { exact: true })).toBeVisible();
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("release-monitor-a", "*")
		);
	await page.clock.fastForward(1);
	await expect(frame.getByText("Alert A", { exact: true })).toHaveCount(0);
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("hold-monitor-b", "*")
		);
	await frame.getByRole("button", { name: /Monitor A/ }).press("Enter");
	await expect(frame.getByText("Alert A", { exact: true })).toBeVisible();
	await frame.getByRole("button", { name: /Monitor B/ }).press("Enter");
	await expect(frame.getByText("Alert A", { exact: true })).toHaveCount(0);
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("release-monitor-b", "*")
		);
	await expect(frame.getByText("Alert B", { exact: true })).toBeVisible();
	expect(errors).toEqual([]);
	await mkdir(proofDir, { recursive: true });
	await page.screenshot({
		path: path.join(proofDir, "monitors-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("production Fine-tuning coalesces slow job reads and preserves configuration while hidden", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const html = await readCompanionHtml("finetune");
	const bridge = `<script>let reads=0;const sidecar={"/capability":async()=>({can_train_local:true,gpu:"Local GPU"}),"/adapters":async()=>({adapters:[]}),"/list":async()=>{document.body.dataset.jobReads=String(++reads);if(reads===1)await new Promise(resolve=>{const done=e=>{if(e.data!=="release-jobs")return;removeEventListener("message",done);resolve()};addEventListener("message",done)});return {jobs:[]}},"/start":async()=>{document.body.dataset.started="true";throw Error("No training starts in this proof")}};window.ryu={app:{request:async({path})=>{const route=sidecar[path];if(!route)throw Error("Unexpected finetune sidecar path "+path);return route()}}};</script>`;
	await page.route("**/embedded-polling-child.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: html.replace("<head>", `<head>${bridge}`),
		})
	);
	await page.clock.install();
	await page.goto("/embedded-polling-proof.html");
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	await frame
		.getByRole("textbox", { name: "Base model id", exact: true })
		.fill("unsloth/llama-3-8b-bnb-4bit");
	await frame
		.getByRole("textbox", { name: "Output adapter name", exact: true })
		.fill("My saved draft");
	await page.clock.fastForward(13_000);
	await expect(frame.locator("body")).toHaveAttribute("data-job-reads", "1");
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("release-jobs", "*")
		);
	await page.clock.fastForward(1);
	await hideCompanion(page);
	await page.clock.fastForward(21_000);
	await expect(frame.locator("body")).toHaveAttribute("data-job-reads", "1");
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect(frame.locator("body")).toHaveAttribute("data-job-reads", "2");
	await expect(
		frame.getByRole("textbox", { name: "Output adapter name", exact: true })
	).toHaveValue("My saved draft");
	expect(await frame.locator("body").getAttribute("data-started")).toBeNull();
	expect(errors).toEqual([]);
	await mkdir(proofDir, { recursive: true });
	await page.screenshot({
		path: path.join(proofDir, "finetune-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("production Fine-tuning keeps live progress and refreshes once on repeated terminal frames", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const html = await readCompanionHtml("finetune");
	const bridge = `<script>let lists=0,adapters=0;const sidecar={"/capability":async()=>({can_train_local:true,gpu:"Local GPU"}),"/adapters":async()=>{document.body.dataset.adapterReads=String(++adapters);return {adapters:[]}},"/list":async()=>{document.body.dataset.jobReads=String(++lists);return {jobs:[{id:"run-a",output_name:"Training preview",state:"running",step:10,max_steps:100}]}}};window.ryu={context:{view:"history"},app:{request:async({path})=>{const route=sidecar[path];if(!route)throw Error("Unexpected finetune sidecar path "+path);return route()}},finetune:{stream:async(_input,hooks)=>{document.body.dataset.streams="1";hooks.signal.addEventListener("abort",()=>{document.body.dataset.streamAborted="true"});addEventListener("message",e=>{if(e.data==="progress")hooks.onFrame(JSON.stringify({step:50}));if(e.data==="terminal"){for(let i=0;i<4;i++)hooks.onFrame(JSON.stringify({state:"succeeded",step:100}))}})}}};</script>`;
	await page.route("**/embedded-polling-child.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: html.replace("<head>", `<head>${bridge}`),
		})
	);
	await page.clock.install();
	await page.goto("/embedded-polling-proof.html");
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	await frame.getByRole("button", { name: /Training preview/ }).press("Enter");
	await expect(frame.locator("body")).toHaveAttribute("data-streams", "1");
	await hideCompanion(page);
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("progress", "*")
		);
	await page.clock.fastForward(9000);
	await expect(frame.locator("body")).toHaveAttribute("data-job-reads", "1");
	await expect(frame.getByText("50 / 100", { exact: true })).toHaveCount(1);
	expect(
		await frame.locator("body").getAttribute("data-stream-aborted")
	).toBeNull();
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect(frame.locator("body")).toHaveAttribute("data-job-reads", "2");
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("terminal", "*")
		);
	await expect(frame.locator("body")).toHaveAttribute("data-job-reads", "3");
	await expect(frame.locator("body")).toHaveAttribute(
		"data-adapter-reads",
		"2"
	);
	await expect(frame.getByText("100 / 100", { exact: true })).toBeVisible();
	expect(errors).toEqual([]);
	await mkdir(proofDir, { recursive: true });
	await page.screenshot({
		path: path.join(proofDir, "finetune-progress-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("production Video Studio retains a newly queued export against an old poll and pauses hidden reads", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const project = newProject("Performance preview");
	project.titles.push({
		id: crypto.randomUUID(),
		start: 0,
		end: 5,
		text: "Ryu Video Studio",
		x: 0.5,
		y: 0.5,
		fontSize: 0.08,
		color: "#ffffff",
		fadeIn: 0,
		fadeOut: 0,
		animation: "fade",
	});
	const html = await readCompanionHtml("video");
	const bridge = `<script>let reads=0;const project=${JSON.stringify(project)};const job={id:"render-preview",projectId:project.id,revision:0,status:"running",progress:0.2};window.ryu={app:{request:async({path,method})=>{if(path==="/projects")return {projects:[project]};if(path==="/assets")return {assets:[]};if(path==="/renders"){document.body.dataset.renderReads=String(++reads);if(reads===1){await new Promise(resolve=>{const done=e=>{if(e.data!=="release-renders")return;removeEventListener("message",done);resolve()};addEventListener("message",done)});return {jobs:[]}}return {jobs:[{...job,status:"completed",progress:1}]}}if(path.endsWith("/render")&&method==="POST"){document.body.dataset.exportRequests="1";return job}throw Error("Unexpected fixture request "+path)}}};</script>`;
	await page.route("**/embedded-polling-child.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: html.replace("<head>", `<head>${bridge}`),
		})
	);
	await page.clock.install();
	await page.setViewportSize({ width: 1600, height: 1200 });
	await page.goto("/embedded-polling-proof.html");
	await page.locator("main").evaluate((element) => {
		element.style.maxWidth = "none";
	});
	await page.locator("iframe").evaluate((element) => {
		element.style.height = "950px";
	});
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	await expect(
		frame.getByRole("button", { name: "Export video", exact: true })
	).toBeEnabled();
	await page.clock.fastForward(6000);
	await expect(frame.locator("body")).toHaveAttribute("data-render-reads", "1");
	await frame
		.getByRole("button", { name: "Export video", exact: true })
		.press("Enter");
	await expect(
		frame.getByText("Encoding video…", { exact: true })
	).toBeVisible();
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("release-renders", "*")
		);
	await page.clock.fastForward(1);
	await expect(
		frame.getByText("Encoding video…", { exact: true })
	).toBeVisible();
	await hideCompanion(page);
	await page.clock.fastForward(10_000);
	await expect(frame.locator("body")).toHaveAttribute("data-render-reads", "1");
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect(frame.locator("body")).toHaveAttribute("data-render-reads", "2");
	await expect(frame.getByRole("status")).toHaveText(
		"Export completed. Your video is ready to download."
	);
	await expect(
		frame.getByRole("button", { name: "Download MP4", exact: true })
	).toBeVisible();
	await frame
		.getByRole("button", { name: "Play timeline", exact: true })
		.press("Enter");
	await page.clock.runFor(1000);
	await frame
		.getByRole("button", { name: "Pause playback", exact: true })
		.press("Enter");
	await expect(
		frame.getByRole("spinbutton", { name: "Playhead", exact: true })
	).not.toHaveValue("0");
	expect(errors).toEqual([]);
	await page.screenshot({
		path: path.join(proofDir, "video-export-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("production Video Studio resumes source analysis after a completed run without overlapping reads", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const project = newProject("Analysis preview");
	const asset = {
		id: crypto.randomUUID(),
		name: "Scene study.mp4",
		kind: "video",
		duration: 5,
		width: 1920,
		height: 1080,
		hasAudio: true,
		createdAt: "2026-09-12T00:00:00Z",
	};
	const html = await readCompanionHtml("video");
	const bridge = `<script>let reads=0,starts=0;const project=${JSON.stringify(project)},asset=${JSON.stringify(asset)};const analysis={assetId:asset.id,status:"completed",createdAt:asset.createdAt,sceneCuts:[2.5],waveform:[0.1,0.4,0.2,0.6,0.1],duration:5};window.ryu={app:{request:async({path,method})=>{if(path==="/projects")return {projects:[project]};if(path==="/assets")return {assets:[asset]};if(path==="/renders")return {jobs:[]};if(path.endsWith("/analysis")){document.body.dataset.analysisReads=String(++reads);if(reads===1)await new Promise(resolve=>{const done=e=>{if(e.data!=="release-analysis")return;removeEventListener("message",done);resolve()};addEventListener("message",done)});return {analysis:{...analysis,status:reads===2?"running":"completed"}}}if(path.endsWith("/analyze")&&method==="POST"){document.body.dataset.analysisStarts=String(++starts);return {...analysis,status:"running"}}throw Error("Unexpected fixture request "+path)}}};</script>`;
	await page.route("**/embedded-polling-child.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: html.replace("<head>", `<head>${bridge}`),
		})
	);
	await page.clock.install();
	await page.setViewportSize({ width: 1600, height: 1200 });
	await page.goto("/embedded-polling-proof.html");
	await page.locator("main").evaluate((element) => {
		element.style.maxWidth = "none";
	});
	await page.locator("iframe").evaluate((element) => {
		element.style.height = "950px";
	});
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	await frame
		.getByRole("button", { name: "View analysis", exact: true })
		.press("Enter");
	await expect(frame.locator("body")).toHaveAttribute(
		"data-analysis-reads",
		"1"
	);
	await page.clock.fastForward(6000);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-analysis-reads",
		"1"
	);
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("release-analysis", "*")
		);
	await expect(
		frame.getByText("1 detected scene changes", { exact: true })
	).toBeVisible();
	await page.clock.fastForward(10_000);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-analysis-reads",
		"1"
	);
	await frame
		.getByRole("button", { name: "Analyze source", exact: true })
		.press("Enter");
	await expect(frame.locator("body")).toHaveAttribute(
		"data-analysis-reads",
		"2"
	);
	await expect(
		frame.getByText("Analyzing scenes and audio…", { exact: true })
	).toBeVisible();
	await hideCompanion(page);
	await page.clock.fastForward(10_000);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-analysis-reads",
		"2"
	);
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect(frame.locator("body")).toHaveAttribute(
		"data-analysis-reads",
		"3"
	);
	await expect(
		frame.getByText("1 detected scene changes", { exact: true })
	).toBeVisible();
	await page.clock.fastForward(6000);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-analysis-reads",
		"3"
	);
	await frame
		.getByText("1 detected scene changes", { exact: true })
		.scrollIntoViewIfNeeded();
	expect(errors).toEqual([]);
	await page.screenshot({
		path: path.join(proofDir, "video-analysis-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("production Video Studio bounds preview blobs to the current project and abandons old preload queues", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const assets = [
		"Slow old source",
		"Current preview",
		"Unused queued source",
	].map((name) => ({
		id: crypto.randomUUID(),
		name,
		kind: "image" as const,
		duration: 5,
		width: 640,
		height: 360,
		hasAudio: false,
		createdAt: "2026-09-12T00:00:00Z",
	}));
	const old = newProject("Old project");
	old.segments = [newSegment(assets[0]!), newSegment(assets[2]!, 5)];
	const current = newProject("Current project");
	current.segments = [newSegment(assets[1]!)];
	const shared = newProject("Shared source project");
	shared.segments = [newSegment(assets[1]!)];
	const empty = newProject("Empty project");
	const html = await readCompanionHtml("video");
	const bridge = `<script>const projects=${JSON.stringify([old, current, shared, empty])},assets=${JSON.stringify(assets)};const reads={};const live=new Set();const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);URL.createObjectURL=blob=>{const url=create(blob);live.add(url);document.body.dataset.liveUrls=String(live.size);return url};URL.revokeObjectURL=url=>{live.delete(url);document.body.dataset.liveUrls=String(live.size);revoke(url)};window.ryu={app:{request:async({path})=>{if(path==="/projects")return {projects};const selected=projects.find(project=>path==="/projects/"+project.id);if(selected)return selected;if(path==="/assets")return {assets};if(path==="/renders")return {jobs:[]};const asset=assets.find(asset=>path.startsWith("/assets/"+asset.id+"/data?"));if(asset){reads[asset.name]=(reads[asset.name]||0)+1;document.body.dataset.mediaReads=JSON.stringify(reads);if(asset.id===assets[0].id){await new Promise(resolve=>{const done=e=>{if(e.data!=="release-old-media")return;removeEventListener("message",done);resolve()};addEventListener("message",done)});return {data:"AA==",done:false,size:100}}const canvas=document.createElement("canvas");canvas.width=640;canvas.height=360;const ctx=canvas.getContext("2d");ctx.fillStyle="#172554";ctx.fillRect(0,0,640,360);ctx.fillStyle="#ffffff";ctx.font="32px sans-serif";ctx.textAlign="center";ctx.fillText("Current project preview",320,180);const data=canvas.toDataURL("image/png").split(",")[1];return {data,size:data.length,done:true}}throw Error("Unexpected fixture request "+path)}}};</script>`;
	await page.route("**/embedded-polling-child.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: html.replace("<head>", `<head>${bridge}`),
		})
	);
	await page.setViewportSize({ width: 1600, height: 1200 });
	await page.goto("/embedded-polling-proof.html");
	await page.locator("main").evaluate((element) => {
		element.style.maxWidth = "none";
	});
	await page.locator("iframe").evaluate((element) => {
		element.style.height = "950px";
	});
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	await expect(frame.locator("body")).toHaveAttribute(
		"data-media-reads",
		JSON.stringify({ "Slow old source": 1 })
	);
	await frame
		.getByRole("combobox", { name: "Project", exact: true })
		.selectOption(current.id);
	await expect(frame.locator("body")).toHaveAttribute("data-live-urls", "1");
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("release-old-media", "*")
		);
	await frame
		.getByRole("combobox", { name: "Project", exact: true })
		.selectOption(shared.id);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-media-reads",
		JSON.stringify({ "Slow old source": 1, "Current preview": 1 })
	);
	await expect(frame.locator("body")).toHaveAttribute("data-live-urls", "1");
	await frame
		.getByRole("combobox", { name: "Project", exact: true })
		.selectOption(empty.id);
	await expect(frame.locator("body")).toHaveAttribute("data-live-urls", "0");
	await frame
		.getByRole("combobox", { name: "Project", exact: true })
		.selectOption(current.id);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-media-reads",
		JSON.stringify({ "Slow old source": 1, "Current preview": 2 })
	);
	await expect(frame.locator("body")).toHaveAttribute("data-live-urls", "1");
	await expect
		.poll(() =>
			frame
				.locator(".studio-preview img")
				.evaluateAll((images) =>
					images.some(
						(image) =>
							image instanceof HTMLImageElement &&
							image.complete &&
							image.naturalWidth === 640
					)
				)
		)
		.toBe(true);
	expect(errors).toEqual([]);
	await page.screenshot({
		path: path.join(proofDir, "video-preview-resources-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("shared display clocks stop while hidden, catch up on return, and preserve active playback clocks", async ({
	page,
}) => {
	await page.clock.install({ time: new Date("2026-09-12T00:00:00Z") });
	await page.goto("/embedded-polling-proof.html");
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	const passive = frame.getByTestId("passive-clock");
	const playback = frame.getByTestId("playback-clock");
	await expect(passive).toHaveText(/\d+/);
	const first = await passive.textContent();
	await page.clock.fastForward(2000);
	await expect(passive).not.toHaveText(first!);
	await hideCompanion(page);
	const hidden = await passive.textContent();
	await page.clock.fastForward(9000);
	await expect(passive).toHaveText(hidden!);
	await expect(playback).not.toHaveText(hidden!);
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect(passive).not.toHaveText(hidden!);
	await frame.getByRole("button", { name: "Close panels" }).press("Enter");
	await page.clock.fastForward(3000);
	await expect(passive).toHaveCount(0);
});

test("production Research retains slow campaign reads and scopes details to the selection", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const html = await readCompanionHtml("research");
	const bridge = `<script>let lists=0,onlyB=false;addEventListener("message",e=>{if(e.data==="select-campaign-b")onlyB=true});const detailReads={};const campaigns=[{id:"a",name:"Campaign A",status:"running",started_at:"2026-09-12T00:00:00Z",baseline_score:0.6,best_score:0.8,attempt_count:2},{id:"b",name:"Campaign B",status:"running",started_at:"2026-09-12T00:00:00Z",baseline_score:0.7,best_score:0.9,attempt_count:1}];const waitFor=message=>new Promise(resolve=>{const done=e=>{if(e.data!==message)return;removeEventListener("message",done);resolve()};addEventListener("message",done)});window.ryu={app:{request:async({path})=>{if(path==="/campaigns"){document.body.dataset.campaignReads=String(++lists);if(lists===1)await waitFor("release-campaigns");return {campaigns:onlyB?campaigns.filter(campaign=>campaign.id==="b"):campaigns}}const id=path.split("/").at(-1);detailReads[id]=(detailReads[id]||0)+1;document.body.dataset.detailReads=JSON.stringify(detailReads);if(id==="a"&&detailReads[id]===1)await waitFor("release-detail-a");return {campaign:{...campaigns.find(campaign=>campaign.id===id),goal:"Goal "+id.toUpperCase(),attempts:[],reasoning:[]}}}}};</script>`;
	await page.route("**/embedded-polling-child.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: html.replace("<head>", `<head>${bridge}`),
		})
	);
	await page.clock.install({ time: new Date("2026-09-12T00:00:00Z") });
	await page.goto("/embedded-polling-proof.html");
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	await expect(frame.locator("body")).toHaveAttribute(
		"data-campaign-reads",
		"1"
	);
	await page.clock.fastForward(16_000);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-campaign-reads",
		"1"
	);
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("release-campaigns", "*")
		);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-detail-reads",
		JSON.stringify({ a: 1 })
	);
	await page.clock.fastForward(11_000);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-detail-reads",
		JSON.stringify({ a: 1 })
	);
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("select-campaign-b", "*")
		);
	await page.clock.fastForward(5000);
	await expect(frame.getByText("Goal B", { exact: true })).toBeVisible();
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("release-detail-a", "*")
		);
	await page.clock.fastForward(1);
	await expect(frame.getByText("Goal A", { exact: true })).toHaveCount(0);
	await hideCompanion(page);
	const lists = await frame.locator("body").getAttribute("data-campaign-reads");
	const details = await frame.locator("body").getAttribute("data-detail-reads");
	await page.clock.fastForward(20_000);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-campaign-reads",
		lists!
	);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-detail-reads",
		details!
	);
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect
		.poll(async () =>
			Number(await frame.locator("body").getAttribute("data-campaign-reads"))
		)
		.toBeGreaterThan(Number(lists));
	await frame
		.getByRole("button", { name: "Refresh experiments", exact: true })
		.press("Enter");
	await expect
		.poll(async () =>
			Number(await frame.locator("body").getAttribute("data-campaign-reads"))
		)
		.toBeGreaterThan(Number(lists) + 1);
	await expect(frame.getByText("Goal B", { exact: true })).toBeVisible();
	expect(errors).toEqual([]);
	await page.screenshot({
		path: path.join(proofDir, "research-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});

const workflowBridge = `<script>let reads=0,stops=0,runReads=0;let workflow={id:"workflow-a",name:"Review workflow",nodes:[{id:"input",type:"input",key:null},{id:"approval",type:"notify_user",prompt:"Review the draft"},{id:"output",type:"output",key:null}],edges:[{from:"input",to:"approval"},{from:"approval",to:"output"}],triggers:[]};const waitFor=message=>new Promise(resolve=>{const done=e=>{if(e.data!==message)return;removeEventListener("message",done);resolve()};addEventListener("message",done)});const run={runId:"run-a",workflowId:workflow.id,status:"awaiting_input",awaitingNode:"approval",createdAt:"2026-09-12T00:00:00Z",updatedAt:"2026-09-12T00:00:00Z",dryRun:false,input:{},output:{},nodes:{input:{status:"completed"},approval:{status:"running"},output:{status:"pending"}}};window.ryu={context:{workflowId:workflow.id},catalog:{snapshot:async()=>null},ghost:{recipes:async()=>[],recordStart:async()=>({recording:true,status:{event_count:0,elapsed_secs:0}}),recordStatus:async()=>{document.body.dataset.recordReads=String(++reads);await waitFor("release-record-status");return {recording:true,status:{event_count:9,elapsed_secs:12}}},recordStop:async()=>{document.body.dataset.recordStops=String(++stops);return {recording:false,task:"Review task",events:[],event_count:0,started_at:"2026-09-12T00:00:00Z"}}},workflows:{list:async()=>[workflow],schedules:async()=>[],apps:async()=>[],mcp:async()=>({servers:[],tools:[]}),notifyTargets:async()=>[],skills:async()=>[],hookEvents:async()=>[],composio:async()=>({configured:false}),versionsList:async()=>[],templatesList:async()=>[],save:async(definition)=>{workflow={...definition,id:"recorded-workflow"};return workflow},run:async()=>run,runGet:async()=>{document.body.dataset.runReads=String(++runReads);if(runReads===1){await waitFor("release-workflow-run");return run}return {...run,status:"completed",nodes:{input:{status:"completed"},approval:{status:"completed"},output:{status:"completed"}}}}}};</script>`;

test("production Workflows prevents late recorder reads from resurrecting a stopped recording", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const html = await readCompanionHtml("workflows");
	await page.route("**/embedded-polling-child.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: html.replace("<head>", `<head>${workflowBridge}`),
		})
	);
	await page.clock.install();
	await page.goto("/embedded-polling-proof.html");
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	await frame
		.getByRole("button", { name: "Record a task", exact: true })
		.press("Enter");
	await frame
		.getByRole("textbox", { name: "What are you doing?" })
		.fill("Review task");
	await frame
		.getByRole("button", { name: "Start recording", exact: true })
		.press("Enter");
	await expect(frame.getByText("Recording…", { exact: true })).toBeVisible();
	await page.clock.fastForward(1200);
	await expect(frame.locator("body")).toHaveAttribute("data-record-reads", "1");
	await page.clock.fastForward(6000);
	await expect(frame.locator("body")).toHaveAttribute("data-record-reads", "1");
	await hideCompanion(page);
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("release-record-status", "*")
		);
	await page.clock.fastForward(6000);
	await expect(frame.locator("body")).toHaveAttribute("data-record-reads", "1");
	expect(
		await frame.locator("body").getAttribute("data-record-stops")
	).toBeNull();
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect(frame.locator("body")).toHaveAttribute("data-record-reads", "2");
	await frame
		.getByRole("button", { name: "Stop & build workflow", exact: true })
		.press("Enter");
	await expect(frame.locator("body")).toHaveAttribute("data-record-stops", "1");
	await expect(frame.getByRole("dialog")).toHaveCount(0);
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("release-record-status", "*")
		);
	await page.clock.fastForward(4000);
	await frame
		.getByRole("button", { name: "Record a task", exact: true })
		.press("Enter");
	await expect(
		frame.getByRole("button", { name: "Start recording", exact: true })
	).toBeVisible();
	await expect(frame.getByText("Recording…", { exact: true })).toHaveCount(0);
	await expect(frame.locator("body")).toHaveAttribute("data-record-reads", "2");
	expect(errors).toEqual([]);
	await page.screenshot({
		path: path.join(proofDir, "workflow-recording-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("production Workflows pauses awaiting-input reads while hidden and stops after completion", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const html = await readCompanionHtml("workflows");
	await page.route("**/embedded-polling-child.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: html.replace("<head>", `<head>${workflowBridge}`),
		})
	);
	await page.clock.install();
	await page.setViewportSize({ width: 1600, height: 1200 });
	await page.goto("/embedded-polling-proof.html");
	await page.locator("main").evaluate((element) => {
		element.style.maxWidth = "none";
	});
	await page.locator("iframe").evaluate((element) => {
		element.style.height = "950px";
	});
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	await frame.getByRole("button", { name: "Run", exact: true }).press("Enter");
	await frame
		.getByRole("button", { name: "Run", exact: true })
		.last()
		.press("Enter");
	await expect(
		frame.getByText("Awaiting approvals", { exact: true })
	).toBeVisible();
	await expect(frame.locator("body")).toHaveAttribute("data-run-reads", "1");
	await page.clock.fastForward(9000);
	await expect(frame.locator("body")).toHaveAttribute("data-run-reads", "1");
	await hideCompanion(page);
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("release-workflow-run", "*")
		);
	await page.clock.fastForward(10_000);
	await expect(frame.locator("body")).toHaveAttribute("data-run-reads", "1");
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect(frame.locator("body")).toHaveAttribute("data-run-reads", "2");
	await expect(
		frame.getByText("Awaiting approvals", { exact: true })
	).toHaveCount(0);
	await page.clock.fastForward(9000);
	await expect(frame.locator("body")).toHaveAttribute("data-run-reads", "2");
	await expect(frame.getByText("awaiting_input", { exact: true })).toHaveCount(
		0
	);
	await expect(
		frame.getByText("Result", { exact: true }).locator("..")
	).toContainText("completed");
	await frame
		.getByRole("button", { name: "Hide palette", exact: true })
		.press("Enter");
	expect(errors).toEqual([]);
	await page.screenshot({
		path: path.join(proofDir, "workflow-run-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("production Video Studio history stays responsive while budget reads wait and hidden polling stops", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const project = newProject("Generation history preview");
	const asset = {
		id: crypto.randomUUID(),
		name: "Completed frame.png",
		kind: "image",
		duration: 5,
		width: 640,
		height: 360,
		hasAudio: false,
		createdAt: "2026-09-12T00:00:00Z",
	};
	const job = {
		id: crypto.randomUUID(),
		request: {
			id: crypto.randomUUID(),
			projectId: project.id,
			kind: "image",
			prompt: "Stored generation request",
		},
		projectRevision: 0,
		status: "requested",
		assetIds: [],
		message: "",
		createdAt: asset.createdAt,
		updatedAt: asset.createdAt,
	};
	const html = await readCompanionHtml("video");
	const bridge = `<script>
	const project=${JSON.stringify(project)},asset=${JSON.stringify(asset)},job=${JSON.stringify(job)};
	let reads=0,budgets=0,audits=0,complete=false,released=false;
	addEventListener("message",event=>{if(event.data==="complete-generation")complete=true;if(event.data==="release-metadata")released=true});
	const metadata=()=>released?Promise.resolve():new Promise(resolve=>{const done=event=>{if(event.data!=="release-metadata")return;removeEventListener("message",done);resolve()};addEventListener("message",done)});
	const request=async({path})=>{
		if(path==="/projects")return {projects:[project]};
		if(path==="/assets")return {assets:[asset]};
		if(path==="/renders")return {jobs:[]};
		if(path.startsWith("/generations?")){document.body.dataset.generationReads=String(++reads);return {jobs:[{...job,status:complete?"completed":"requested",assetIds:complete?[asset.id]:[]}]}};
		if(path==="/budget"){document.body.dataset.budgetReads=String(++budgets);await metadata();return {reachable:true,users:{},agents:{},sessions:{},unit:"micro_usd"}};
		if(path==="/budget/audit"){document.body.dataset.auditReads=String(++audits);await metadata();return {reachable:true,entries:[]}};
		throw Error("Unexpected fixture request "+path);
	};
	window.ryu={app:{request},media:{image:async()=>{document.body.dataset.generated="true";throw Error("Generation is not part of this read-only proof")}}};
	</script>`;
	await page.route("**/embedded-polling-child.html", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: html.replace("<head>", `<head>${bridge}`),
		})
	);
	await page.clock.install();
	await page.setViewportSize({ width: 1600, height: 1200 });
	await page.goto("/embedded-polling-proof.html");
	await page.locator("main").evaluate((element) => {
		element.style.maxWidth = "none";
	});
	await page.locator("iframe").evaluate((element) => {
		element.style.height = "950px";
	});
	const frame = page.frameLocator('iframe[title="Companion workspace"]');
	await frame.getByRole("button", { name: /Show .*more tabs/ }).click();
	await frame.getByRole("option", { name: /^Reorder Generate / }).click();
	await expect(frame.locator("body")).toHaveAttribute(
		"data-generation-reads",
		"1"
	);
	await frame.locator("summary").filter({ hasText: "Requested" }).click();
	await expect(
		frame.getByText("Stored generation request", { exact: true })
	).toBeVisible();
	await page.clock.fastForward(2100);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-generation-reads",
		"2"
	);
	await page.clock.fastForward(2100);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-generation-reads",
		"3"
	);
	await expect(frame.locator("body")).toHaveAttribute("data-budget-reads", "1");
	await expect(frame.locator("body")).toHaveAttribute("data-audit-reads", "1");
	await hideCompanion(page);
	await page.clock.fastForward(35_000);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-generation-reads",
		"3"
	);
	await expect(frame.locator("body")).toHaveAttribute("data-budget-reads", "1");
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("complete-generation", "*")
		);
	await page.getByRole("button", { name: "Companion", exact: true }).click();
	await expect(frame.locator("body")).toHaveAttribute(
		"data-generation-reads",
		"4"
	);
	await expect(
		frame.getByText("Saved media: Completed frame.png", { exact: true })
	).toBeVisible();
	await page
		.locator("iframe")
		.evaluate((element: HTMLIFrameElement) =>
			element.contentWindow?.postMessage("release-metadata", "*")
		);
	await expect(frame.locator("body")).toHaveAttribute("data-budget-reads", "2");
	await expect(frame.locator("body")).toHaveAttribute("data-audit-reads", "2");
	await page.clock.fastForward(10_000);
	await expect(frame.locator("body")).toHaveAttribute(
		"data-generation-reads",
		"4"
	);
	expect(await frame.locator("body").getAttribute("data-generated")).toBeNull();
	await frame
		.getByText("Saved media: Completed frame.png", { exact: true })
		.scrollIntoViewIfNeeded();
	expect(errors).toEqual([]);
	await page.screenshot({
		path: path.join(proofDir, "video-generation-history-completed.png"),
		fullPage: true,
		animations: "disabled",
	});
});
