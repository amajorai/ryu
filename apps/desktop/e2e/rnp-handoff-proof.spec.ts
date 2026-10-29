import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 360_000 });

test("moves visible context without crossing node credentials", async ({
	page,
}, testInfo) => {
	let sourceCredentialVerified = false;
	let destinationCredentialVerified = false;
	let firstResumeBody: string | null = null;
	let resumeAttempts = 0;

	await page.route(
		"**/source/api/rnp/v0/conversations/**/export",
		async (route) => {
			const request = route.request();
			const exportRequest = request.postDataJSON();
			expect(exportRequest.ifUpdatedAt).toBe(1_777_000_000_000);
			expect(request.headers().authorization).toBe("Bearer source-token");
			expect(request.headers().authorization).not.toContain(
				"destination-token"
			);
			sourceCredentialVerified = true;
			await route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({
					protocol: "ryu-node-continuity",
					version: 0,
					bundleId: "bundle-proof",
					createdAt: 1_777_000_000_000,
					source: {
						conversationId: "conversation-proof",
						updatedAt: 1_777_000_000_000,
						title: "Research handoff",
						agentHint: "researcher",
					},
					selection: {
						transcript: { mode: "recent", maxMessages: 50 },
						omittedEarlierMessages: false,
					},
					messages: [
						{
							sourceId: "message-1",
							role: "user",
							text: "Compare the sources.",
							createdAt: 1_777_000_000_001,
						},
						{
							sourceId: "message-2",
							role: "assistant",
							text: "The evidence is ready for review.",
							createdAt: 1_777_000_000_002,
						},
					],
					context: { version: 0, items: [] },
				}),
			});
		}
	);

	await page.route(
		"**/destination/api/rnp/v0/conversations/**/resume",
		async (route) => {
			const request = route.request();
			expect(request.headers().authorization).toBe("Bearer destination-token");
			expect(request.headers().authorization).not.toContain("source-token");
			const bundle = request.postDataJSON();
			expect(bundle.context.items).toHaveLength(1);
			expect(bundle.context.items[0].text).toBe(
				"Focus the follow-up on the conflicting benchmarks."
			);
			const serializedBundle = JSON.stringify(bundle);
			resumeAttempts += 1;
			if (resumeAttempts === 1) {
				firstResumeBody = serializedBundle;
				await route.abort("connectionreset");
				return;
			}
			expect(serializedBundle).toBe(firstResumeBody);
			destinationCredentialVerified = true;
			await route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({
					version: 0,
					conversationId: "conversation-proof",
					status: "created",
					imported: { messages: 2, contextItems: 1 },
					warnings: [],
				}),
			});
		}
	);

	await page.goto("/rnp-handoff-proof.html");
	await expect(
		page.getByRole("heading", { name: "Continue on another node" })
	).toBeVisible();
	await expect(page.getByText("Compare the sources.")).toBeVisible();
	await expect(
		page.getByText("The evidence is ready for review.")
	).toBeVisible();
	await page.getByLabel("Destination node").selectOption("Studio node");
	await page
		.getByLabel("Context note (optional)")
		.fill("Focus the follow-up on the conflicting benchmarks.");
	await page.getByLabel(/Suggest the same agent/).check();
	await page.getByRole("button", { name: "Continue on selected node" }).click();
	await expect(page.getByRole("alert")).toBeVisible();
	await page.getByRole("button", { name: "Retry same handoff" }).click();

	await expect(page.getByTestId("handoff-complete")).toContainText(
		"Conversation continued on Studio node"
	);
	await expect(
		page.getByRole("heading", { name: "Continue on another node" })
	).toBeHidden();
	expect(sourceCredentialVerified).toBe(true);
	expect(destinationCredentialVerified).toBe(true);
	expect(resumeAttempts).toBe(2);
	const proofScreenshot =
		process.env.RYU_RNP_PROOF_SCREENSHOT ??
		testInfo.outputPath("rnp-handoff-complete.png");
	await page.screenshot({ path: proofScreenshot, fullPage: true });
});

