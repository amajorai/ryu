// Context-hook body for AGENTS.md Tail.
// Injected globals: `ctx` (the outbound context) and `host` (the capability
// bridge). This file is a fragment, not an ES module; a top-level `return` is
// intentionally part of the sandbox contract.
//
// Only the latest user message is changed. The system prompt (which keeps its
// AGENTS.md head) and earlier turns are left byte-identical so the provider's
// prompt cache prefix stays warm; Core drops any `context` rewrite that edits them.

const TAIL_OPEN = "<ryu-agents-md-tail>";
const TAIL_CLOSE = "</ryu-agents-md-tail>";

const instructions =
	parsePrimitiveText(ctx?.project_instructions) !== undefined
		? ctx.project_instructions
		: "";

if (!instructions.trim()) {
	return { kind: "none" };
}

const tail = `\n\n${TAIL_OPEN}\n${instructions}\n${TAIL_CLOSE}`;

function appendToUserMessage(message) {
	if (parsePrimitiveText(message.content) !== undefined) {
		return { ...message, content: `${message.content}${tail}` };
	}
	if (Array.isArray(message.content)) {
		return {
			...message,
			content: [...message.content, { type: "text", text: tail }],
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
// this turn; Core accepts only text appended to it and forwards that suffix to
// the warm pooled session as part of the latest turn.
if (!Array.isArray(ctx?.messages)) {
	if (parsePrimitiveText(ctx?.input) === undefined || !ctx.input.trim()) {
		return { kind: "none" };
	}
	return { kind: "replace", text: `${ctx.input}${tail}` };
}

const messages = [...ctx.messages];
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

// Decode with the native String internal-slot check; boxed strings remain
// non-text inputs. This flat sandbox fragment needs no module imports.
function parsePrimitiveText(value) {
	try {
		const parsed = String.prototype.valueOf.call(value);
		return parsed === value ? parsed : undefined;
	} catch {
		return undefined;
	}
}
