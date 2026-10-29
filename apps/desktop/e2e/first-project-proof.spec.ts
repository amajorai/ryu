import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import { type ProofJsonRecord, parseProofJsonRecord } from "./fixture-json.ts";

interface Call {
	authorization: string | undefined;
	body: unknown;
	method: string;
	path: string;
}
async function fixture(
	options: { refuseFirst?: boolean; holdAcknowledgement?: boolean } = {}
) {
	const directory = await mkdtemp(
		path.join(tmpdir(), "ryu-first-project-browser-")
	);
	const file = path.join(directory, "projects.json");
	const calls: Call[] = [];
	const projects: ProofJsonRecord[] = [];
	await writeFile(file, JSON.stringify(projects));
	let release = () => {};
	const acknowledgement = new Promise<void>((resolve) => {
		release = resolve;
	});
	const server = createServer(async (req, res) => {
		try {
			res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:5296");
			res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
			res.setHeader(
				"Access-Control-Allow-Headers",
				req.headers["access-control-request-headers"] ??
					"authorization,content-type"
			);
			if (req.method === "OPTIONS") {
				res.writeHead(204).end();
				return;
			}
			let raw = "";
			for await (const chunk of req) {
				raw += chunk;
			}
			const body = raw ? parseProofJsonRecord(raw) : null;
			const requestPath = new URL(req.url ?? "/", "http://fixture").pathname;
			calls.push({
				method: req.method ?? "GET",
				path: requestPath,
				authorization: req.headers.authorization,
				body,
			});
			res.setHeader("Content-Type", "application/json");
			if (requestPath !== "/api/projects/projects") {
				res
					.writeHead(404)
					.end(JSON.stringify({ error: "Unknown fixture endpoint" }));
				return;
			}
			if (req.headers.authorization !== "Bearer first-project-node-token") {
				res
					.writeHead(401)
					.end(JSON.stringify({ error: "Invalid fixture node token" }));
				return;
			}
			if (req.method === "GET") {
				res.end(
					JSON.stringify({ projects: JSON.parse(await readFile(file, "utf8")) })
				);
				return;
			}
			if (req.method !== "POST" || !body) {
				res
					.writeHead(400)
					.end(JSON.stringify({ error: "Invalid fixture request" }));
				return;
			}
			if (
				options.refuseFirst &&
				calls.filter((call) => call.method === "POST").length === 1
			) {
				res
					.writeHead(503)
					.end(JSON.stringify({ error: "Projects app is unavailable" }));
				return;
			}
			const project = {
				...body,
				id: "project-acknowledged",
				name: "Node-confirmed launch",
				status: "active",
				coordinatorConversationId: "main-thread-acknowledged",
			};
			projects.push(project);
			await writeFile(file, JSON.stringify(projects));
			if (options.holdAcknowledgement) {
				await acknowledgement;
			}
			res.end(JSON.stringify(project));
		} catch (cause) {
			res.writeHead(500).end(JSON.stringify({ error: String(cause) }));
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || isNativeText(address)) {
		throw new Error("Missing fixture address");
	}
	return {
		url: `http://127.0.0.1:${address.port}`,
		calls,
		release,
		read: async () => JSON.parse(await readFile(file, "utf8")),
		close: async () => {
			release();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve()))
			);
			await rm(directory, { recursive: true, force: true });
		},
	};
}
async function mount(page: Page, url: string, view?: string) {
	await page.route("https://api.iconify.design/**", async (route) => {
		const request = new URL(route.request().url());
		if (request.pathname === "/collection") {
			await route.fulfill({ json: { uncategorized: ["rocket"] } });
		} else if (request.pathname === "/search") {
			await route.fulfill({ json: { icons: ["lucide:rocket"] } });
		} else {
			await route.fulfill({
				contentType: "image/svg+xml",
				body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 20L20 4"/></svg>',
			});
		}
	});
	await page.goto(
		`/first-project-proof.html?target=${encodeURIComponent(url)}${view ? `&view=${view}` : ""}`
	);
}
async function draft(page: Page) {
	await page
		.getByLabel("Project name", { exact: true })
		.fill("  Launch project  ");
	await page
		.getByLabel("What is this project about?", { exact: false })
		.fill("  Ship the reviewed release.  ");
}
function posts(calls: Call[]) {
	return calls.filter((call) => call.method === "POST");
}

