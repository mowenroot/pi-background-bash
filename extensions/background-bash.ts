import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentToolUpdateCallback, BashToolDetails, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";
import { createPiPending } from "pi-pending";
import { formatTruncationNotice, piContext, truncateContextText } from "./pi-context-utils.ts";
import { Type } from "typebox";

const MAX_ACTIVE_JOBS = 10;
const MAX_RESULT_LINES = 2000;
const MAX_RESULT_BYTES = 50 * 1024;
const DEFAULT_AUTO_BACKGROUND_AFTER_SECONDS = 30;
const CUSTOM_TYPE = "background_bash_result";

type Outcome = "running" | "exit" | "timeout" | "abort" | "error";

type BackgroundBashDetails = BashToolDetails & {
	jobId: string;
	command: string;
	outcome: Outcome;
	exitCode: number | null;
	toolCallId?: string;
	startedAt?: string;
	durationMs?: number;
	body?: string;
	cwd?: string;
	sessionId?: string;
	sessionKey?: string;
	instanceId?: string;
	lane?: string;
	globalJobId?: string;
	pbbCursor?: number;
};

type BashParams = {
	command: string;
	timeout?: number;
	background?: boolean;
};

type CompletedBashRun =
	| {
			status: "success";
			result: AgentToolResult<BashToolDetails>;
			body: string;
			details: BashToolDetails | undefined;
			outcome: "exit";
			exitCode: 0;
	  }
	| {
			status: "error";
			error: unknown;
			body: string;
			details: BashToolDetails | undefined;
			outcome: Outcome;
			exitCode: number | null;
	  };

type PbbIdentity = {
	sessionId?: string;
	sessionKey: string;
	sessionFile?: string;
	instanceId: string;
	lane?: string;
	laneRoot?: string;
	root: string;
};

type RepairableSessionManager = {
	getEntries?: () => unknown[];
	getSessionFile?: () => string | undefined;
};

type RepairableSessionContext = {
	sessionManager?: RepairableSessionManager;
	isIdle?: () => boolean;
};

type ActiveJob = {
	id: string;
	command: string;
	toolCallId: string;
	abortController: AbortController;
	startedAt: number;
	cwd?: string;
	pbb?: PbbIdentity;
	lastLoggedBody?: string;
	lastEventId?: number;
	child?: ChildProcess;
	pid?: number;
	pgid?: number;
	runner?: "pbb";
	killSignal?: NodeJS.Signals;
	repairContext?: RepairableSessionContext;
};

type BackgroundBashConfig = {
	autoBackgroundAfterSeconds?: number;
};

const schema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	background: Type.Optional(Type.Boolean({ description: "Run immediately in the background and return a job id" })),
});

const JOB_ID_PREFIX = "bg";
const JOB_ID_WIDTH = 3;

const activeJobs = new Map<string, ActiveJob>();
const pendingJobs = createPiPending({
	namespace: "background-bash",
	format: (job) => `$ ${normalizeCommandForStatus(job.text)}`,
});
let nextJobNumber = 1;
let shuttingDown = false;
let processHooksInstalled = false;
let killRequestTimer: ReturnType<typeof setInterval> | undefined;

function normalizeCommandForStatus(command: string): string {
	return command.replace(/\s+/g, " ").trim();
}

function formatJobId(n: number): string {
	return `${JOB_ID_PREFIX}${String(n).padStart(JOB_ID_WIDTH, "0")}`;
}

function parseJobNumber(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const match = value.match(/^bg(\d{3,})$/);
	return match ? Number(match[1]) : undefined;
}

function normalizeSignal(value: unknown): NodeJS.Signals {
	const raw = String(value || "TERM").toUpperCase().replace(/^SIG/, "");
	if (["TERM", "INT", "KILL", "HUP", "QUIT"].includes(raw)) return `SIG${raw}` as NodeJS.Signals;
	return "SIGTERM";
}

function getText(result: AgentToolResult<unknown>): string {
	return result.content
		.map((part) => {
			if (part?.type === "text" && typeof part.text === "string") return part.text;
			try {
				return JSON.stringify(part);
			} catch {
				return String(part);
			}
		})
		.join("\n");
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function readConfigFile(path: string): BackgroundBashConfig {
	try {
		if (!existsSync(path)) return {};
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object") return {};
		const raw = (parsed as { autoBackgroundAfterSeconds?: unknown }).autoBackgroundAfterSeconds;
		return typeof raw === "number" && Number.isFinite(raw) ? { autoBackgroundAfterSeconds: raw } : {};
	} catch {
		return {};
	}
}

function getAutoBackgroundAfterSeconds(cwd?: string): number {
	const globalConfig = readConfigFile(join(homedir(), ".pi-background-bash", "config.json"));
	const projectConfig = cwd ? readConfigFile(join(cwd, ".pi", "background-bash.json")) : {};
	return projectConfig.autoBackgroundAfterSeconds ?? globalConfig.autoBackgroundAfterSeconds ?? DEFAULT_AUTO_BACKGROUND_AFTER_SECONDS;
}

function formatThreshold(seconds: number): string {
	return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
	if (!pid) return;
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Best effort: process may have already exited.
		}
	}
}

function stableSessionKey(sessionFile: string, sessionId?: string): string {
	return createHash("sha256").update(`${sessionId ?? "no-session-id"}\n${sessionFile}`).digest("hex").slice(0, 24);
}

