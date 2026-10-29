const statePath = process.env.PULL_REQUESTS_PROOF_STATE;

if (!statePath) {
	throw new Error("PULL_REQUESTS_PROOF_STATE is required for the fake gh CLI.");
}

const readState = async () => JSON.parse(await Bun.file(statePath).text());
const writeState = async (state) =>
	Bun.write(statePath, JSON.stringify(state, null, 2));
const json = (value) => `${JSON.stringify(value)}\n`;
const repo = "octo/ryu";
const proofTime = "2026-09-27T12:00:00Z";

const args = process.argv.slice(2);
const cwd = process.cwd();
let state = await readState();

const writeText = (value) => process.stdout.write(value);
const writeOutput = (value) => {
	if (value !== undefined && value !== null) {
		process.stdout.write(json(value));
	}
};

const findPull = (number) => state.pullDetails[`${repo}#${number}`];
const findIssue = (number) => state.issueDetails[`${repo}#${number}`];

const syncPull = (detail) => {
	const summary = state.pulls.find((item) => item.number === detail.number);
	if (summary) {
		Object.assign(summary, {
			commentsCount: detail.comments.length,
			isDraft: detail.isDraft,
			mergedAt: detail.mergedAt,
			state: detail.state,
			updatedAt: proofTime,
		});
	}
};

const syncIssue = (detail) => {
	const summary = state.issues.find((item) => item.number === detail.number);
	if (summary) {
		Object.assign(summary, {
			closedAt: detail.closedAt,
			commentsCount: detail.comments.length,
			state: detail.state,
			updatedAt: proofTime,
		});
	}
};

const record = async (failed = false) => {
	state.commands.push({ argv: [...args], cwd: cwd || null, failed });
	await writeState(state);
};

const failIfRequested = async () => {
	const commandText = args.join(" ");
	const index = state.failNext.findIndex((failure) =>
		commandText.includes(failure.match)
	);
	if (index === -1) {
		return false;
	}
	const [failure] = state.failNext.splice(index, 1);
	await record(true);
	process.stderr.write(`${failure.message}\n`);
	process.exitCode = 1;
	return true;
};

const searchResults = (kind) => {
	const source = kind === "prs" ? state.pulls : state.issues;
	const scope = args.includes("--author")
		? "authored"
		: kind === "prs" && args.includes("--review-requested")
			? "reviewing"
			: kind === "issues" && args.includes("--assignee")
				? "assigned"
				: "all";
	const requestedState = args.includes("--merged")
		? "MERGED"
		: args.includes("--state")
			? args[args.indexOf("--state") + 1]?.toUpperCase()
			: "OPEN";
	const queryIndex = args.indexOf("--");
	const query =
		queryIndex >= 0
			? args
					.slice(queryIndex + 1)
					.join(" ")
					.toLowerCase()
			: "";
	const limitIndex = args.indexOf("--limit");
	const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 50;
	return source
		.filter(
			(item) =>
				scope === "all" || item._scope === "all" || item._scope === scope
		)
		.filter((item) => item.state.toUpperCase() === requestedState)
		.filter(
			(item) =>
				query.length === 0 ||
				`${item.title} ${item.repository.nameWithOwner} #${item.number}`
					.toLowerCase()
					.includes(query)
		)
		.slice(0, Number.isSafeInteger(limit) ? limit : 50)
		.map(({ _scope, ...item }) => item);
};

