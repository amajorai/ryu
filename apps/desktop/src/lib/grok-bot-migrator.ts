// The prompt the Grok Bot import dialog asks the user to paste into a chat
// with a bot in Grok Bot. Grok Bot has no export, so a bot there packs the
// user's bots into one zip file, and Ryu imports that file.
//
// The file names, the manifest fields and the limits below are what Core's
// archive reader (`apps/core/src/import/bot_archive/`) accepts, so change
// them together. Tests on both sides read this text. It stays in English: it
// is sent to another product, and models follow it regardless of the user's
// language.

export const GROK_BOT_MIGRATOR_PROMPT = `Pack my Grok Bot setup into one zip file so I can move it to Ryu, another assistant app. Work step by step, and do not invent anything.

## Ask me first
1. List every Bot I have, with its name and one line on what it does. Ask me which ones to pack, and wait for my answer.
2. Ask me whether to pack each Bot's own files and its conversations. Wait for my answer.

## What to collect for each Bot I chose
- Instructions: the Bot's own instructions, word for word.
- Memories: what the Bot has saved about me and my work, one fact per line, in my words where you can.
- Skills: each reusable skill the Bot has, as the text of its SKILL.md.
- Routines: the name, the schedule and the instruction of each routine.
- Files: only if I said yes. The Bot's own files from the workspace. Leave out any file over 60 MB.
- Conversations: only if I said yes, and only the ones you can read in full.

If you cannot read a part of another Bot, ask that Bot for it in a direct message. If that does not work, do not guess. Leave the part out and name it under "not_exported".

Never pack passwords, API keys, tokens, cookies, .env files or private keys, even when one is inside a file or a memory.

## Build this folder
ryu-export/
  ryu-export.json
  bots/<key>/instructions.md
  bots/<key>/memories.md
  bots/<key>/skills/<skill-name>/SKILL.md
  bots/<key>/files/<path of the file>
  bots/<key>/conversations/<name>.json

<key>, <skill-name> and <name> use only letters, digits, "-" and "_", and are at most 64 characters long. Every Bot has its own <key>. If I ask you to pack again later, use the same <key> and <name> as before, so nothing is imported twice.

memories.md holds one fact per line. Each line starts with "- ".

A conversation file is JSON in this shape:
{ "title": "Trip plan", "messages": [ { "role": "user", "text": "...", "at": "2026-01-31T09:00:00Z" }, { "role": "assistant", "text": "..." } ] }
"role" is "user" or "assistant". "at" is the time of the message and can be left out.

ryu-export.json is JSON in this shape:
{
  "format": "ryu-bot-export",
  "version": 1,
  "source": { "app": "Grok Bot", "exported_at": "<the time now, ISO 8601>" },
  "bots": [
    {
      "key": "<key>",
      "name": "<the Bot's name>",
      "description": "<one line on what it does>",
      "routines": [ { "name": "...", "schedule": "...", "instruction": "..." } ],
      "not_exported": [ "<each part you could not read>" ]
    }
  ]
}

## Finish
1. Zip what is inside the ryu-export folder, so that ryu-export.json is at the top level of the zip. Use no password, no links and no zip inside the zip. Keep the zip under 250 MB. If it would be larger, leave out the largest files and name them under "not_exported".
2. Name the zip ryu-export-<today's date>.zip and attach it to your reply, so I can download it.
3. Tell me, for each Bot, how many memories, skills, files and conversations you packed, and what you left out.`;
