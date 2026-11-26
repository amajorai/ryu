// A stand-in for the @ryu/browser sidecar in the takeover proof: two agent
// lanes, a sign-in page drawn on a canvas, and the takeover routes. It applies
// the owner's forwarded input to that page, so the proof shows the whole round
// trip (request, take control, type, Done) without Core or Electron.

import type { TakeoverInputEvent } from "@/src/components/panels/workspace-panels/browser-bot-takeover.ts";

export const PROOF_BASE = "/api/ext/@ryu/browser";
export const PROOF_AGENT = "research-agent";
/** Markup in the reason must show as plain text. */
export const PROOF_REASON =
	"Sign in to mail.example.com so I can read the Acme invoice <b>(one step)</b>";
export const PROOF_PAGE = { height: 750, width: 1200 };
export const PROOF_EMAIL_FIELD = { height: 44, width: 360, x: 420, y: 300 };
export const PROOF_PASSWORD_FIELD = { height: 44, width: 360, x: 420, y: 384 };
const SUBMIT_BUTTON = { height: 44, width: 360, x: 420, y: 464 };

const SIGN_IN_TAB = "t1";
const OTHER_AGENT = "support-agent";
const SIGN_IN_PATH = `${PROOF_BASE}/lanes/${PROOF_AGENT}/tabs/${SIGN_IN_TAB}`;
const JPEG_PREFIX = "data:image/jpeg;base64,";

export type ProofRequest = "active" | "none" | "pending";
type Focus = "email" | "none" | "password";

interface Box {
	height: number;
	width: number;
	x: number;
	y: number;
}

const state = {
	email: "",
	focus: "none" as Focus,
	inputRequests: 0,
	outcome: null as "declined" | "done" | null,
	password: "",
	request: "none" as ProofRequest,
	seq: 0,
	signedIn: false,
};

const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
	version += 1;
	for (const listener of listeners) {
		listener();
	}
}