const api = async () => {
	const endpoint = args[1] ?? "";
	const stackList = endpoint.match(
		/^repos\/([^/]+\/[^/]+)\/stacks\?pull_request=(\d+)$/
	);
	if (stackList) {
		const [, ownerRepo, rawNumber] = stackList;
		const number = Number(rawNumber);
		const stacks = Object.entries(state.stacks)
			.filter(
				([, stack]) =>
					stack.repository === ownerRepo && stack.pullRequests.includes(number)
			)
			.map(([id]) => ({ number: Number(id), base: { ref: "main" } }));
		return stacks;
	}
	const stackDetail = endpoint.match(/^repos\/([^/]+\/[^/]+)\/stacks\/(\d+)$/);
	if (stackDetail) {
		const [, ownerRepo, stackNumber] = stackDetail;
		const stack = state.stacks[stackNumber];
		if (!stack || stack.repository !== ownerRepo) {
			return { error: "stack not found" };
		}
		let previousHead = "main";
		const pull_requests = stack.pullRequests.map((number) => {
			const detail = findPull(number);
			const entry = {
				base: { ref: previousHead },
				draft: detail?.isDraft ?? false,
				head: {
					ref: detail?.headRefName ?? `feature/pr-${number}`,
					sha: `proof-sha-${number}`,
				},
				html_url: detail?.url,
				merged_at: detail?.mergedAt,
				number,
				state: detail?.state ?? "OPEN",
				title: detail?.title ?? `Pull request ${number}`,
				user: detail?.author,
			};
			previousHead = entry.head.ref;
			return entry;
		});
		return {
			base: { ref: "main" },
			created_at: proofTime,
			number: Number(stackNumber),
			open: true,
			pull_requests,
			url: `https://github.com/${ownerRepo}/stacks/${stackNumber}`,
		};
	}
	const createStack = endpoint.match(/^repos\/([^/]+\/[^/]+)\/stacks$/);
	const addLayer = endpoint.match(
		/^repos\/([^/]+\/[^/]+)\/stacks\/(\d+)\/add$/
	);
	const unstack = endpoint.match(
		/^repos\/([^/]+\/[^/]+)\/stacks\/(\d+)\/unstack$/
	);
	const mergeStatus = endpoint.match(
		/^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/merge-async\/([^/]+)$/
	);
	const mergeAsync = endpoint.match(
		/^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/merge-async$/
	);
	const methodIndex = args.indexOf("--method");
	const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
	const fieldValues = [];
	for (let index = 2; index < args.length; index += 1) {
		if (args[index] === "--field") {
			fieldValues.push(args[index + 1] ?? "");
		}
	}
	if (createStack && method === "POST") {
		const pullRequests = fieldValues
			.filter((field) => field.startsWith("pull_requests[]="))
			.map((field) => Number(field.split("=")[1]))
			.filter(Number.isSafeInteger);
		const stackNumber = state.nextStackNumber++;
		state.stacks[String(stackNumber)] = {
			pullRequests,
			repository: createStack[1] ?? repo,
		};
		return apiStack(stackNumber);
	}
	if (addLayer && method === "POST") {
		const [, ownerRepo, stackNumber] = addLayer;
		const stack = state.stacks[stackNumber ?? ""];
		const pullRequests = fieldValues
			.filter((field) => field.startsWith("pull_requests[]="))
			.map((field) => Number(field.split("=")[1]))
			.filter(Number.isSafeInteger);
		if (stack && stack.repository === ownerRepo) {
			stack.pullRequests = [...stack.pullRequests, ...pullRequests];
		}
		return apiStack(Number(stackNumber));
	}
	if (unstack && method === "POST") {
		const [, ownerRepo, stackNumber] = unstack;
		const stack = state.stacks[stackNumber ?? ""];
		if (stack && stack.repository === ownerRepo) {
			stack.pullRequests = stack.pullRequests.filter((number) => {
				const detail = findPull(number);
				return detail?.state === "MERGED";
			});
			if (stack.pullRequests.length === 0) {
				delete state.stacks[stackNumber ?? ""];
				return null;
			}
		}
		return apiStack(Number(stackNumber));
	}
	if (mergeStatus) {
		const result = state.mergeStatuses[mergeStatus[3] ?? ""] ?? {
			status: "pending",
		};
		for (const number of result.pullNumbers ?? []) {
			const detail = findPull(number);
			if (detail) {
				detail.state = "MERGED";
				detail.mergedAt = proofTime;
				syncPull(detail);
			}
		}
		return result;
	}
	if (mergeAsync && method === "PUT") {
		const [, , rawNumber] = mergeAsync;
		const mergeMethod = fieldValues.find((field) =>
			field.startsWith("merge_method=")
		);
		const mergeAction = fieldValues.find((field) =>
			field.startsWith("merge_action=")
		);
		const action = mergeAction?.split("=")[1] ?? "merge";
		const requestId = "00000000-0000-4000-8000-000000000101";
		const stackNumbers = Object.values(state.stacks).find((stack) =>
			stack.pullRequests.includes(Number(rawNumber))
		)?.pullRequests ?? [Number(rawNumber)];
		if (action === "merge_queue") {
			state.mergeStatuses[requestId] = {
				details: { message: "Stack merge completed in test fixture." },
				pullNumbers: stackNumbers,
				status: "merged",
			};
			return {
				details: {
					message: "Stack merge accepted by local fixture.",
					uuid: requestId,
				},
				status: "pending",
			};
		}
		return {
			details: {
				message: `Fixture stack ${action} completed using ${mergeMethod?.split("=")[1] ?? "merge"}.`,
			},
			status: "merged",
		};
	}
	if (
		endpoint.startsWith(`repos/${repo}/issues/`) &&
		endpoint.endsWith("/sub_issues?per_page=100")
	) {
		return [
			{
				html_url: `https://github.com/${repo}/issues/702`,
				number: 702,
				repository: { full_name: repo },
				state: "closed",
				title: "Write retry telemetry",
			},
			{
				html_url: `https://github.com/${repo}/issues/703`,
				number: 703,
				repository: { full_name: repo },
				state: "open",
				title: "Document rollback behavior",
			},
		];
	}
	if (endpoint === "user") {
		if (!state.authenticated) {
			throw new Error("You are not logged into any GitHub hosts.");
		}
		return {
			avatarUrl: "https://avatars.githubusercontent.com/u/1",
			login: "proof-reviewer",
			name: "Proof Reviewer",
		};
	}
	throw new Error(`Unexpected local GitHub API route: ${endpoint}`);
};