const fallbackInstanceId = `pbb_${process.pid}_${randomUUID().slice(0, 8)}`;

function pbbIdentity(ctx: { sessionManager?: { getSessionId?: () => string | undefined; getSessionFile?: () => string | undefined } }): PbbIdentity | undefined {
	const sessionFile = process.env.PI_LANE_SESSION_FILE || ctx.sessionManager?.getSessionFile?.();
	const sessionId = process.env.PI_LANE_SESSION_ID || ctx.sessionManager?.getSessionId?.();
	const sessionKey = process.env.PI_LANE_SESSION_KEY || (sessionFile ? stableSessionKey(sessionFile, sessionId) : undefined);
	if (!sessionKey) return undefined;
	return {
		sessionId,
		sessionKey,
		sessionFile,
		instanceId: process.env.PI_LANE_INSTANCE_ID || fallbackInstanceId,
		lane: process.env.PI_LANE_CURRENT_LANE,
		laneRoot: process.env.PI_LANE_ROOT,
		root: process.env.PBB_ROOT || join(homedir(), ".pi", "pbb"),
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function entryParentId(entry: unknown): string | null | undefined {
	const record = asRecord(entry);
	const parentId = record?.parentId;
	return typeof parentId === "string" || parentId === null ? parentId : undefined;
}

function entryId(entry: unknown): string | undefined {
	const id = asRecord(entry)?.id;
	return typeof id === "string" ? id : undefined;
}

function entryHasToolCall(entry: unknown, toolCallId: string): boolean {
	const record = asRecord(entry);
	if (record?.type !== "message") return false;
	const message = asRecord(record.message);
	if (message?.role !== "assistant") return false;
	const content = Array.isArray(message.content) ? message.content : [];
	return content.some((part) => {
		const item = asRecord(part);
		return item?.type === "toolCall" && item.name === "bash" && item.id === toolCallId;
	});
}

function backgroundToolResultCallId(entry: unknown): string | undefined {
	const record = asRecord(entry);
	if (record?.type !== "message") return undefined;
	const message = asRecord(record.message);
	if (message?.role !== "toolResult" || message.toolName !== "bash") return undefined;
	const details = asRecord(message.details);
	if (typeof details?.jobId !== "string") return undefined;
	const detailToolCallId = details.toolCallId;
	if (typeof detailToolCallId === "string") return detailToolCallId;
	return typeof message.toolCallId === "string" ? message.toolCallId : undefined;
}

function parentChainHasToolCall(entry: unknown, byId: Map<string, unknown>, toolCallId: string): boolean {
	const seen = new Set<string>();
	let parentId = entryParentId(entry);
	while (parentId) {
		if (seen.has(parentId)) return false;
		seen.add(parentId);
		const parent = byId.get(parentId);
		if (!parent) return false;
		if (entryHasToolCall(parent, toolCallId)) return true;
		parentId = entryParentId(parent);
	}
	return false;
}

function findAssistantToolCallParent(entries: unknown[], beforeIndex: number, toolCallId: string): string | undefined {
	for (let i = beforeIndex - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entryHasToolCall(entry, toolCallId)) return entryId(entry);
	}
	return undefined;
}

function collectDetachedBackgroundToolResultRepairs(entries: unknown[], onlyToolCallId?: string): Map<string, string> {
	const byId = new Map<string, unknown>();
	for (const entry of entries) {
		const id = entryId(entry);
		if (id) byId.set(id, entry);
	}

	const repairs = new Map<string, string>();
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const id = entryId(entry);
		const toolCallId = backgroundToolResultCallId(entry);
		if (!id || !toolCallId || (onlyToolCallId && toolCallId !== onlyToolCallId)) continue;
		if (parentChainHasToolCall(entry, byId, toolCallId)) continue;
		const parentId = findAssistantToolCallParent(entries, i, toolCallId);
		if (parentId) repairs.set(id, parentId);
	}
	return repairs;
}

function rewriteSessionParentIds(sessionFile: string | undefined, repairs: Map<string, string>): void {
	if (!sessionFile || repairs.size === 0 || !existsSync(sessionFile)) return;
	try {
		const lines = readFileSync(sessionFile, "utf8").split("\n");
		let changed = false;
		const next = lines.map((line) => {
			if (!line.trim()) return line;
			try {
				const entry = JSON.parse(line) as Record<string, unknown>;
				const id = typeof entry.id === "string" ? entry.id : undefined;
				const parentId = id ? repairs.get(id) : undefined;
				if (!parentId || entry.parentId === parentId) return line;
				entry.parentId = parentId;
				changed = true;
				return JSON.stringify(entry);
			} catch {
				return line;
			}
		});
		if (!changed) return;
		const tmp = `${sessionFile}.${process.pid}.${Date.now()}.repair.tmp`;
		writeFileSync(tmp, next.join("\n"));
		renameSync(tmp, sessionFile);
	} catch {
		// Best effort. The in-memory repair still protects the active request.
	}
}

