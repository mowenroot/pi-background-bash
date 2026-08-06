/**
 * Local replacements for sshkeda/pi-context (private repository, no longer
 * accessible). Only the three functions used by this extension are
 * reimplemented here:
 *
 *  - piContext()             wraps payload text in a <pi_context ...> envelope
 *  - truncateContextText()   tail/head truncation by lines and bytes (UTF-8 aware)
 *  - formatTruncationNotice() display notice for a truncation
 *
 * See https://github.com/mowenroot/pi-background-bash (fork of sshkeda's) for
 * the rationale: the original dependency could not be installed from GitHub.
 */

export interface PiContextAttrs {
	[key: string]: string | number | boolean | undefined;
}

export interface PiContextOptions {
	source: string;
	kind: string;
	id?: string;
	attrs?: PiContextAttrs;
	body?: string;
}

/**
 * Build a <pi_context> envelope. Attribute values are quote-escaped; the body
 * is emitted as-is (pi-background-bash pre-escapes `</pi_context>` itself so
 * command output cannot prematurely close the envelope).
 */
export function piContext({ source, kind, id, attrs = {}, body = "" }: PiContextOptions): string {
	const allAttrs: PiContextAttrs = { source, kind, ...(id ? { id } : {}), ...attrs };
	const attrStr = Object.entries(allAttrs)
		.filter(([, v]) => v !== undefined && v !== null)
		.map(([k, v]) => `${k}="${String(v).replace(/"/g, "&quot;")}"`)
		.join(" ");
	return `<pi_context ${attrStr}>${body}</pi_context>`;
}

export interface TruncationInfo {
	truncated: boolean;
	mode: "head" | "tail";
	maxLines: number;
	maxBytes: number;
	removedLines: number;
	removedBytes: number;
	originalLength: number;
	appendNotice: boolean;
}

export interface TruncateContextTextOptions {
	mode?: "head" | "tail";
	maxLines: number;
	maxBytes: number;
	appendNotice?: boolean;
}

/**
 * Truncate text by maxLines and maxBytes (UTF-8 aware, no mid-codepoint cuts).
 * mode "head" keeps the beginning, "tail" keeps the end.
 * Returns { content, truncation } where truncation is undefined when untouched.
 */
export function truncateContextText(
	text: string,
	{ mode = "tail", maxLines, maxBytes, appendNotice = false }: TruncateContextTextOptions,
): { content: string; truncation?: TruncationInfo } {
	if (typeof text !== "string") return { content: String(text ?? ""), truncation: undefined };
	if (text === "") return { content: "", truncation: undefined };

	let truncated = false;
	let removedLines = 0;
	let removedBytes = 0;

	let lines = text.split("\n");
	if (lines.length > maxLines) {
		truncated = true;
		removedLines = lines.length - maxLines;
		lines = mode === "head" ? lines.slice(0, maxLines) : lines.slice(-maxLines);
	}

	let content = lines.join("\n");
	const buf = Buffer.from(content, "utf8");
	if (buf.length > maxBytes) {
		truncated = true;
		removedBytes = buf.length - maxBytes;
		let cut: Buffer;
		if (mode === "head") {
			cut = buf.subarray(0, maxBytes);
			while (cut.length > 0 && (cut[cut.length - 1] & 0xc0) === 0x80) cut = cut.subarray(0, cut.length - 1);
		} else {
			cut = buf.subarray(removedBytes);
			while (cut.length > 0 && (cut[0] & 0xc0) === 0x80) cut = cut.subarray(1);
		}
		content = cut.toString("utf8");
	}

	const truncation: TruncationInfo | undefined = truncated
		? { truncated, mode, maxLines, maxBytes, removedLines, removedBytes, originalLength: text.length, appendNotice }
		: undefined;

	if (truncated && appendNotice && truncation) {
		content = `${content}\n${formatTruncationNotice(truncation, mode)}`;
	}

	return { content, truncation };
}

/** Build a notice like "[output truncated: tail kept (123 lines, 45 KB)]". */
export function formatTruncationNotice(truncation: TruncationInfo, mode: "head" | "tail" = "tail"): string {
	const parts: string[] = [];
	if (truncation?.removedLines > 0) parts.push(`${truncation.removedLines} line${truncation.removedLines > 1 ? "s" : ""}`);
	if (truncation?.removedBytes > 0) parts.push(`${Math.max(1, Math.round(truncation.removedBytes / 1024))} KB`);
	const detail = parts.length ? ` (${parts.join(", ")})` : "";
	return `[output truncated: ${mode} kept${detail}]`;
}
