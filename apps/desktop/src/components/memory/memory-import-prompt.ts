// The prompt the import dialog asks the user to paste into another assistant.
// Its section names and `[YYYY-MM-DD] - entry` lines are what Core's pasted
// memory parser (`apps/core/src/import/pasted_memory.rs`) reads, so change
// them together. It stays in English: it is sent to another product, and
// models follow it regardless of the user's language.

export const MEMORY_IMPORT_PROMPT = `Export all of my stored memories and any context you've learned about me from past conversations. Preserve my words verbatim where possible, especially for instructions and preferences.

## Categories (output in this order):

1. **Instructions**: Rules I've explicitly asked you to follow going forward — tone, format, style, "always do X", "never do Y", and corrections to your behavior. Only include rules from stored memories, not from conversations.

2. **Identity**: Name, age, location, education, family, relationships, languages, and personal interests.

3. **Career**: Current and past roles, companies, and general skill areas.

4. **Projects**: Projects I meaningfully built or committed to. Ideally ONE entry per project. Include what it does, current status, and any key decisions. Use the project name or a short descriptor as the first words of the entry.

5. **Preferences**: Opinions, tastes, and working-style preferences that apply broadly.

## Rules:
- Only include what you actually stored or learned about me. Do not guess or invent entries. Leave a category empty if you have nothing for it.
- Never include passwords, API keys, account numbers, or other secrets.

## Format:

Start each category with a "## " header using the category name. Within each category, list one entry per line, sorted by oldest date first. Format each line as:

[YYYY-MM-DD] - Entry content here.

If no date is known, use [unknown] instead.

## Output:
- Wrap the entire export in a single code block for easy copying.
- After the code block, state whether this is the complete set or if more remain.`;
