// Reference Ryu App — a full-page COMPANION app that exercises the whole app
// host-bridge: durable storage, a tool-less model completion, and a full
// tool-using sub-agent, then renders their results. This is the copy-template for
// building a Ryu App (e.g. porting the whiteboard): swap the plain DOM below for
// your own UI (React/Remotion/Excalidraw/…) and keep the `context.plugin.host.*`
// capability calls.
//
// Contract (see apps/desktop/src/contributions/host/third-party-plugin.ts): the
// desktop host evaluates this module inside a NULL-ORIGIN sandboxed iframe and
// calls `activate(context)`. `context.plugin.host` is the capability surface; every
// call is an RPC over a capability-gated MessagePort that the host grant-gates
// against this app's Gateway-approved grants and forwards to Core
// (`POST /api/plugins/:id/host`). This module never sees a token and cannot reach
// the network directly (CSP `connect-src 'none'`).
//
// Grants this app requests (manifest.json `permission_grants`):
//   - `hook:side-model` → host.sideModel(...)   (a tool-less completion)
//   - `hook:run-agent`  → host.runAgent(...)     (a clean-context tool-using agent)
//   - `storage:kv`      → host.storage.*         (durable per-app key/value)

async function activate(context) {
	const host = context.plugin.host;
	const root = document.getElementById("ryu-plugin-root");
	if (!root) {
		return;
	}

	// ── Durable storage: count visits. Values are STRINGS — JSON.stringify/parse
	// structured state yourself (the store is a string KV, isolated per app). ──
	let visits = 0;
	try {
		const raw = await host.storage.get({ key: "visits" });
		visits = raw ? Number.parseInt(raw, 10) || 0 : 0;
	} catch (_e) {
		// storage:kv not granted → leave visits at 0 and keep rendering.
	}
	visits += 1;
	try {
		await host.storage.set({ key: "visits", value: String(visits) });
	} catch (_e) {
		/* not granted — non-fatal */
	}

	// Render the shell immediately; capability results stream in as they resolve.
	root.replaceChildren();
	root.appendChild(el("h2", "Reference Ryu App"));
	root.appendChild(el("p", `You have opened this app ${visits} time(s).`));

	const modelBox = section(root, "Model completion (host.sideModel)");
	const agentBox = section(root, "Agent run (host.runAgent)");
	const feedbackBox = section(root, "Feedback (stored in this app's KV)");

	// ── A tool-less one-shot completion. Gateway-routed; returns final text. ──
	host
		.sideModel({
			system: "You are concise.",
			prompt: "In one short sentence, say hello to a developer building a Ryu app.",
		})
		.then((text) => setBody(modelBox, String(text)))
		.catch((e) => setBody(modelBox, `unavailable: ${errText(e)}`));

	// ── A full tool-using sub-agent with a clean context (non-streaming in v1;
	// resolves once with final text). This is the "use an agent inside your app"
	// primitive — e.g. the expense app drives Gmail-via-Composio through here. ──
	setBody(agentBox, "running…");
	host
		.runAgent({
			task: "Reply with a one-line confirmation that the agent capability works.",
			wall_time_secs: 60,
		})
		.then((out) => setBody(agentBox, String(out)))
		.catch((e) => setBody(agentBox, `unavailable: ${errText(e)}`));

	// ── Feedback learning pattern (inbox/news): thumbs are stored in the app's own
	// KV under a reserved namespace. The app can later feed accumulated signals into
	// its own sideModel/runAgent prompts. No new capability needed in v1. ──
	renderFeedback(feedbackBox, host);
}

// ── tiny DOM helpers (no framework — swap for your UI in a real app) ──

function el(tag, text) {
	const node = document.createElement(tag);
	if (text !== undefined) {
		node.textContent = text;
	}
	return node;
}

function section(root, title) {
	const wrap = el("div");
	wrap.style.margin = "12px 0";
	wrap.style.padding = "10px 12px";
	wrap.style.border = "1px solid #3f3f46";
	wrap.style.borderRadius = "6px";
	wrap.appendChild(el("strong", title));
	const body = el("div");
	body.style.marginTop = "6px";
	body.style.whiteSpace = "pre-wrap";
	body.textContent = "…";
	wrap.appendChild(body);
	wrap._body = body;
	root.appendChild(wrap);
	return wrap;
}

function setBody(sectionEl, text) {
	if (sectionEl && sectionEl._body) {
		sectionEl._body.textContent = text;
	}
}

function errText(e) {
	return e && e.message ? e.message : String(e);
}

function renderFeedback(box, host) {
	setBody(box, "Was this app useful?");
	const row = el("div");
	row.style.marginTop = "8px";
	row.style.display = "flex";
	row.style.gap = "8px";
	for (const [label, signal] of [
		["👍 Useful", "up"],
		["👎 Not useful", "down"],
	]) {
		const btn = el("button", label);
		btn.style.cursor = "pointer";
		btn.addEventListener("click", () => {
			host.storage
				.set({ namespace: "feedback", key: `vote-${Date.now()}`, value: signal })
				.then(() => setBody(box, `Recorded: ${signal}. Thanks!`))
				.catch((e) => setBody(box, `could not record: ${errText(e)}`));
		});
		row.appendChild(btn);
	}
	box.appendChild(row);
}

// Resolution paths the host bootstrap accepts: a collectable `activate` OR a
// `globalThis.__ryuPlugin` with one. Provide both so any packer output works.
globalThis.__ryuPlugin = { activate };