function repairDetachedBackgroundToolResults(ctx: RepairableSessionContext | undefined, onlyToolCallId?: string, options: { rewriteFile?: boolean } = {}): number {
	const sessionManager = ctx?.sessionManager;
	const entries = sessionManager?.getEntries?.();
	if (!entries?.length) return 0;
	const repairs = collectDetachedBackgroundToolResultRepairs(entries, onlyToolCallId);
	for (const entry of entries) {
		const id = entryId(entry);
		const parentId = id ? repairs.get(id) : undefined;
		if (parentId) (entry as { parentId?: string }).parentId = parentId;
	}
	if (options.rewriteFile !== false) rewriteSessionParentIds(sessionManager?.getSessionFile?.(), repairs);
	return repairs.size;
}

function scheduleDetachedBackgroundToolResultRepair(ctx: RepairableSessionContext, toolCallId: string): void {
	for (const delayMs of [25, 250, 1000]) {
		const handle = setTimeout(() => {
			repairDetachedBackgroundToolResults(ctx, toolCallId, { rewriteFile: ctx.isIdle?.() === true });
		}, delayMs);
		handle.unref?.();
	}
}

function pbbSessionDir(id: PbbIdentity): string {
	return join(id.root, "sessions", id.sessionKey);
}

function pbbInstanceDir(id: PbbIdentity): string {
	return join(pbbSessionDir(id), "instances", id.instanceId);
}

function exportPbbEnv(id: PbbIdentity): void {
	process.env.PBB_SESSION_KEY = id.sessionKey;
	process.env.PBB_INSTANCE_ID = id.instanceId;
	process.env.PBB_ROOT = id.root;
	if (id.sessionId) process.env.PBB_SESSION_ID = id.sessionId;
	if (id.sessionFile) process.env.PBB_SESSION_FILE = id.sessionFile;
	if (id.lane) process.env.PBB_LANE = id.lane;
}

function pbbJobsDir(id: PbbIdentity): string {
	return join(pbbInstanceDir(id), "jobs");
}

function pbbLogsDir(id: PbbIdentity): string {
	return join(pbbInstanceDir(id), "logs");
}

function pbbRequestsDir(id: PbbIdentity): string {
	return join(pbbInstanceDir(id), "requests");
}

function writeJsonFile(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(tmp, path);
}

function readPbbSeq(id: PbbIdentity): number {
	try {
		return Number(readFileSync(join(pbbInstanceDir(id), "seq"), "utf8")) || 0;
	} catch {
		return 0;
	}
}

function nextPbbEventId(id: PbbIdentity): number {
	const next = readPbbSeq(id) + 1;
	writeJsonFile(join(pbbInstanceDir(id), "identity.json"), {
		schemaVersion: 1,
		sessionId: id.sessionId,
		sessionKey: id.sessionKey,
		sessionFile: id.sessionFile,
		instanceId: id.instanceId,
		lane: id.lane,
		laneRoot: id.laneRoot,
		root: id.root,
		pid: process.pid,
		updatedAt: new Date().toISOString(),
	});
	mkdirSync(pbbInstanceDir(id), { recursive: true });
	writeFileSync(join(pbbInstanceDir(id), "seq"), String(next));
	return next;
}

function appendPbbEvent(job: ActiveJob, type: string, data: Record<string, unknown> = {}): number | undefined {
	if (!job.pbb) return undefined;
	const eventId = nextPbbEventId(job.pbb);
	job.lastEventId = eventId;
	mkdirSync(pbbInstanceDir(job.pbb), { recursive: true });
	appendFileSync(join(pbbInstanceDir(job.pbb), "events.jsonl"), `${JSON.stringify({
		schemaVersion: 1,
		eventId,
		type,
		at: new Date().toISOString(),
		sessionId: job.pbb.sessionId,
		sessionKey: job.pbb.sessionKey,
		instanceId: job.pbb.instanceId,
		lane: job.pbb.lane,
		jobId: job.id,
		globalJobId: `${job.pbb.instanceId}:${job.id}`,
		...data,
	})}\n`);
	return eventId;
}

function writePbbJob(job: ActiveJob, patch: Record<string, unknown> = {}): void {
	if (!job.pbb) return;
	mkdirSync(pbbJobsDir(job.pbb), { recursive: true });
	mkdirSync(pbbLogsDir(job.pbb), { recursive: true });
	writeJsonFile(join(pbbJobsDir(job.pbb), `${job.id}.json`), {
		schemaVersion: 1,
		jobId: job.id,
		globalJobId: `${job.pbb.instanceId}:${job.id}`,
		command: job.command,
		toolCallId: job.toolCallId,
		cwd: patch.cwd ?? job.cwd,
		status: "running",
		outcome: "running",
		exitCode: null,
		startedAt: new Date(job.startedAt).toISOString(),
		updatedAt: new Date().toISOString(),
		sessionId: job.pbb.sessionId,
		sessionKey: job.pbb.sessionKey,
		sessionFile: job.pbb.sessionFile,
		instanceId: job.pbb.instanceId,
		lane: job.pbb.lane,
		laneRoot: job.pbb.laneRoot,
		pid: job.pid ?? process.pid,
		pgid: job.pgid,
		runner: job.runner,
		killSignal: job.killSignal,
		logPath: join(pbbLogsDir(job.pbb), `${job.id}.log`),
		lastEventId: job.lastEventId,
		...patch,
	});
}