test("real create caller retains draft/icon during held acknowledgement, prevents duplicate submits and reopens node-authoritative project", async ({
	page,
}, testInfo) => {
	const api = await fixture({ holdAcknowledgement: true });
	try {
		await mount(page, api.url);
		await draft(page);
		await expect(
			page.getByRole("button", { name: "Add a folder", exact: true })
		).toHaveCount(0);
		await page.getByRole("button", { name: "Set icon", exact: true }).click();
		await page.getByRole("tab", { name: "Icon", exact: true }).click();
		await page
			.getByRole("button", { name: "lucide:rocket", exact: true })
			.click();
		await page.getByRole("button", { name: "Use icon", exact: true }).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Change icon", exact: true })
		).toBeVisible();
		await page.locator("form").evaluate((form) => {
			form.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true })
			);
			form.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true })
			);
		});
		await expect.poll(() => posts(api.calls).length).toBe(1);
		await expect(
			page.getByRole("button", { name: "Creating…", exact: true })
		).toBeDisabled();
		await expect(
			page.getByRole("button", { name: "Skip for now", exact: true })
		).toBeDisabled();
		await expect(
			page.getByLabel("Project name", { exact: true })
		).toBeDisabled();
		await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
			"  Launch project  "
		);
		await expect(page.getByTestId("acknowledged-project")).toHaveCount(0);
		expect(posts(api.calls)[0]).toEqual({
			method: "POST",
			path: "/api/projects/projects",
			authorization: "Bearer first-project-node-token",
			body: {
				name: "Launch project",
				description: "Ship the reviewed release.",
				instructions: "Ship the reviewed release.",
				icon: { kind: "icon", id: "lucide:rocket" },
				coordinatorAgent: "coordinator-reviewed",
				defaults: { effort: "", model: "", provider: "" },
				executionMode: "auto",
			},
		});
		await expect.poll(async () => (await api.read()).length).toBe(1);
		api.release();
		await expect(
			page.getByRole("heading", { name: "Node-confirmed launch", exact: true })
		).toBeVisible();
		expect(
			JSON.parse(await page.getByTestId("initial-project-tab").innerText())
		).toEqual({
			conversationId: "main-thread-acknowledged",
			path: "/chat",
			title: "Node-confirmed launch",
		});
		expect(
			JSON.parse(await page.getByTestId("acknowledged-project").innerText())
		).toEqual((await api.read())[0]);
		await mount(page, api.url, "readback");
		await page.reload();
		await expect(
			page.getByRole("heading", { name: "Node-confirmed launch", exact: true })
		).toBeVisible();
		expect(
			JSON.parse(await page.getByTestId("saved-project").innerText())
		).toEqual((await api.read())[0]);
		expect(posts(api.calls)).toHaveLength(1);
		await page.screenshot({
			path: testInfo.outputPath("first-project-saved-readback.png"),
			fullPage: true,
		});
	} finally {
		await api.close();
	}
});

test("node refusal keeps unchanged fields and no project; Retry acknowledges exactly once", async ({
	page,
}, testInfo) => {
	const api = await fixture({ refuseFirst: true });
	try {
		await mount(page, api.url);
		await draft(page);
		await page
			.getByRole("button", { name: "Create project", exact: true })
			.click();
		await expect(page.getByRole("alert")).toContainText(
			"Projects app is unavailable"
		);
		await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
			"  Launch project  "
		);
		await expect(
			page.getByLabel("What is this project about?", { exact: false })
		).toHaveValue("  Ship the reviewed release.  ");
		expect(await api.read()).toEqual([]);
		await expect(
			page.getByRole("button", { name: "Skip for now", exact: true })
		).toBeEnabled();
		await expect
			.poll(() =>
				page
					.getByRole("heading", {
						name: "Create your first project",
						exact: true,
					})
					.evaluate((heading) => {
						for (
							let element: Element | null = heading;
							element;
							element = element.parentElement
						) {
							const style = getComputedStyle(element);
							if (
								Number(style.opacity) < 1 ||
								(style.filter !== "none" && style.filter !== "blur(0px)")
							) {
								return false;
							}
						}
						return true;
					})
			)
			.toBe(true);
		await page.screenshot({
			path: testInfo.outputPath("first-project-refusal-retained-draft.png"),
			fullPage: true,
		});
		await page.getByRole("button", { name: "Retry", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Node-confirmed launch", exact: true })
		).toBeVisible();
		expect(posts(api.calls)).toHaveLength(2);
		expect(posts(api.calls)[1]).toEqual(posts(api.calls)[0]);
		expect(await api.read()).toHaveLength(1);
		await expect(page.getByRole("alert")).toHaveCount(0);
	} finally {
		await api.close();
	}
});

