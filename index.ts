import { realpath, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { generateUnifiedPatch, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const BASELINE_KEY = "piReadDeltaBaseline";
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2_000;

interface Baseline {
	path: string;
	offset?: number;
	limit?: number;
	content: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPositiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}

async function resolvePath(path: string, cwd: string): Promise<string> {
	return realpath(resolve(cwd, expandHome(path)));
}

function selectRange(content: string, offset?: number, limit?: number): string {
	const lines = content.split("\n");
	const start = offset ? Math.max(0, offset - 1) : 0;
	if (start >= lines.length) {
		throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total)`);
	}

	const end = limit === undefined ? lines.length : Math.min(start + limit, lines.length);
	return lines.slice(start, end).join("\n");
}

async function readRange(path: string, offset?: number, limit?: number): Promise<string> {
	return selectRange((await readFile(path)).toString("utf-8"), offset, limit);
}

function textFromReadResult(
	content: Array<{ type: string; text?: string }>,
	selectedContent: string,
	limit?: number,
): string | undefined {
	const text = content.find((block) => block.type === "text")?.text;
	if (text === undefined) return undefined;
	if (text === selectedContent) return text;
	if (limit === undefined || !text.startsWith(selectedContent)) return undefined;

	const suffix = text.slice(selectedContent.length);
	return /^\n\n\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/.test(suffix)
		? selectedContent
		: undefined;
}

function rangeDescription(offset?: number, limit?: number): string {
	if (offset === undefined && limit === undefined) return "the whole file";
	const start = offset ?? 1;
	return limit === undefined ? `from line ${start}` : `${limit} lines from line ${start}`;
}

function getBaseline(details: unknown): Baseline | undefined {
	if (!isRecord(details) || !isRecord(details[BASELINE_KEY])) return undefined;

	const baseline = details[BASELINE_KEY];
	if (typeof baseline.path !== "string" || typeof baseline.content !== "string") return undefined;

	const offset = getPositiveInteger(baseline.offset);
	const limit = getPositiveInteger(baseline.limit);
	if ((baseline.offset !== undefined && offset === undefined) || (baseline.limit !== undefined && limit === undefined)) {
		return undefined;
	}

	return { path: baseline.path, content: baseline.content, offset, limit };
}

function findLatestBaseline(path: string, ctx: ExtensionToolContext): Baseline | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "read") {
			continue;
		}

		const baseline = getBaseline(entry.message.details);
		if (baseline?.path === path) return baseline;
	}

	return undefined;
}

function offsetPatchHunks(diff: string, offset?: number): string {
	const lineOffset = offset ? Math.max(0, offset - 1) : 0;
	if (lineOffset === 0) return diff;

	return diff.replace(
		/^@@ -(\d+)(,\d+)? \+(\d+)(,\d+)? @@/gm,
		(_match, oldStart, oldLength = "", newStart, newLength = "") =>
			`@@ -${Number(oldStart) + lineOffset}${oldLength} +${Number(newStart) + lineOffset}${newLength} @@`,
	);
}

function exceedsOutputLimit(content: string): boolean {
	return Buffer.byteLength(content, "utf-8") > MAX_OUTPUT_BYTES || content.split("\n").length > MAX_OUTPUT_LINES;
}

export default function readDeltaExtension(pi: ExtensionAPI) {
	pi.on("tool_result", async (event, ctx) => {
		if (
			event.toolName !== "read" ||
			event.parentToolCallId !== undefined ||
			event.isError ||
			event.content.some((block) => block.type === "image") ||
			(isRecord(event.details) && "truncation" in event.details)
		) {
			return;
		}

		const path = event.input.path;
		if (typeof path !== "string") return;

		try {
			const resolvedPath = await resolvePath(path, ctx.cwd);
			const offset = getPositiveInteger(event.input.offset);
			const limit = getPositiveInteger(event.input.limit);
			if ((event.input.offset !== undefined && offset === undefined) || (event.input.limit !== undefined && limit === undefined)) {
				return;
			}

			const selectedContent = await readRange(resolvedPath, offset, limit);
			const content = textFromReadResult(event.content, selectedContent, limit);
			if (content === undefined) return;

			return {
				details: {
					...(isRecord(event.details) ? event.details : {}),
					[BASELINE_KEY]: { path: resolvedPath, offset, limit, content } satisfies Baseline,
				},
			};
		} catch {
			// Preserve the built-in read result when its snapshot cannot be captured.
			return;
		}
	});

	pi.registerTool({
		name: "read_delta",
		label: "read delta",
		description:
			"Compare a text file with the latest successful read of the same path on the active conversation branch. Call read first. This tool accepts only path and automatically reuses that read's offset and limit, so the diff always covers the same range and uses original-file line numbers. Offset- or limit-based reads are supported; reads cut by Pi's output cap and images are not.",
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file to compare, relative or absolute" }),
		}),
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		async execute(_toolCallId, { path }, _signal, _onUpdate, ctx) {
			let resolvedPath: string;
			try {
				resolvedPath = await resolvePath(path, ctx.cwd);
			} catch (error) {
				return {
					content: [{ type: "text", text: `Could not resolve ${path}: ${String(error)}` }],
					details: undefined,
					isError: true,
				};
			}

			const baseline = findLatestBaseline(resolvedPath, ctx);
			if (!baseline) {
				return {
					content: [
						{
							type: "text",
							text: `No comparable read baseline exists for ${path}. Call read first and ensure its text output is not truncated.`,
						},
					],
					details: { path: resolvedPath },
					isError: true,
				};
			}

			let current: string;
			try {
				current = await readRange(resolvedPath, baseline.offset, baseline.limit);
			} catch (error) {
				return {
					content: [{ type: "text", text: `Could not read ${path}: ${String(error)}` }],
					details: { path: resolvedPath, offset: baseline.offset, limit: baseline.limit },
					isError: true,
				};
			}

			if (current === baseline.content) {
				return {
					content: [{ type: "text", text: `No changes in ${path} for ${rangeDescription(baseline.offset, baseline.limit)} since its latest read.` }],
					details: { path: resolvedPath, offset: baseline.offset, limit: baseline.limit, changed: false },
				};
			}

			const diff = offsetPatchHunks(generateUnifiedPatch(path, baseline.content, current), baseline.offset);
			if (exceedsOutputLimit(diff)) {
				return {
					content: [
						{
							type: "text",
							text: `Changes in ${path} for ${rangeDescription(baseline.offset, baseline.limit)} exceed the ${MAX_OUTPUT_LINES}-line or 50 KiB delta limit. Use read for that range.`,
						},
					],
					details: { path: resolvedPath, offset: baseline.offset, limit: baseline.limit, changed: true },
					isError: true,
				};
			}

			return {
				content: [{ type: "text", text: diff }],
				details: { path: resolvedPath, offset: baseline.offset, limit: baseline.limit, changed: true },
			};
		},
	});
}
