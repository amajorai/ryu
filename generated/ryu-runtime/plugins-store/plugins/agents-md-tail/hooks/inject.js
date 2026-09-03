// Context-hook body for AGENTS.md Tail.
// Injected globals: `ctx` (the outbound context) and `host` (the capability
// bridge). This file is a fragment, not an ES module; a top-level `return` is
// intentionally part of the sandbox contract.

const REMOVE_HEAD_PREF = "agents-md-tail-remove-head";
const TAIL_OPEN = "<ryu-agents-md-tail>";
const TAIL_CLOSE = "</ryu-agents-md-tail>";
const TAIL_BLOCK = /\n*<ryu-agents-md-tail>\n[\s\S]*?\n<\/ryu-agents-md-tail>/g;

const instructions =
	typeof ctx?.project_instructions === "string"
		? ctx.project_instructions
		: "";

if (!instructions.trim()) {
	return { kind: "none" };
}

let removeHead = false;
try {
	const raw = await host.getPreference({ key: REMOVE_HEAD_PREF });
	removeHead = raw === true || String(raw).trim().toLowerCase() === "true";
} catch {
	// Preferences are advisory. A read failure keeps the safe default: retain
	// the system/head injection and still refresh the hidden tail.
}

const tail = `\n\n${TAIL_OPEN}\n${instructions}\n${TAIL_CLOSE}`;

function stripTails(text) {
	return text.replace(TAIL_BLOCK, "");
}

function removeHeadBlock(text) {
	const index = text.indexOf(instructions);
	if (index < 0) {
		return text;
	}
	const before = text.slice(0, index);
	let after = text.slice(index + instructions.length);
	if (before.endsWith("\r\n") && after.startsWith("\r\n")) {
		after = after.slice(2);
	} else if (before.endsWith("\n") && after.startsWith("\n")) {
		after = after.slice(1);
	}
	return `${before}${after}`;
}

function cleanSystemMessage(message) {
	if (!removeHead || message?.role !== "system") {
		return message;
	}
	if (typeof message.content !== "string") {
		return message;
	}
	return { ...message, content: removeHeadBlock(message.content) };
}

function cleanStringContent(content) {
	return stripTails(content);
}

function cleanMultimodalContent(content) {
	return content.map((part) => {
		if (part && part.type === "text" && typeof part.text === "string") {
			return { ...part, text: stripTails(part.text) };
		}
		return part;
	});
}

function appendToUserMessage(message) {
	if (typeof message.content === "string") {
		return { ...message, content: `${cleanStringContent(message.content)}${tail}` };
	}
	if (Array.isArray(message.content)) {
		return {
			...message,
			content: [...cleanMultimodalContent(message.content), { type: "text", text: tail }],
		};
	}
	if (message.content === undefined || message.content === null) {
		return { ...message, content: tail.trimStart() };
	}
	return {
		...message,
		content: [{ type: "text", text: String(message.content) }, { type: "text", text: tail }],
	};
}

// ACP has no message array. `ctx.input` is the complete flattened prompt for
// this turn. The host uses `fresh_session` to prevent an old hidden tail from
// surviving inside the ACP agent's private transcript.
if (!Array.isArray(ctx?.messages)) {
	if (typeof ctx?.input !== "string" || !ctx.input.trim()) {
		return { kind: "none" };
	}
	let prompt = stripTails(ctx.input);
	if (removeHead) {
		prompt = removeHeadBlock(prompt);
	}
	return { kind: "replace", text: `${prompt}${tail}`, fresh_session: true };
}

const messages = ctx.messages.map((message) => {
	if (!message || message.role !== "user") {
		return cleanSystemMessage(message);
	}
	if (typeof message.content === "string") {
		return { ...message, content: cleanStringContent(message.content) };
	}
	if (Array.isArray(message.content)) {
		return { ...message, content: cleanMultimodalContent(message.content) };
	}
	return message;
});

let lastUserIndex = -1;
for (let index = messages.length - 1; index >= 0; index -= 1) {
	if (messages[index]?.role === "user") {
		lastUserIndex = index;
		break;
	}
}

if (lastUserIndex < 0) {
	return { kind: "none" };
}

messages[lastUserIndex] = appendToUserMessage(messages[lastUserIndex]);
return { kind: "rewrite", messages };
