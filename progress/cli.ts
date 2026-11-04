import { errorResult, MAX_BYTES, ProgressError, runProgress } from "./store.ts";

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === "--help") {
		process.stdout.write(
			"Usage: node cli.ts [--cwd DIRECTORY] < request.json\nActions: start, read, add_task, update_task, add_step, update_step.\nSee README.md for the shared writer protocol.\n",
		);
		return;
	}
	if (args.length !== 0 && (args.length !== 2 || args[0] !== "--cwd")) {
		throw new ProgressError(
			"INVALID_REQUEST",
			"Usage: node cli.ts [--cwd DIRECTORY] < request.json",
		);
	}
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of process.stdin) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		length += bytes.length;
		if (length > MAX_BYTES)
			throw new ProgressError(
				"INVALID_REQUEST",
				"Request exceeds the 1 MiB size limit.",
			);
		chunks.push(bytes);
	}
	let request: unknown;
	try {
		request = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
		);
	} catch {
		throw new ProgressError(
			"INVALID_REQUEST",
			"Expected one UTF-8 JSON request on stdin.",
		);
	}
	const result = await runProgress(args[1] ?? process.cwd(), request);
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
	process.stderr.write(`${JSON.stringify(errorResult(error))}\n`);
	process.exitCode = 1;
});
