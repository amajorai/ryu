# Ryu playground

This codespace runs Ryu from a published release. Nothing is compiled here.

- **Ryu Core** starts in the background each time the codespace starts. Core starts
  and manages the Gateway on loopback.
- **The Ryu web app** opens in a new browser tab once Core is ready. It is the same app
  as the desktop app, running against the Core in this codespace. You do not need a Ryu
  account: the web app talks only to this codespace's Core, as its owner.

The release binaries and the web app bundle (`ryu-webapp-playground.tar.gz`) come from
the same release, and each download is checked against its published sha256. A release
that does not publish the web app bundle opens the Ryu terminal UI instead.

Core runs with `RYU_SKIP_LOCAL_STACK_INSTALL=1`, so it does not download local engines
or models on its own: chat uses the provider key you add (see below). This applies to
Core releases after v0.4.0; v0.4.0 and earlier ignore the setting and download the local
model stack (several GB) on first start.

## Open the web app again

If the tab did not open (for example, because your browser blocked the pop-up), open the
**Ports** panel and select the globe icon on the **Ryu** row, or use the link printed in
the terminal panel. To print the link again, open a terminal (<kbd>Ctrl</kbd>+<kbd>`</kbd>)
and run:

```bash
bash .devcontainer/playground.sh web
```

## Use the terminal UI

The Ryu terminal UI is still available. In a terminal, run:

```bash
ryu-playground
```

Other commands:

```bash
bash .devcontainer/playground.sh status   # Core and web app health, PIDs, and log paths
bash .devcontainer/playground.sh start    # start Core and the web app again if they stopped
```

## How the web app reaches Core

`playground-web.py` (Python standard library only) listens on `127.0.0.1:7990`. It
serves the web app bundle and forwards Core's API, including streamed replies and
WebSocket connections, to Core on `127.0.0.1:7980`. It adds Core's token to each
forwarded request itself, so the token never reaches your browser. The token is stored
next to Core's data directory with owner-only permissions.
The server only answers requests addressed to `localhost`, `127.0.0.1`, or your codespace's
forwarding address, and refuses cross-site browser requests to Core's API.

## Add a model provider key

Chat needs a provider key. Enter it on the codespace create page (**Advanced options**
lists the optional fields), or add it as a personal
[Codespaces secret](https://docs.github.com/en/codespaces/managing-your-codespaces/managing-your-account-specific-secrets-for-github-codespaces)
(**Settings**, then **Codespaces**) with access to `amajorai/ryu`. Then rebuild or
restart the codespace.

- `OPENAI_API_KEY` works with the default chat model on its own.
- For another OpenAI-compatible provider, set all three: `RYU_DEFAULT_LLM_API_KEY`
  (your provider key), `RYU_DEFAULT_LLM_BASE_URL` (its OpenAI-compatible base URL),
  and `RYU_DEFAULT_LLM_MODEL` (a model it serves). The default chat route reads its
  key only from `RYU_DEFAULT_LLM_API_KEY` or `OPENAI_API_KEY`.

Never commit keys to the repository.

## Keep the ports private

The playground forwards two ports, both with private visibility:

- **Ryu** (7990): the web app. It opens in your browser automatically.
- **Ryu Core API** (7980): Core itself, forwarded silently.

Leave both private. GitHub signs you in before a private port reaches the codespace,
and every request through either port acts as the owner of this Core. A public port
would hand your node to anyone with the link. The playground does not auto-forward any
other port, including the Gateway's.

## Quota

The codespace runs on your own GitHub Codespaces quota. Stop it when you are done
(**Codespaces** menu, then **Stop Current Codespace**), or delete it from
[github.com/codespaces](https://github.com/codespaces) to free its storage.

## More

- Install Ryu on your own machine or server:
  [self-hosting guide](https://docs.ryuhq.com/docs/start-here/getting-started/self-host)
- Pin a release for this codespace: set `RYU_PLAYGROUND_VERSION` (for example
  `v0.4.0`) on the create page or as a personal Codespaces secret before creating it.
