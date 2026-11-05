---
name: fireboat-connect-an-agent
description: Connect fireboat as an MCP server to Claude Code, Claude Desktop, Cursor, VS Code, Codex or another MCP host, against the bundled synthetic FHIR source. Use when someone wants to try fireboat with their own agent.
---

# Connect fireboat to your agent

fireboat speaks MCP over **stdio**. A host launches it as a local process and passes it one configuration file. It serves **synthetic data only**; never point it at real patient data.

## 1. Build it and start a FHIR source

```sh
npm ci && npm run build
npm run demo:source        # synthetic FHIR R4 source on http://127.0.0.1:8080/fhir (keep it running)
npm run doctor             # checks examples/local.config.json against that source
```

`examples/local.config.json` binds the gateway to the synthetic patient `synthetic-patient-a`. To use HAPI instead, see the `fireboat-live-hapi-quickstart` skill.

## 2. Collect three absolute paths

- `NODE`: the absolute path of Node 24.22.0 (`which node`).
- `CLI`: the absolute path of `dist/packages/server/src/cli.js` in this checkout.
- `CONFIG`: the absolute path of your config, for example `examples/local.config.json`.

Hosts start servers from other working folders, so relative paths fail.

## 3. Register it with your host

**Claude Code:**

```sh
claude mcp add --transport stdio --scope local fireboat -- "$NODE" "$CLI" --config "$CONFIG"
```

**Claude Desktop or Cursor** (`mcpServers` in the app's MCP settings):

```json
{ "mcpServers": { "fireboat": { "command": "/abs/node", "args": ["/abs/dist/packages/server/src/cli.js", "--config", "/abs/config.json"] } } }
```

**VS Code** (`mcp.json`):

```json
{ "servers": { "fireboat": { "type": "stdio", "command": "/abs/node", "args": ["/abs/dist/packages/server/src/cli.js", "--config", "/abs/config.json"] } } }
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.fireboat]
command = "/abs/node"
args = ["/abs/dist/packages/server/src/cli.js", "--config", "/abs/config.json"]
```

Any other MCP host: launch `NODE CLI --config CONFIG` as a stdio server.

The HAPI quickstart can generate the Claude Desktop, Cursor, VS Code and Claude Code forms for you with `fireboat-quickstart configs`; see `docs/QUICKSTART.md`.

## 4. Try it

Restart the host, then ask the agent to:
1. call `fhir_capabilities` (topic `server`) and name the bound patient;
2. search recent laboratory Observations with `fhir_search`;
3. page with `fhir_page` and read one exact resource with `fhir_read`;
4. try to read another patient's record. fireboat must refuse.

Only Claude Code 2.1.309 has been verified end to end. Other hosts are unverified, so please report what you see as a GitHub issue: host and version, OS, Node version, and what happened.
