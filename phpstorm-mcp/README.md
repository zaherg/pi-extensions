# PhpStorm MCP for Pi RPC sessions

A Pi extension that registers PhpStorm's Model Context Protocol (MCP) server only in RPC sessions while PhpStorm is running locally, including sessions launched through `pi-acp` in JetBrains.

## Why this extension exists

The goal is to use PhpStorm's MCP tools through the existing JetBrains `pi-acp` registry agent without connecting ordinary Pi terminal sessions to the IDE.
Adding PhpStorm to Pi's global `~/.pi/agent/mcp.json` would make it available beyond those IDE sessions, including sessions where PhpStorm is not running or needed.

This extension makes registration conditional on Pi's session mode and a running PhpStorm application.
It keeps the existing ACP agent setup and does not require a custom launcher or another JetBrains agent entry.
It is not an ACP adapter or an MCP server itself; Pi's built-in MCP support handles the connection and exposes the IDE's tools.

## What it does

At `session_start`, the extension checks `ctx.mode`:

- In RPC mode, it checks whether PhpStorm is running locally before reading (or creating) `~/.pi/agent/pi-phpstorm-mcp.json` and registering the server as `phpstorm`.
- If PhpStorm is closed, it silently skips configuration loading and registration.
- In terminal UI, print, and JSON modes, it does not inspect applications, read or create the configuration, or register the server.

Loading the extension for discovery alone does not register a server.
Registration lasts for the current session and does not modify Pi's global `mcp.json`.

The check applies to all RPC clients, not just JetBrains.
It does not detect which client launched Pi, so another ACP/RPC client can still connect while PhpStorm is open.
It checks at session startup only, without polling or launching PhpStorm.
After opening PhpStorm, restart the ACP/RPC session to enable the connection.
Closing PhpStorm after registration does not unregister the server; Pi handles the disconnected connection.

On macOS, detection uses the running GUI application's `com.jetbrains.PhpStorm` bundle identifier, excluding background stdio bridges.
On Linux, it checks native `phpstorm`/`phpstorm64` processes or a Java process with `-Didea.platform.prefix=PhpStorm`.
On Windows, it checks `phpstorm.exe`/`phpstorm64.exe` through PowerShell's process query, running `powershell.exe` by its absolute `%SystemRoot%\System32` path.
Linux and Windows checks exclude processes whose arguments contain `stdioMcpServer`.
Process queries have a two-second timeout and a 1 MiB output limit; query failures and unsupported platforms report an error without registering the server.
This is an application-presence check, not an MCP health check: disabled MCP support, incorrect connection settings, or the IDE exiting after the check can still cause connection failures.

## Requirements

- Pi 1.0.2 or later with its built-in MCP support enabled.
- Node.js 22.19 or later.
- PhpStorm with its MCP server enabled and running when you use the connection.
- An existing `pi-acp` agent setup for use inside JetBrains.

No additional npm dependencies or build step are needed at runtime.

## Installation

Install the `@zaherg/pi-extensions` package directly from GitHub:

```sh
pi install git:github.com/zaherg/pi-extensions
```

Pi manages the Git checkout and records the package in `~/.pi/agent/settings.json`.
You do not need to clone the repository manually; run `pi config` if you want to toggle individual extensions in the bundle.
Configure `~/.pi/agent/pi-phpstorm-mcp.json` if the defaults below do not match your installation, then restart the existing Pi ACP session.

Remove the Git-installed package with:

```sh
pi remove git:github.com/zaherg/pi-extensions
```

For local single-extension development, clone the repository and load it directly with `pi -e ./phpstorm-mcp/index.ts` (or run `pi install "$PWD"` from the repository root and remove it with `pi remove "$PWD"`).
Keep a local checkout in place because Pi loads local packages from their original paths.

## Server configuration

The extension reads `~/.pi/agent/pi-phpstorm-mcp.json` at the start of each RPC session when PhpStorm is running and registers it as `phpstorm`.
The file contains one MCP server configuration object, without an `mcpServers` wrapper.
If the file does not exist yet, the extension creates it atomically (with `0600` permissions) using the current user's home directory and JetBrains Toolbox's standard macOS path:

```json
{
  "type": "stdio",
  "env": {
    "IJ_MCP_SERVER_PORT": "64442"
  },
  "command": "<HOME>/Applications/PhpStorm.app/Contents/MacOS/phpstorm",
  "args": [
    "stdioMcpServer"
  ]
}
```

If PhpStorm is installed elsewhere (for example `/Applications/PhpStorm.app/...` or on Linux/Windows) or uses a different MCP port, edit `~/.pi/agent/pi-phpstorm-mcp.json` with the executable path, arguments, and port supplied by PhpStorm's MCP settings, then restart the Pi ACP session.
An existing file replaces the defaults completely rather than merging with them.
Unreadable files and malformed JSON report an error with the file path without overwriting the file.
Pi validates the server configuration and rejects invalid settings.

Do not also add `phpstorm` to `~/.pi/agent/mcp.json` or the project's `.pi/mcp.json` if it should remain RPC-only.
A file-configured server named `phpstorm` takes precedence over the extension's registration and bypasses both the mode and running-application checks.
The extension does not disable or remove independently configured servers.

## Verification

Run static typechecking and linting from the repository root with Node.js 22.19 or later:

```sh
npm run check
```

To verify runtime behavior, launch an RPC session with `pi -e ./phpstorm-mcp/index.ts --mode rpc` while PhpStorm is running or closed and confirm `phpstorm` registers only in RPC mode when PhpStorm is open.
Native Linux and Windows detection has not been runtime-tested.
