import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Query registered GUI applications, not the leftover stdioMcpServer processes.
const macQuery = `
ObjC.import("AppKit");
const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.jetbrains.PhpStorm");
let running = false;
for (let i = 0; i < Number(apps.count); i++) {
	const app = apps.objectAtIndex(i);
	if (!app.terminated && Number(app.activationPolicy) === 0) running = true;
}
running;
`;

const windowsQuery = `
$ErrorActionPreference = 'Stop'
$apps = @(Get-CimInstance Win32_Process -Filter "Name = 'phpstorm64.exe' OR Name = 'phpstorm.exe'" |
	Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '(?i)(^|[\\s"''])stdioMcpServer($|[\\s"''])' })
$apps.Count -gt 0
`;

function queryError(reason: string): Error {
	return new Error(`Failed to check whether PhpStorm is running: ${reason}; MCP was not registered.`);
}

export async function isPhpStormRunning(
	pi: Pick<ExtensionAPI, "exec">,
	platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
	let command: string;
	let args: string[];
	switch (platform) {
		case "darwin":
			command = "/usr/bin/osascript";
			args = ["-l", "JavaScript", "-e", macQuery];
			break;
		case "linux":
			command = "ps";
			args = ["-Aww", "-o", "comm=", "-o", "args="];
			break;
		case "win32":
			command = "powershell.exe";
			args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsQuery];
			break;
		default:
			throw queryError(`unsupported platform ${platform}`);
	}

	let result: Awaited<ReturnType<ExtensionAPI["exec"]>>;
	try {
		result = await pi.exec(command, args, { timeout: 2000, maxBuffer: 1024 * 1024 });
	} catch {
		// Child-process exceptions can contain command output or private process arguments.
		throw queryError("could not execute process query");
	}
	if (result.code !== 0 || result.killed || result.truncated) {
		throw queryError("process query failed");
	}

	if (platform === "linux") {
		return result.stdout.split("\n").some((line) => {
			const match = /^\s*(\S+)\s+(.+)$/.exec(line);
			if (!match) return false;
			const [, name, args] = match;
			if (/(?:^|[\s"'])stdioMcpServer(?:$|[\s"'])/i.test(args)) return false;
			return name === "phpstorm" || name === "phpstorm64" || (
				name === "java" && /(?:^|\s)-Didea\.platform\.prefix=PhpStorm(?:\s|$)/.test(args)
			);
		});
	}

	const answer = result.stdout.trim().toLowerCase();
	if (answer !== "true" && answer !== "false") throw queryError("unexpected process query output");
	return answer === "true";
}