function recordPbbJobStarted(job: ActiveJob, cwd: string): void {
	if (!job.pbb) return;
	job.cwd = cwd;
	mkdirSync(pbbLogsDir(job.pbb), { recursive: true });
	writeFileSync(join(pbbLogsDir(job.pbb), `${job.id}.log`), "");
	job.lastLoggedBody = undefined;
	appendPbbEvent(job, "job.started", { command: job.command, cwd });
	writePbbJob(job, { cwd, status: "running", outcome: "running" });
}

function appendPbbLogDelta(job: ActiveJob, body: string): void {
	if (!job.pbb || !body || body === job.lastLoggedBody) return;
	if (job.lastLoggedBody && body.trimEnd() === job.lastLoggedBody.trimEnd()) {
		job.lastLoggedBody = body;
		return;
	}
	let delta = body;
	if (job.lastLoggedBody && body.startsWith(job.lastLoggedBody)) {
		delta = body.slice(job.lastLoggedBody.length);
	} else if (job.lastLoggedBody) {
		delta = `\n[pbb: output snapshot replaced]\n${body}`;
	}
	job.lastLoggedBody = body;
	if (!delta) return;
	mkdirSync(pbbLogsDir(job.pbb), { recursive: true });
	appendFileSync(join(pbbLogsDir(job.pbb), `${job.id}.log`), delta);
	appendPbbEvent(job, "job.output", { bytes: Buffer.byteLength(delta) });
	writePbbJob(job, { status: "running", outcome: "running", updatedAt: new Date().toISOString() });
}

function recordPbbJobCompleted(job: ActiveJob, completed: CompletedBashRun, cwd: string, durationMs: number): void {
	if (!job.pbb) return;
	appendPbbLogDelta(job, completed.body);
	appendPbbEvent(job, "job.completed", { outcome: completed.outcome, exitCode: completed.exitCode, durationMs });
	writePbbJob(job, {
		cwd,
		status: completed.outcome === "exit" ? "exited" : completed.outcome,
		outcome: completed.outcome,
		exitCode: completed.exitCode,
		completedAt: new Date().toISOString(),
		durationMs,
		lastEventId: job.lastEventId,
	});
}

function handlePbbKillRequests(): void {
	for (const job of activeJobs.values()) {
		if (!job.pbb) continue;
		const dir = pbbRequestsDir(job.pbb);
		if (!existsSync(dir)) continue;
		for (const item of readdirSync(dir)) {
			if (!item.endsWith(".json")) continue;
			const path = join(dir, item);
			let request: Record<string, unknown> | undefined;
			try {
				request = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			} catch {
				rmSync(path, { force: true });
				continue;
			}
			if (request.type !== "kill" || request.jobId !== job.id) continue;
			job.killSignal = normalizeSignal(request.signal);
			appendPbbEvent(job, "job.kill_requested", { requestId: request.requestId, signal: job.killSignal });
			writePbbJob(job, { status: "kill_requested", killRequestedAt: new Date().toISOString(), killSignal: job.killSignal, lastEventId: job.lastEventId });
			job.abortController.abort();
			rmSync(path, { force: true });
		}
	}
}

function waitForBackgroundThreshold(seconds: number): Promise<"background"> {
	return new Promise((resolve) => {
		const handle = setTimeout(() => resolve("background"), seconds * 1000);
		handle.unref?.();
	});
}

function rethrowBashError(completed: Extract<CompletedBashRun, { status: "error" }>, job?: ActiveJob): never {
	const body = truncateForegroundBody(job, completed.body);
	throw new Error(body || (completed.error instanceof Error ? completed.error.message : String(completed.error)));
}

function completionBody(output: string, suffix: string): string {
	return output ? `${output.replace(/\s*$/, "")}\n\n${suffix}` : suffix;
}

async function runPbbBash(
	job: ActiveJob,
	cwd: string,
	params: BashParams,
	onUpdate?: AgentToolUpdateCallback<BashToolDetails>,
): Promise<CompletedBashRun> {
	job.runner = "pbb";
	return new Promise((resolve) => {
		let output = "";
		let settled = false;
		let timedOut = false;
		let aborted = false;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

		const finish = (completed: CompletedBashRun) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			resolve(completed);
		};

		const child = spawn("bash", ["-lc", params.command], {
			cwd,
			env: process.env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		job.child = child;
		job.pid = child.pid;
		job.pgid = child.pid;
		writePbbJob(job, { pid: child.pid, pgid: child.pid, runner: "pbb" });

		const append = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			const text = truncateLiveBody(output.replace(/\s*$/, ""));
			onUpdate?.({ content: text ? [{ type: "text", text }] : [], details: {} as BashToolDetails });
			appendPbbLogDelta(job, output);
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);

		const abort = () => {
			aborted = true;
			killProcessGroup(child.pid, job.killSignal ?? "SIGTERM");
			setTimeout(() => {
				if (!settled && job.killSignal !== "SIGKILL") killProcessGroup(child.pid, "SIGKILL");
			}, 500).unref?.();
		};
		if (job.abortController.signal.aborted) abort();
		else job.abortController.signal.addEventListener("abort", abort, { once: true });

		if (params.timeout && params.timeout > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				killProcessGroup(child.pid, "SIGTERM");
				setTimeout(() => {
					if (!settled) killProcessGroup(child.pid, "SIGKILL");
				}, 500).unref?.();
			}, params.timeout * 1000);
			timeoutHandle.unref?.();
		}

		child.on("error", (error) => {
			finish({ status: "error", error, body: error.message, details: undefined, outcome: "error", exitCode: null });
		});

		child.on("close", (code, signalName) => {
			if (timedOut) {
				const body = completionBody(output, `Command timed out after ${params.timeout} seconds`);
				finish({ status: "error", error: new Error(body), body, details: undefined, outcome: "timeout", exitCode: null });
				return;
			}
			if (aborted || signalName) {
				const body = completionBody(output, "Command aborted");
				finish({ status: "error", error: new Error(body), body, details: undefined, outcome: "abort", exitCode: null });
				return;
			}
			if (code === 0) {
				const result: AgentToolResult<BashToolDetails> = { content: output ? [{ type: "text", text: output.replace(/\s*$/, "") }] : [], details: {} as BashToolDetails };
				finish({ status: "success", result, body: getText(result), details: result.details, outcome: "exit", exitCode: 0 });
				return;
			}
			const exitCode = code ?? 1;
			const body = completionBody(output, `Command exited with code ${exitCode}`);
			finish({ status: "error", error: new Error(body), body, details: undefined, outcome: "exit", exitCode });
		});
	});
}

