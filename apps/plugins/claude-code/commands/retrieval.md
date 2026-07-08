---
description: Search the user's Ryu memory and knowledge Spaces (RAG).
argument-hint: <search query>
---

Search across the user's Ryu memory and all knowledge Spaces. Query: `$ARGUMENTS`

1. If `$ARGUMENTS` is empty, ask what to search for and stop.
2. Call `ryu_search_retrieval` with `query` set to the user's text (topK 8). This runs a unified RAG search over memory plus every Space.
3. If the user wants to scope to one collection instead, call `ryu_list_spaces`, let them pick, then call `ryu_search_space` with that `spaceId`.
4. Present the hits as a short ranked list: source/Space, a one-line snippet, and score if present. Offer to open or expand any hit.

This is read-only retrieval. Do not write to Spaces or memory from this command.
