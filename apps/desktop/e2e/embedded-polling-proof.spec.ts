import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	hideCompanion,
	proofDir,
	readCompanionHtml,
} from "./embedded-polling-proof.helpers.ts";

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