function shouldTruncateBody(body: string): boolean {
	return Boolean(truncateContextText(body, { mode: "tail", maxLines: MAX_RESULT_LINES, maxBytes: MAX_RESULT_BYTES, appendNotice: false }).truncation?.truncated);
}

function escapePiContextClosingTags(text: string): string {
	return text.replace(/<\/pi_context>/gi, "<\\/pi_context>");
}

function addFullOutputHintToNotice(notice: string, fullOutputHint: string): string {
	return notice.endsWith("]") ? `${notice.slice(0, -1)}. Full output: ${fullOutputHint}]` : `${notice} Full output: ${fullOutputHint}`;
}

function truncateBodyWithHint(body: string, fullOutputHint: string): string {
	const { content, truncation } = truncateContextText(body, { mode: "tail", maxLines: MAX_RESULT_LINES, maxBytes: MAX_RESULT_BYTES, appendNotice: false });
	if (!truncation?.truncated) return body;
	return `${escapePiContextClosingTags(content)}\n\n${addFullOutputHintToNotice(formatTruncationNotice(truncation, "tail"), fullOutputHint)}`;
}

function trimOversizedToolResultsForContext(messages: AgentMessage[]): AgentMessage[] | undefined {
	let changed = false;
	const next = messages.map((message) => {
		const record = asRecord(message);
		if (record?.role !== "toolResult") return message;
		const content = Array.isArray(record.content) ? record.content : [];
		let contentChanged = false;
		const nextContent = content.map((part) => {
			const item = asRecord(part);
			if (item?.type !== "text" || typeof item.text !== "string" || !shouldTruncateBody(item.text)) return part;
			contentChanged = true;
			const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
			return {
				...part,
				text: truncateBodyWithHint(item.text, `${toolName} result trimmed by pi-background-bash context guard`),
			};
		});
		if (!contentChanged) return message;
		changed = true;
		return { ...message, content: nextContent } as AgentMessage;
	});
	return changed ? next : undefined;
}