const apiStack = (stackNumber) => {
	const stack = state.stacks[String(stackNumber)];
	if (!stack) {
		return null;
	}
	const pull_requests = stack.pullRequests.map((number) => {
		const detail = findPull(number);
		return {
			base: { ref: "main" },
			draft: detail?.isDraft ?? false,
			head: {
				ref: detail?.headRefName ?? `feature/pr-${number}`,
				sha: `proof-sha-${number}`,
			},
			html_url: detail?.url,
			merged_at: detail?.mergedAt,
			number,
			state: detail?.state ?? "OPEN",
			title: detail?.title ?? `Pull request ${number}`,
			user: detail?.author,
		};
	});
	return {
		base: { ref: "main" },
		created_at: proofTime,
		number: stackNumber,
		open: true,
		pull_requests,
		url: `https://github.com/${stack.repository}/stacks/${stackNumber}`,
	};
};

const main = async () => {
	if (args[0] === "auth" && args[1] === "login") {
		await record(false);
		process.stdout.write(
			"First copy your one-time code: ABCD-EFGH\nOpen https://github.com/login/device\n"
		);
		for (let attempt = 0; attempt < 600; attempt += 1) {
			state = await readState();
			if (state.authComplete) {
				state.authenticated = true;
				await writeState(state);
				return;
			}
			await Bun.sleep(100);
		}
		throw new Error("The local device authorization fixture timed out.");
	}
	if (await failIfRequested()) {
		return;
	}
	if (args[0] === "--version") {
		await record(false);
		writeText("gh version 2.76.0-proof (2026-09-27)\n");
		return;
	}
	if (args[0] === "search" && args[1] === "prs") {
		await record(false);
		writeOutput(searchResults("prs"));
		return;
	}
	if (args[0] === "search" && args[1] === "issues") {
		await record(false);
		writeOutput(searchResults("issues"));
		return;
	}
	if (args[0] === "api") {
		if (await failIfRequested()) {
			return;
		}
		try {
			const result = await api();
			await record(false);
			writeOutput(result);
		} catch (caught) {
			await record(true);
			process.stderr.write(
				`${caught instanceof Error ? caught.message : "Local API fixture failed."}\n`
			);
			process.exitCode = 1;
		}
		return;
	}
	if (args[0] === "pr" && args[1] === "view") {
		const number = Number(args[2]);
		const detail = findPull(number);
		await record(false);
		writeOutput(detail);
		return;
	}
	if (args[0] === "pr" && args[1] === "diff") {
		const detail = findPull(Number(args[2]));
		await record(false);
		writeText(detail?.diffPatch ?? "");
		return;
	}
	if (args[0] === "issue" && args[1] === "view") {
		const detail = findIssue(Number(args[2]));
		await record(false);
		writeOutput(detail);
		return;
	}
	if (args[0] === "pr" && args[1] === "comment") {
		const detail = findPull(Number(args[2]));
		const body = args[args.indexOf("--body") + 1] ?? "";
		if (detail) {
			detail.comments.push({
				author: { login: "proof-reviewer", name: "Proof Reviewer" },
				body,
				createdAt: proofTime,
				url: `${detail.url}#issuecomment-${detail.comments.length + 2}`,
			});
			syncPull(detail);
		}
		await record(false);
		return;
	}
	if (args[0] === "pr" && args[1] === "review") {
		const detail = findPull(Number(args[2]));
		const stateByFlag = args.includes("--approve")
			? "APPROVED"
			: args.includes("--request-changes")
				? "CHANGES_REQUESTED"
				: "COMMENTED";
		if (detail) {
			const bodyIndex = args.indexOf("--body");
			detail.latestReviews.push({
				author: { login: "proof-reviewer", name: "Proof Reviewer" },
				body: bodyIndex >= 0 ? (args[bodyIndex + 1] ?? "") : "",
				state: stateByFlag,
				submittedAt: proofTime,
			});
			detail.reviewDecision = stateByFlag;
			syncPull(detail);
		}
		await record(false);
		return;
	}
	if (args[0] === "pr" && args[1] === "ready") {
		const detail = findPull(Number(args[2]));
		if (detail) {
			detail.isDraft = args.includes("--undo");
			detail.reviewDecision = detail.isDraft
				? "REVIEW_REQUIRED"
				: "REVIEW_REQUIRED";
			syncPull(detail);
		}
		await record(false);
		return;
	}
	if (args[0] === "pr" && args[1] === "merge") {
		const detail = findPull(Number(args[2]));
		if (detail) {
			detail.state = "MERGED";
			detail.mergedAt = proofTime;
			syncPull(detail);
		}
		await record(false);
		return;
	}
	if (args[0] === "issue" && args[1] === "comment") {
		const detail = findIssue(Number(args[2]));
		const body = args[args.indexOf("--body") + 1] ?? "";
		if (detail) {
			detail.comments.push({
				author: { login: "proof-reviewer", name: "Proof Reviewer" },
				body,
				createdAt: proofTime,
				url: `${detail.url}#issuecomment-${detail.comments.length + 2}`,
			});
			syncIssue(detail);
		}
		await record(false);
		return;
	}
	if (args[0] === "issue" && (args[1] === "close" || args[1] === "reopen")) {
		const detail = findIssue(Number(args[2]));
		if (detail) {
			detail.state = args[1] === "close" ? "CLOSED" : "OPEN";
			detail.closedAt = detail.state === "CLOSED" ? proofTime : null;
			syncIssue(detail);
		}
		await record(false);
		return;
	}
	throw new Error(`Unexpected fake gh invocation: ${args.join(" ")}`);
};

await main();
