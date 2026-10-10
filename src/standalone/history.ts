import { randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { canonicalJsonSha256 } from "../authority/canonical-json.js";
import { prepareSafeRoot } from "../artifacts/atomic-file.js";
import { sha256Hex } from "../foundation/crypto.js";
import type { ChatMessage } from "./provider.js";

export interface SavedSessionHistory {
  readonly sessionId: string;
  readonly goalId: string;
  readonly workspace: string;
  readonly messages: readonly ChatMessage[];
}

interface StoredSessionHistory {
  readonly schema_version: 1;
  readonly session_id: string;
  readonly goal_id: string;
  readonly workspace: string;
  readonly messages: readonly ChatMessage[];
  readonly content_sha256: string;
}

function checkedSessionId(sessionId: string): void {
  if (!sessionId || sessionId.length > 256) throw new TypeError("Session ID is invalid");
}

function contentHash(record: Omit<StoredSessionHistory, "content_sha256">): string {
  return canonicalJsonSha256(record);
}

/** Non-authoritative transcript: it can restore model context, never approve or replay a side effect. */
export class SessionHistoryStore {
  private readonly root: string;

  constructor(dataRoot: string) {
    if (!isAbsolute(dataRoot)) throw new TypeError("Standalone data root must be absolute");
    this.root = prepareSafeRoot(resolve(dataRoot, "sessions"));
  }

  path(sessionId: string): string {
    checkedSessionId(sessionId);
    return resolve(this.root, `${sha256Hex(sessionId)}.json`);
  }

  save(input: SavedSessionHistory): string {
    checkedSessionId(input.sessionId);
    if (!input.goalId || !isAbsolute(input.workspace)) throw new TypeError("Saved Goal and workspace identity are invalid");
    if (input.messages.length > 2_048) throw new TypeError("Saved conversation exceeds its message limit");
    const unsigned = {
      schema_version: 1 as const, session_id: input.sessionId, goal_id: input.goalId,
      workspace: resolve(input.workspace), messages: input.messages,
    };
    const serialized = `${JSON.stringify({ ...unsigned, content_sha256: contentHash(unsigned) })}\n`;
    if (Buffer.byteLength(serialized, "utf8") > 16_777_216) throw new TypeError("Saved conversation exceeds its byte limit");
    const path = this.path(input.sessionId);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new TypeError("Saved conversation path is linked");
    const temporary = resolve(this.root, `.history-${randomUUID()}.tmp`);
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, serialized, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    return path;
  }

  load(sessionId: string): SavedSessionHistory | null {
    const path = this.path(sessionId);
    if (!existsSync(path)) return null;
    if (lstatSync(path).isSymbolicLink() || statSync(path).size > 16_777_216) {
      throw new TypeError("Saved conversation has an unsafe path or size");
    }
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("Saved conversation is invalid");
    const record = parsed as Partial<StoredSessionHistory>;
    if (record.schema_version !== 1 || record.session_id !== sessionId || typeof record.goal_id !== "string"
      || typeof record.workspace !== "string" || !isAbsolute(record.workspace)
      || !Array.isArray(record.messages) || record.messages.length > 2_048
      || typeof record.content_sha256 !== "string") {
      throw new TypeError("Saved conversation identity is invalid");
    }
    const unsigned = {
      schema_version: 1 as const, session_id: record.session_id, goal_id: record.goal_id,
      workspace: record.workspace, messages: record.messages,
    };
    if (contentHash(unsigned) !== record.content_sha256) throw new TypeError("Saved conversation integrity check failed");
    return { sessionId: record.session_id, goalId: record.goal_id,
      workspace: record.workspace, messages: record.messages };
  }
}