function writeForegroundFullOutput(body: string): string {
	const dir = join(homedir(), ".pi", "pbb", "truncated");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.log`);
	writeFileSync(path, body);
	return path;
}

function truncateForegroundBody(job: ActiveJob | undefined, body: string): string {
	if (!shouldTruncateBody(body)) return body;
	const fullOutputHint = job?.pbb ? `pbb tail ${job.id} --full` : writeForegroundFullOutput(body);
	return truncateBodyWithHint(body, fullOutputHint);
}

function truncateLiveBody(body: string): string {
	if (!shouldTruncateBody(body)) return body;
	return truncateBodyWithHint(body, "final tool result/full-output snapshot");
}

function truncateBackgroundBody(job: ActiveJob, body: string): string {
	const fullOutputHint = job.pbb ? `pbb tail ${job.id} --full` : writeForegroundFullOutput(body);
	return truncateBodyWithHint(body, fullOutputHint);
}

function truncateForegroundResult(job: ActiveJob, completed: Extract<CompletedBashRun, { status: "success" }>): AgentToolResult<BashToolDetails> {
	const body = truncateForegroundBody(job, completed.body);
	return { content: body ? [{ type: "text", text: body }] : [], details: completed.result.details };
}

function buildXmlResult(job: ActiveJob, outcome: Outcome, exitCode: number | null, durationMs: number, body: string): string {
	// pi-context emits payload text as-is; escape the outer wrapper close tag so
	// command output cannot prematurely close the XML-ish context envelope.
	return piContext({
		source: "pi-background-bash",
		kind: "background_bash_result",
		id: job.id,
		attrs: {
			tool_call_id: job.toolCallId,
			session_id: job.pbb?.sessionId,
			session_key: job.pbb?.sessionKey,
			instance_id: job.pbb?.instanceId,
			lane: job.pbb?.lane,
			global_job_id: job.pbb ? `${job.pbb.instanceId}:${job.id}` : undefined,
			pbb_cursor: job.lastEventId,
			started_at: new Date(job.startedAt).toISOString(),
			command: job.command,
			outcome,
			exit_code: exitCode,
			duration_ms: durationMs,
		},
		body: escapePiContextClosingTags(body),
	});
}

type PendingBackgroundResultFollowUp = {
	job: ActiveJob;
	content: string;
	details: BackgroundBashDetails;
};

const pendingBackgroundResultFollowUps: PendingBackgroundResultFollowUp[] = [];

function deliverBackgroundResultFollowUp(pi: ExtensionAPI, item: PendingBackgroundResultFollowUp): void {
	if (shuttingDown) return;
	repairDetachedBackgroundToolResults(item.job.repairContext, item.job.toolCallId, { rewriteFile: item.job.repairContext?.isIdle?.() === true });
	pi.sendMessage(
		{
			customType: CUSTOM_TYPE,
			content: item.content,
			display: true,
			details: item.details,
		},
		{ deliverAs: "followUp", triggerTurn: true },
	);
}

function flushPendingBackgroundResultFollowUps(pi: ExtensionAPI): void {
	if (shuttingDown || pendingBackgroundResultFollowUps.length === 0) return;
	const items = pendingBackgroundResultFollowUps.splice(0);
	for (const item of items) deliverBackgroundResultFollowUp(pi, item);
}

function sendBackgroundResultFollowUp(pi: ExtensionAPI, job: ActiveJob, content: string, details: BackgroundBashDetails): void {
	const item = { job, content, details };

	// If a background command finishes while Pi is already inside a provider
	// request (for example, after a foreground multi-tool turn), injecting a
	// triggerTurn immediately can race with that in-flight request. With OpenAI
	// Responses/Codex this has surfaced as "No tool call found for function call
	// output" because a second request can be started from a transient context
	// containing tool outputs whose matching tool-call response is not the active
	// previous response. Queue the completion and flush it from agent_end instead
	// of polling for idle.
	if (job.repairContext?.isIdle?.() === false) {
		pendingBackgroundResultFollowUps.push(item);
		return;
	}

	deliverBackgroundResultFollowUp(pi, item);
}

function deliverBackgroundResult(pi: ExtensionAPI, job: ActiveJob, completed: CompletedBashRun, cwd: string) {
	activeJobs.delete(job.id);
	pendingJobs.finish(job.id);
	if (shuttingDown) return;

	const durationMs = Date.now() - job.startedAt;
	recordPbbJobCompleted(job, completed, cwd, durationMs);
	const body = truncateBackgroundBody(job, completed.body);
	const content = buildXmlResult(job, completed.outcome, completed.exitCode, durationMs, body);
	const details: BackgroundBashDetails = {
		...(completed.details ?? {}),
		jobId: job.id,
		command: job.command,
		outcome: completed.outcome,
		exitCode: completed.exitCode,
		toolCallId: job.toolCallId,
		startedAt: new Date(job.startedAt).toISOString(),
		durationMs,
		body,
		cwd,
		...(job.pbb
			? {
					sessionId: job.pbb.sessionId,
					sessionKey: job.pbb.sessionKey,
					instanceId: job.pbb.instanceId,
					lane: job.pbb.lane,
					globalJobId: `${job.pbb.instanceId}:${job.id}`,
					pbbCursor: job.lastEventId,
				}
			: {}),
	};

	sendBackgroundResultFollowUp(pi, job, content, details);
}

function renderNativeBashResult(command: string, body: string, details: BackgroundBashDetails | undefined, expanded: boolean, theme: any) {
	const cwd = details?.cwd ?? process.cwd();
	const bash = createBashToolDefinition(cwd);
	const state: any = {
		startedAt: details?.durationMs === undefined ? undefined : Date.now() - details.durationMs,
		endedAt: Date.now(),
		interval: undefined,
	};
	const isError = details?.outcome !== "exit" || (details.exitCode !== null && details.exitCode !== 0);
	const renderContext = (lastComponent: any) => ({
		args: { command },
		toolCallId: details?.jobId ?? "background_bash_result",
		invalidate: () => {},
		lastComponent,
		state,
		cwd,
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded,
		showImages: true,
		isError,
	});

	const box = new Box(1, 1, (text) => (isError ? theme.bg("toolErrorBg", text) : theme.bg("toolSuccessBg", text)));
	if (details?.jobId) {
		const status =
			details.outcome === "exit" && (details.exitCode === null || details.exitCode === 0)
				? "done"
				: details.outcome === "timeout"
					? "timed out"
					: details.outcome === "abort"
						? "aborted"
						: "failed";
		box.addChild(new Text(theme.fg("muted", `↳ ${details.jobId} ${status}.`), 0, 0));
	}
	const call = bash.renderCall?.({ command }, theme, renderContext(undefined));
	if (call) box.addChild(call);
	const result = bash.renderResult?.(
		{ content: [{ type: "text", text: body }], details },
		{ expanded, isPartial: false },
		theme,
		renderContext(undefined),
	);
	if (result) box.addChild(result);

	const container = new Container();
	container.addChild(box);
	return container;
}

function runningJobDetails(job: ActiveJob, cwd: string): BackgroundBashDetails {
	return {
		jobId: job.id,
		command: job.command,
		outcome: "running",
		exitCode: null,
		toolCallId: job.toolCallId,
		startedAt: new Date(job.startedAt).toISOString(),
		cwd,
		...(job.pbb
			? {
					sessionId: job.pbb.sessionId,
					sessionKey: job.pbb.sessionKey,
					instanceId: job.pbb.instanceId,
					lane: job.pbb.lane,
					globalJobId: `${job.pbb.instanceId}:${job.id}`,
					pbbCursor: job.lastEventId,
				}
			: {}),
	};
}

function abortAllJobs() {
	shuttingDown = true;
	if (killRequestTimer) clearInterval(killRequestTimer);
	killRequestTimer = undefined;
	for (const job of activeJobs.values()) {
		job.abortController.abort();
		if (job.runner === "pbb") killProcessGroup(job.pgid ?? job.pid, "SIGTERM");
	}
	activeJobs.clear();
	pendingJobs.clear();
}

function installProcessHooks() {
	if (processHooksInstalled) return;
	processHooksInstalled = true;
	// Best-effort last resort. Normal cleanup happens on Pi's session_shutdown event;
	// do not install SIGINT/SIGTERM handlers here because that would interfere with
	// Pi's own process-level signal handling.
	process.once("exit", abortAllJobs);
}

function restoreJobCounterFromSession(ctx: { sessionManager?: { getEntries?: () => unknown[] } }) {
	let max = 0;
	const entries = ctx.sessionManager?.getEntries?.() ?? [];
	for (const entry of entries as Array<Record<string, unknown>>) {
		const details = entry.details as Record<string, unknown> | undefined;
		const content = typeof entry.content === "string" ? entry.content : undefined;
		const candidates = [details?.jobId, content?.match(/<pi_context\b[^>]*\bid="(bg\d{3,})"/)?.[1]];
		for (const candidate of candidates) {
			const n = parseJobNumber(candidate);
			if (n !== undefined) max = Math.max(max, n);
		}
	}
	nextJobNumber = Math.max(nextJobNumber, max + 1);
}

export default function backgroundBashExtension(pi: ExtensionAPI) {
	installProcessHooks();

	pi.registerMessageRenderer<BackgroundBashDetails>(CUSTOM_TYPE, (message, options, theme) => {
		const details = message.details;
		const command = details?.command ?? "";
		const body = details?.body ?? (typeof message.content === "string" ? message.content : "");
		return renderNativeBashResult(command, body, details, options.expanded, theme);
	});

	pi.on("session_start", async (_event, ctx) => {
		shuttingDown = false;
		const id = pbbIdentity(ctx);
		if (id) exportPbbEnv(id);
		if (killRequestTimer) clearInterval(killRequestTimer);
		killRequestTimer = setInterval(handlePbbKillRequests, 250);
		killRequestTimer.unref?.();
		if (ctx.hasUI) pendingJobs.attach(ctx.ui);
		restoreJobCounterFromSession(ctx);
		repairDetachedBackgroundToolResults(ctx, undefined, { rewriteFile: true });
	});

	pi.on("session_shutdown", async () => {
		abortAllJobs();
		pendingBackgroundResultFollowUps.length = 0;
		pendingJobs.detach();
	});

	pi.on("agent_end", async () => {
		// Treat agent_end as the event-driven idle boundary, but defer one macrotask
		// so Pi can finish unwinding the just-ended turn before the follow-up starts.
		const handle = setImmediate(() => flushPendingBackgroundResultFollowUps(pi));
		handle.unref?.();
	});

	pi.on("context", (event) => {
		const messages = trimOversizedToolResultsForContext(event.messages);
		if (messages) return { messages };
	});

	pi.registerTool({
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Verbose background results are truncated with the full output available through pbb tail. Set background: true to run immediately in the background and get a job id. Otherwise, if the command is still running after the configured auto-background threshold (${formatThreshold(DEFAULT_AUTO_BACKGROUND_AFTER_SECONDS)} by default), it is automatically moved to the background; a <pi_context source="pi-background-bash" kind="background_bash_result"> message is injected when it finishes. Optionally provide a timeout in seconds.`,
		promptSnippet: `Execute bash commands (ls, grep, find, etc.); timeout is in seconds. Set background: true for long-running non-interactive commands. Commands still running after the configured auto-background threshold (${formatThreshold(DEFAULT_AUTO_BACKGROUND_AFTER_SECONDS)} by default) automatically move to background and wake you with a pi-background-bash result when finished.`,
		promptGuidelines: [
			"Use bash with background: true for long-running non-interactive commands such as builds, full test suites, dev servers, watchers, deploys, downloads, or commands you do not need before the next step.",
			`Use bash normally for shell commands; Pi automatically moves bash commands that run longer than the configured auto-background threshold (${formatThreshold(DEFAULT_AUTO_BACKGROUND_AFTER_SECONDS)} by default) to the background.`,
			"When bash reports that a command started or moved to background, do not retry it just to wait; continue independent work or tell the user the job is running.",
			"Use the pbb CLI (`pbb list`, `pbb status <job>`, `pbb tail <job>`) only when you need progress before the completion follow-up arrives, need full truncated logs, or need to manage a job; pbb defaults to the current pi-lane runtime instance when available.",
			"When a <pi_context source=\"pi-background-bash\" kind=\"background_bash_result\"> message appears, treat it like the final result of the original bash command.",
			"Do not use bash for interactive commands that require stdin unless the user explicitly asks for that behavior.",
		],
		parameters: schema,
		async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<BashToolDetails | BackgroundBashDetails>> {
			const autoAfterSeconds = getAutoBackgroundAfterSeconds(ctx.cwd);

			if (signal?.aborted) {
				throw new Error("Command aborted");
			}

			if (params.background) {
				if (activeJobs.size >= MAX_ACTIVE_JOBS) {
					throw new Error(`Too many bash jobs running (${activeJobs.size}/${MAX_ACTIVE_JOBS}). Wait for one to finish before starting another.`);
				}

				const job: ActiveJob = {
					id: formatJobId(nextJobNumber++),
					command: params.command,
					toolCallId,
					abortController: new AbortController(),
					startedAt: Date.now(),
					cwd: ctx.cwd,
					pbb: pbbIdentity(ctx),
					runner: "pbb",
					repairContext: ctx,
				};
				activeJobs.set(job.id, job);
				recordPbbJobStarted(job, ctx.cwd);
				pendingJobs.start({
					id: job.id,
					text: job.command,
					startedAt: job.startedAt,
					details: { toolCallId: job.toolCallId },
				});

				const completedPromise = runPbbBash(job, ctx.cwd, params);
				// Capture cwd eagerly: the completion callback may fire after session
				// teardown (headless one-shot exit), when ctx.cwd access throws.
				const jobCwd = ctx.cwd;
				void completedPromise.then((completed) => {
					deliverBackgroundResult(pi, job, completed, jobCwd);
				});
				scheduleDetachedBackgroundToolResultRepair(ctx, toolCallId);

				return {
					content: [{ type: "text", text: `Bash job ${job.id} started in background. A follow-up result will arrive when it finishes; continue independent work. Use pbb only if you need progress before completion.` }],
					details: runningJobDetails(job, ctx.cwd),
				};
			}

			if (autoAfterSeconds <= 0) {
				const job: ActiveJob = {
					id: `fg_${toolCallId}`,
					command: params.command,
					toolCallId,
					abortController: new AbortController(),
					startedAt: Date.now(),
					runner: "pbb",
				};
				activeJobs.set(job.id, job);
				const forwardAbort = () => job.abortController.abort();
				if (signal?.aborted) forwardAbort();
				else signal?.addEventListener("abort", forwardAbort, { once: true });
				try {
					const completed = await runPbbBash(job, ctx.cwd, params, onUpdate);
					if (completed.status === "success") return truncateForegroundResult(job, completed);
					rethrowBashError(completed, job);
				} finally {
					signal?.removeEventListener("abort", forwardAbort);
					activeJobs.delete(job.id);
				}
			}

			if (activeJobs.size >= MAX_ACTIVE_JOBS) {
				throw new Error(`Too many bash jobs running (${activeJobs.size}/${MAX_ACTIVE_JOBS}). Wait for one to finish before starting another.`);
			}

			const job: ActiveJob = {
				// Foreground bash calls should not consume visible bg001 IDs unless they
				// actually cross the threshold and become background jobs.
				id: `auto_${toolCallId}`,
				command: params.command,
				toolCallId,
				abortController: new AbortController(),
				startedAt: Date.now(),
				repairContext: ctx,
			};
			activeJobs.set(job.id, job);

			let backgrounded = false;
			const forwardAbort = () => {
				if (!backgrounded) job.abortController.abort();
			};
			if (signal?.aborted) forwardAbort();
			else signal?.addEventListener("abort", forwardAbort, { once: true });

			let latestBody = "";
			const completedPromise = runPbbBash(job, ctx.cwd, params, (update) => {
				latestBody = getText(update);
				if (!backgrounded) onUpdate?.(update);
			});

			const winner = await Promise.race([completedPromise, waitForBackgroundThreshold(autoAfterSeconds)]);
			if (winner !== "background") {
				signal?.removeEventListener("abort", forwardAbort);
				activeJobs.delete(job.id);
				if (winner.status === "success") return truncateForegroundResult(job, winner);
				rethrowBashError(winner, job);
			}

			backgrounded = true;
			signal?.removeEventListener("abort", forwardAbort);
			activeJobs.delete(job.id);
			job.id = formatJobId(nextJobNumber++);
			job.cwd = ctx.cwd;
			job.pbb = pbbIdentity(ctx);
			activeJobs.set(job.id, job);
			recordPbbJobStarted(job, ctx.cwd);
			appendPbbLogDelta(job, latestBody);
			pendingJobs.start({
				id: job.id,
				text: job.command,
				startedAt: job.startedAt,
				details: { toolCallId: job.toolCallId },
			});

			// Capture cwd eagerly: the completion callback may fire after session
			// teardown (headless one-shot exit), when ctx.cwd access throws.
			const jobCwd = ctx.cwd;
			void completedPromise.then((completed) => {
				deliverBackgroundResult(pi, job, completed, jobCwd);
			});
			scheduleDetachedBackgroundToolResultRepair(ctx, toolCallId);

			return {
				content: [{ type: "text", text: `Bash job ${job.id} moved to background after ${formatThreshold(autoAfterSeconds)}. A follow-up result will arrive when it finishes; continue independent work. Use pbb only if you need progress before completion.` }],
				details: runningJobDetails(job, ctx.cwd),
			};
		},
	});

}