test("whitespace name refuses writes, character limits retain fields, and Skip records the canonical preference", async ({
	page,
}, testInfo) => {
	const api = await fixture();
	try {
		await mount(page, api.url);
		await page.getByLabel("Project name", { exact: true }).fill("   ");
		await expect(
			page.getByRole("button", { name: "Create project", exact: true })
		).toBeDisabled();
		await page
			.locator("form")
			.evaluate((form) =>
				form.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true })
				)
			);
		expect(posts(api.calls)).toEqual([]);
		await expect(
			page.getByLabel("Project name", { exact: true })
		).toHaveAttribute("maxlength", "80");
		await expect(
			page.getByLabel("What is this project about?", { exact: false })
		).toHaveAttribute("maxlength", "2000");
		await page
			.getByRole("button", { name: "Skip for now", exact: true })
			.click();
		await expect(
			page.getByRole("heading", {
				name: "Project skipped for now",
				exact: true,
			})
		).toBeVisible();
		expect(
			await page.evaluate(() =>
				localStorage.getItem("ryu:onboarding-first-project-skipped")
			)
		).toBe("1");
		expect(posts(api.calls)).toEqual([]);
		expect(await api.read()).toEqual([]);
		await page.screenshot({
			path: testInfo.outputPath("first-project-skipped.png"),
			fullPage: true,
		});
	} finally {
		await api.close();
	}
});