test("brings the reviewed working tree and marks the source last", async ({
	page,
}) => {
	const base = "2".repeat(40);
	const bundleSha = "a".repeat(64);
	const diffSha = "b".repeat(64);
	const source = "**/source/api/rnp/v0/conversations/conversation-proof";
	const destination =
		"**/destination/api/rnp/v0/conversations/conversation-proof";
	const notes = {
		path: "notes.md",
		status: "added",
		bytes: 8,
		binary: false,
		sensitive: false,
	};
	const manifest = {
		version: 0,
		workspaceId: "workspace-proof",
		conversationId: "conversation-proof",
		createdAt: 1_777_000_000_000,
		repo: {
			name: "research",
			remoteUrl: "https://github.com/example/research.git",
			baseCommit: base,
			branch: "main",
		},
		commits: {
			blob: {
				sha256: bundleSha,
				bytes: 3,
				mediaType: "application/x-git-bundle",
			},
			tip: base,
			prerequisites: ["1".repeat(40)],
			count: 1,
		},
		diff: {
			blob: { sha256: diffSha, bytes: 2, mediaType: "text/x-diff" },
			files: [notes],
		},
		untracked: [notes],
		omitted: [{ path: ".env", reason: "not-selected" }],
	};
	const storedBlobs = new Set<string>();
	const workspaceResumeBodies: string[] = [];
	let exportRequests = 0;
	let continuedBody: Record<string, string | number> | null = null;

	await page.route(`${source}/export`, (route) =>
		route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				protocol: "ryu-node-continuity",
				version: 0,
				bundleId: "bundle-proof",
				createdAt: 1_777_000_000_000,
				source: {
					conversationId: "conversation-proof",
					updatedAt: 1_777_000_000_000,
					title: "Research handoff",
				},
				selection: {
					transcript: { mode: "recent", maxMessages: 50 },
					omittedEarlierMessages: false,
				},
				messages: [
					{
						sourceId: "message-1",
						role: "user",
						text: "Compare the sources.",
						createdAt: 1_777_000_000_001,
					},
				],
				context: { version: 0, items: [] },
			}),
		})
	);
	await page.route(`${source}/workspace/inspect`, (route) => {
		expect(route.request().headers().authorization).toBe("Bearer source-token");
		return route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				version: 0,
				conversationId: "conversation-proof",
				repo: manifest.repo,
				unpushedCommits: 1,
				changed: [],
				untrackedCandidates: [
					{ path: ".env", bytes: 9, sensitive: true, selectable: true },
					{ path: "notes.md", bytes: 8, sensitive: false, selectable: true },
				],
				diffStat: { files: 0, insertions: 0, deletions: 0 },
			}),
		});
	});
	await page.route("**/destination/api/rnp/v0/capabilities", (route) => {
		expect(route.request().headers().authorization).toBe(
			"Bearer destination-token"
		);
		return route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({ version: 0, features: ["workspace"] }),
		});
	});
	await page.route(`${source}/workspace/export`, (route) => {
		exportRequests += 1;
		expect(route.request().postDataJSON().includeUntracked).toEqual([
			"notes.md",
		]);
		return route.fulfill({
			contentType: "application/json",
			body: JSON.stringify(manifest),
		});
	});
	await page.route("**/source/api/rnp/v0/workspace-blobs/*", (route) => {
		expect(route.request().headers().authorization).toBe("Bearer source-token");
		const sha = route.request().url().split("/").pop() ?? "";
		return route.fulfill({
			contentType: "application/octet-stream",
			body: Buffer.from(sha === bundleSha ? [1, 2, 3] : [4, 5]),
		});
	});
	await page.route("**/destination/api/rnp/v0/workspace-blobs/*", (route) => {
		const request = route.request();
		expect(request.headers().authorization).toBe("Bearer destination-token");
		const sha = request.url().split("/").pop() ?? "";
		if (request.method() === "HEAD") {
			return route.fulfill({ status: storedBlobs.has(sha) ? 200 : 404 });
		}
		storedBlobs.add(sha);
		return route.fulfill({
			status: 201,
			contentType: "application/json",
			body: JSON.stringify({ sha256: sha, status: "created" }),
		});
	});
	await page.route(`${destination}/resume`, (route) =>
		route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				version: 0,
				conversationId: "conversation-proof",
				status: "created",
				imported: { messages: 1, contextItems: 0 },
				warnings: [],
			}),
		})
	);
	await page.route(`${destination}/workspace/resume`, async (route) => {
		workspaceResumeBodies.push(route.request().postData() ?? "");
		if (workspaceResumeBodies.length === 1) {
			await route.abort("connectionreset");
			return;
		}
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				version: 0,
				workspaceId: "workspace-proof",
				conversationId: "conversation-proof",
				status: "created",
				folderPath: "/Users/me/Documents/Ryu/handoffs/research-conversa",
				worktreePath:
					"/Users/me/Documents/Ryu/handoffs/research-conversa/.ryu-worktrees/handoff-workspace-pr",
				branch: "handoff/conversa",
				warnings: ["workspace-untrusted"],
			}),
		});
	});
	await page.route(`${source}/continued`, (route) => {
		expect(route.request().headers().authorization).toBe("Bearer source-token");
		continuedBody = route.request().postDataJSON();
		return route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({ continuedOn: continuedBody }),
		});
	});

	await page.goto("/rnp-handoff-proof.html");
	await page.getByLabel("Destination node").selectOption("Studio node");
	await expect(page.getByTestId("rnp-workspace-review")).toBeVisible();
	await expect(page.getByRole("checkbox", { name: /\.env/ })).not.toBeChecked();
	await expect(page.getByRole("checkbox", { name: /notes\.md/ })).toBeChecked();
	await expect(page.getByTestId("rnp-workspace-untrusted")).toBeVisible();

	await page.getByRole("button", { name: "Continue on selected node" }).click();
	await expect(page.getByRole("alert")).toBeVisible();
	expect(continuedBody).toBeNull();
	await page.getByRole("button", { name: "Retry same handoff" }).click();

	await expect(page.getByTestId("handoff-workspace")).toContainText(
		"handoff/conversa"
	);
	expect(exportRequests).toBe(1);
	expect(workspaceResumeBodies).toHaveLength(2);
	expect(workspaceResumeBodies[1]).toBe(workspaceResumeBodies[0]);
	expect(continuedBody).toMatchObject({
		nodeLabel: "Studio node",
		workspaceId: "workspace-proof",
	});
});
