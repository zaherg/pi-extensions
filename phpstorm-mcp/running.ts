import { win32 } from "node:path";
import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Query registered GUI applications rather than leftover stdioMcpServer processes.
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

// Resolve System32 PowerShell directly so Windows never runs a powershell.exe from cwd.
export function windowsPowerShell(env: NodeJS.ProcessEnv = process.env): string {
	const root =
		[env.SystemRoot, env.windir].find(
			(dir: string | undefined) => dir !== undefined && /^[A-Za-z]:[\\/]/.test(dir),
		) ?? "C:\\Windows";
	return win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export async function isPhpStormRunning(
	pi: Pick<ExtensionAPI, "exec">,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
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
			command = windowsPowerShell(env);
			args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsQuery];
			break;
		default:
			throw queryError(`unsupported platform ${platform}`);
	}

	let result: ExecResult;
	try {
		result = await pi.exec(command, args, { timeout: 2000, maxBuffer: 1024 * 1024 });
	} catch {
		// Suppress raw child-process errors that could expose private process arguments.
		throw queryError("could not execute process query");
	}
	if (result.code !== 0 || result.killed || result.truncated) {
		throw queryError("process query failed");
	}

	if (platform === "linux") {
		return result.stdout.split("\n").some((line: string): boolean => {
			const match = /^\s*(\S+)\s+(.+)$/.exec(line);
			const name = match?.[1];
			const cmdArgs = match?.[2];
			if (!name || !cmdArgs) return false;
			if (/(?:^|[\s"'])stdioMcpServer(?:$|[\s"'])/i.test(cmdArgs)) return false;
			return (
				name === "phpstorm" ||
				name === "phpstorm64" ||
				(name === "java" && /(?:^|\s)-Didea\.platform\.prefix=PhpStorm(?:\s|$)/.test(cmdArgs))
			);
		});
	}

	const answer = result.stdout.trim().toLowerCase();
	if (answer !== "true" && answer !== "false") throw queryError("unexpected process query output");
	return answer === "true";
}