test("native dialog IPC cancellation/refusal retain draft and confirmed folder binds locally only after project acknowledgement", async ({
	page,
}) => {
	const api = await fixture({ holdAcknowledgement: true });
	try {
		await page.addInitScript(() => {
			interface FirstProjectDialogCapture {
				calls: { command: string; args: unknown }[];
				next: string;
				unexpected: string[];
			}
			const bridge: FirstProjectDialogCapture = {
				calls: [],
				next: "cancel",
				unexpected: [],
			};
			Object.assign(window, {
				__firstProjectDialog: bridge,
				__TAURI_INTERNALS__: {
					transformCallback: () => 1,
					invoke: async (command: string, args: { path?: string }) => {
						bridge.calls.push({ command, args });
						if (
							command === "plugin:store|load" &&
							"path" in args &&
							args.path === "auth.bin"
						) {
							throw new Error("Fixture has no native credential store");
						}
						// The sealed account-vault slot: empty, and no window events.
						if (
							command === "desktop_secret_get" ||
							command === "desktop_secret_set" ||
							command === "desktop_secret_delete" ||
							command === "plugin:event|listen" ||
							command === "plugin:event|unlisten"
						) {
							return command === "plugin:event|listen" ? 1 : null;
						}
						if (command !== "plugin:dialog|open") {
							bridge.unexpected.push(command);
							throw new Error(`Unexpected native capability: ${command}`);
						}
						if (bridge.next === "cancel") {
							return null;
						}
						if (bridge.next === "refuse") {
							throw new Error("Dialog refused");
						}
						return "/fixture/reviewed-project";
					},
				},
			});
		});
		await mount(page, api.url);
		await draft(page);
		await page
			.getByRole("button", { name: "Add a folder", exact: true })
			.click();
		await expect(
			page.getByText("No folder yet (optional)", { exact: true })
		).toBeVisible();
		await page.evaluate(() => {
			const bridge =
				/* SAFETY: This spec addInitScript publishes its locally typed dialog bridge before mount. These views access only the authored string selector and raw calls/string unexpected captures, preserving all original matchers. */ (
					window as Window & { __firstProjectDialog: { next: string } }
				).__firstProjectDialog;
			bridge.next = "refuse";
		});
		await page
			.getByRole("button", { name: "Add a folder", exact: true })
			.click();
		await expect(page.getByRole("alert")).toHaveText(
			"The folder picker isn't available here. You can add a folder later."
		);
		await page.evaluate(() => {
			const bridge =
				/* SAFETY: This spec addInitScript publishes its locally typed dialog bridge before mount. These views access only the authored string selector and raw calls/string unexpected captures, preserving all original matchers. */ (
					window as Window & { __firstProjectDialog: { next: string } }
				).__firstProjectDialog;
			bridge.next = "selected";
		});
		await page
			.getByRole("button", { name: "Add a folder", exact: true })
			.click();
		await expect(
			page.getByText("/fixture/reviewed-project", { exact: true })
		).toBeVisible();
		const dialogCalls = await page.evaluate(
			() =>
				/* SAFETY: This spec addInitScript publishes its locally typed dialog bridge before mount. These views access only the authored string selector and raw calls/string unexpected captures, preserving all original matchers. */ (
					window as Window & { __firstProjectDialog: { calls: unknown[] } }
				).__firstProjectDialog.calls
		);
		expect(
			await page.evaluate(
				() =>
					/* SAFETY: The same spec addInitScript publishes the typed dialog bridge before mount; this view reads only its string unexpected-command capture under the original assertion. */ (
						window as Window & {
							__firstProjectDialog: { unexpected: string[] };
						}
					).__firstProjectDialog.unexpected
			)
		).toEqual([]);
		// The vault is read from the sealed slot, never written in plaintext.
		expect(dialogCalls).toContainEqual({
			command: "desktop_secret_get",
			args: { name: "auth-vault" },
		});
		expect(
			dialogCalls.filter(
				(call) =>
					typeof call === "object" &&
					call !== null &&
					"command" in call &&
					call.command === "plugin:store|set"
			)
		).toEqual([]);
		expect(
			dialogCalls.filter(
				(call) =>
					typeof call === "object" &&
					call !== null &&
					"command" in call &&
					call.command === "plugin:dialog|open"
			)
		).toEqual(
			Array.from({ length: 3 }, () => ({
				command: "plugin:dialog|open",
				args: { options: { directory: true, multiple: false } },
			}))
		);
		expect(
			await page.evaluate(() =>
				localStorage.getItem("ryu_workspace_projects_v1")
			)
		).toBeNull();
		await page.getByRole("button", { name: "Retry", exact: true }).click();
		await expect.poll(() => posts(api.calls).length).toBe(1);
		expect(
			z.object({ cwd: z.string() }).parse(posts(api.calls)[0].body).cwd
		).toBe("/fixture/reviewed-project");
		expect(
			await page.evaluate(() =>
				localStorage.getItem("ryu_workspace_projects_v1")
			)
		).toBeNull();
		api.release();
		await expect(page.getByTestId("acknowledged-project")).toBeVisible();
		expect(
			await page.evaluate(() =>
				JSON.parse(localStorage.getItem("ryu_workspace_projects_v1") ?? "[]")
			)
		).toEqual([
			{
				folders: ["/fixture/reviewed-project"],
				id: "folder:%2Ffixture%2Freviewed-project",
			},
		]);
		expect(
			await page.evaluate(
				() =>
					/* SAFETY: The same spec addInitScript publishes the typed dialog bridge before mount; this view reads only its string unexpected-command capture under the original assertion. */ (
						window as Window & {
							__firstProjectDialog: { unexpected: string[] };
						}
					).__firstProjectDialog.unexpected
			)
		).toEqual([]);
		await page.reload();
		expect(
			await page.evaluate(() =>
				JSON.parse(localStorage.getItem("ryu_workspace_projects_v1") ?? "[]")
			)
		).toEqual([
			{
				folders: ["/fixture/reviewed-project"],
				id: "folder:%2Ffixture%2Freviewed-project",
			},
		]);
		expect(posts(api.calls)).toHaveLength(1);
	} finally {
		await api.close();
	}
});