export function subscribeProof(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function proofVersion(): number {
	return version;
}

/** What the proof may read back. The password itself is never part of it. */
export function proofSnapshot() {
	return {
		email: state.email,
		frames: state.seq,
		inputRequests: state.inputRequests,
		outcome: state.outcome,
		passwordLength: state.password.length,
		request: state.request,
		signedIn: state.signedIn,
	};
}

/** The agent asks its owner to act in the sign-in tab. */
export function askForTakeover(): void {
	state.request = "pending";
	state.outcome = null;
	changed();
}

function inside(box: Box, x: number, y: number): boolean {
	return (
		x >= box.x &&
		x <= box.x + box.width &&
		y >= box.y &&
		y <= box.y + box.height
	);
}

function typeText(text: string): void {
	if (state.focus === "email") {
		state.email += text;
	} else if (state.focus === "password") {
		state.password += text;
	}
}

function eraseOne(): void {
	if (state.focus === "email") {
		state.email = state.email.slice(0, -1);
	} else if (state.focus === "password") {
		state.password = state.password.slice(0, -1);
	}
}

function submit(): void {
	state.signedIn = state.email !== "" && state.password !== "";
}

function pressAt(x: number, y: number): void {
	if (inside(SUBMIT_BUTTON, x, y)) {
		submit();
	} else if (inside(PROOF_EMAIL_FIELD, x, y)) {
		state.focus = "email";
	} else if (inside(PROOF_PASSWORD_FIELD, x, y)) {
		state.focus = "password";
	} else {
		state.focus = "none";
	}
}

function pressKey(key: string): void {
	if (key === "Enter") {
		submit();
	} else if (key === "Tab") {
		state.focus = state.focus === "email" ? "password" : "email";
	} else if (key === "Backspace") {
		eraseOne();
	} else if ([...key].length === 1) {
		typeText(key);
	}
}

function applyEvent(event: TakeoverInputEvent): void {
	if (state.signedIn) {
		return;
	}
	if (event.type === "mouse" && event.action === "down") {
		pressAt(event.x, event.y);
	} else if (event.type === "text") {
		typeText(event.text);
	} else if (event.type === "key" && event.action === "down") {
		pressKey(event.key);
	}
}

function drawField(
	context: CanvasRenderingContext2D,
	box: Box,
	label: string,
	value: string,
	focused: boolean
): void {
	context.fillStyle = "#374151";
	context.font = "15px sans-serif";
	context.fillText(label, box.x, box.y - 10);
	context.fillStyle = "#ffffff";
	context.fillRect(box.x, box.y, box.width, box.height);
	context.lineWidth = focused ? 3 : 1;
	context.strokeStyle = focused ? "#2563eb" : "#9ca3af";
	context.strokeRect(box.x, box.y, box.width, box.height);
	context.fillStyle = "#111827";
	context.font = "18px sans-serif";
	context.fillText(value, box.x + 12, box.y + 29);
}

function drawSignIn(context: CanvasRenderingContext2D): void {
	context.fillStyle = "#111827";
	context.font = "bold 28px sans-serif";
	context.fillText("Sign in", 420, 240);
	drawField(
		context,
		PROOF_EMAIL_FIELD,
		"Email",
		state.email,
		state.focus === "email"
	);
	drawField(
		context,
		PROOF_PASSWORD_FIELD,
		"Password",
		"•".repeat(state.password.length),
		state.focus === "password"
	);
	context.fillStyle = "#2563eb";
	context.fillRect(
		SUBMIT_BUTTON.x,
		SUBMIT_BUTTON.y,
		SUBMIT_BUTTON.width,
		SUBMIT_BUTTON.height
	);
	context.fillStyle = "#ffffff";
	context.font = "bold 17px sans-serif";
	context.fillText("Sign in", SUBMIT_BUTTON.x + 148, SUBMIT_BUTTON.y + 28);
}

function drawInbox(context: CanvasRenderingContext2D): void {
	context.fillStyle = "#111827";
	context.font = "bold 28px sans-serif";
	context.fillText("Inbox", 420, 240);
	context.font = "18px sans-serif";
	context.fillText(`Signed in as ${state.email}`, 420, 290);
	context.fillStyle = "#374151";
	context.fillText("Acme Corp - Invoice 1042 is ready", 420, 350);
	context.fillText("Acme Corp - Your receipt for October", 420, 390);
}

/** The page of a lane tab as a base64 JPEG, like a screencast frame. */
function drawPage(signInTab: boolean): string {
	const canvas = document.createElement("canvas");
	canvas.width = PROOF_PAGE.width;
	canvas.height = PROOF_PAGE.height;
	const context = canvas.getContext("2d");
	if (!context) {
		return "";
	}
	context.fillStyle = "#f3f4f6";
	context.fillRect(0, 0, PROOF_PAGE.width, PROOF_PAGE.height);
	context.fillStyle = "#1f3a5f";
	context.fillRect(0, 0, PROOF_PAGE.width, 64);
	context.fillStyle = "#ffffff";
	context.font = "bold 22px sans-serif";
	context.fillText(signInTab ? "Example Mail" : "Example Help Center", 32, 41);
	context.fillStyle = "#ffffff";
	context.fillRect(360, 150, 480, 420);
	if (!signInTab) {
		context.fillStyle = "#111827";
		context.font = "bold 28px sans-serif";
		context.fillText("How to export a report", 420, 240);
	} else if (state.signedIn) {
		drawInbox(context);
	} else {
		drawSignIn(context);
	}
	return canvas.toDataURL("image/jpeg", 0.85).slice(JPEG_PREFIX.length);
}

function lanesReply() {
	const takeover =
		state.request === "none"
			? {}
			: {
					takeover: {
						expires_at: "2026-11-18T02:10:00.000Z",
						reason: PROOF_REASON,
						requested_at: "2026-11-18T02:00:00.000Z",
						status: state.request,
						tab_id: SIGN_IN_TAB,
					},
				};
	return {
		lanes: [
			{
				agent_id: PROOF_AGENT,
				tabs: [
					{
						id: SIGN_IN_TAB,
						title: state.signedIn ? "Inbox" : "Sign in",
						url: state.signedIn
							? "https://mail.example.com/inbox"
							: "https://mail.example.com/login",
					},
				],
				...takeover,
			},
			{
				agent_id: OTHER_AGENT,
				tabs: [
					{
						id: "t7",
						title: "How to export a report",
						url: "https://help.example.com/export",
					},
				],
			},
		],
	};
}

function frameReply(path: string) {
	state.seq += 1;
	// Tells the proof that a newer frame was drawn (`frames` in the snapshot).
	queueMicrotask(changed);
	return {
		frame: {
			captured_at: "2026-11-18T02:00:00.000Z",
			height: PROOF_PAGE.height,
			image: drawPage(path.startsWith(SIGN_IN_PATH)),
			mime: "image/jpeg",
			seq: state.seq,
			via: "screencast",
			width: PROOF_PAGE.width,
		},
		ok: true,
	};
}

function answerTakeover(body: { action?: string }): Promise<Response> {
	if (state.request === "none") {
		return Promise.reject(new Error("409"));
	}
	if (body.action === "accept") {
		state.request = "active";
	} else {
		state.outcome = body.action === "done" ? "done" : "declined";
		state.request = "none";
	}
	changed();
	return Promise.resolve(Response.json({ ok: true }));
}

function takeInput(body: { events?: TakeoverInputEvent[] }): Promise<Response> {
	// Like the sidecar: input is refused unless the owner has control.
	if (state.request !== "active") {
		return Promise.reject(new Error("409"));
	}
	state.inputRequests += 1;
	for (const event of body.events ?? []) {
		applyEvent(event);
	}
	changed();
	return Promise.resolve(Response.json({ ok: true }));
}

/** The panel's sidecar call, answered by this stand-in. */
export function proofCall(path: string, init?: RequestInit): Promise<Response> {
	const method = init?.method ?? "GET";
	const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
	if (path === `${PROOF_BASE}/lanes`) {
		return Promise.resolve(Response.json(lanesReply()));
	}
	if (path.endsWith("/screencast")) {
		return Promise.resolve(
			Response.json(method === "DELETE" ? { ok: true } : frameReply(path))
		);
	}
	if (path === `${SIGN_IN_PATH}/takeover`) {
		return answerTakeover(body);
	}
	if (path === `${SIGN_IN_PATH}/input`) {
		return takeInput(body);
	}
	return Promise.reject(new Error("404"));
}

/** Start state from the page address: `?request=pending` or `?request=active`. */
export function startProof(search: string): void {
	const wanted = new URLSearchParams(search).get("request");
	if (wanted === "pending" || wanted === "active") {
		state.request = wanted;
	}
}
