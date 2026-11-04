# PhpStorm MCP for Pi RPC sessions

A Pi extension that registers PhpStorm's Model Context Protocol (MCP) server only in RPC sessions, including those launched through `pi-acp` in JetBrains.

## Why this extension exists

The goal is to use PhpStorm's MCP tools through the existing JetBrains `pi-acp` registry agent without connecting ordinary Pi terminal sessions to the IDE.
Adding PhpStorm to Pi's global `~/.pi/agent/mcp.json` would make it available beyond those IDE sessions, including sessions where PhpStorm is not running or needed.

This extension makes registration conditional on Pi's session mode.
It keeps the existing ACP agent setup and does not require a custom launcher or another JetBrains agent entry.
It is not an ACP adapter or an MCP server itself; Pi's built-in MCP support handles the connection and exposes the IDE's tools.

## What it does

At `session_start`, the extension checks `ctx.mode`:

- In RPC mode, it reads the optional JSON configuration and registers the server as `phpstorm`.
- In terminal UI, print, and JSON modes, it does not read the configuration or register the server.

Loading the extension for discovery alone does not register a server.
Registration lasts for the current session and does not modify Pi's MCP configuration files.

The check applies to all RPC clients, not just JetBrains.
It does not detect which client launched Pi or whether PhpStorm is running.
Another RPC client can therefore attempt the same connection and report a failure if the IDE is unavailable.

## Requirements

- Pi 1.0.2 or later with its built-in MCP support enabled.
- Node.js 22.19 or later.
- PhpStorm with its MCP server enabled and running when you use the connection.
- An existing `pi-acp` agent setup for use inside JetBrains.

No additional npm dependencies or build step are needed at runtime.

## Installation

Install directly from GitHub:

```sh
pi install git:github.com/zaherg/pi-phpstorm-mcp
```

Pi manages the Git checkout and records the package in `~/.pi/agent/settings.json`.
You do not need to clone the repository manually.
Configure the server if the defaults do not match your installation, then restart the existing Pi ACP session.

Remove the Git-installed package with:

```sh
pi remove git:github.com/zaherg/pi-phpstorm-mcp
```

For local development, clone the repository and run `pi install "$PWD"` from its directory instead.
Keep that checkout in place because Pi loads local packages from their original paths.
Use `pi remove "$PWD"` from the same directory to remove a local installation.

## Server configuration

The extension reads `~/.pi/agent/pi-phpstorm-mcp.json` at the start of each RPC session and registers it as `phpstorm`.
The file contains one MCP server configuration object, without an `mcpServers` wrapper.
If the file does not exist, the extension uses these defaults:

```json
{
  "type": "stdio",
  "env": {
    "IJ_MCP_SERVER_PORT": "64442"
  },
  "command": "/Users/zaher/Applications/PhpStorm.app/Contents/MacOS/phpstorm",
  "args": ["stdioMcpServer"]
}
```

These defaults are specific to the original macOS installation, including the username, application location, and MCP port.
For another installation, use the executable path, arguments, and port supplied by PhpStorm's MCP settings.
To change the settings, create `~/.pi/agent/pi-phpstorm-mcp.json` with the JSON object shown here and edit its values.
An existing file replaces the defaults rather than merging with them.
Restart the Pi ACP session after changing the file.
The extension does not create the file automatically.
Unreadable files and malformed JSON report an error with the file path; they do not fall back to defaults.
Pi validates the server configuration and rejects invalid settings.

Do not also add `phpstorm` to `~/.pi/agent/mcp.json` or the project's `.pi/mcp.json` if it should remain RPC-only.
A file-configured server named `phpstorm` takes precedence over the extension's registration and is not controlled by its mode check.
The extension does not disable or remove independently configured servers.

## Verification

Run the dependency-free tests with Node.js 22.19 or later:

```sh
npm test
```

Tests cover JSON configuration, missing-file defaults, configuration changes between sessions, and file errors.
They also exercise the extension's registration boundary for RPC, TUI, print, and JSON sessions, and verify that discovery alone does not register a server.
They do not launch PhpStorm or verify a live IDE connection.
