/**
 * Deriving a provider-visible message history from a session log.
 *
 * The three event types do **not** carry the message in the same place:
 *
 *   user/message                          -> `data` **is** the message
 *   assistant/system/developer/message    -> `data.message` is the message
 *   tool/result                           -> `data.message` is the message
 *
 * A message whose content is empty is dropped, matching the harness — an empty
 * turn is not sent.
 *
 * That asymmetry is a trap. A first version of this code read `data.message` for
 * every event and silently produced an assistant-only history — dropping all
 * 1 107 tool results from a 2 325-message log, which hid the very cascade the
 * audit existed to check. Nothing failed; the number was just wrong.
 *
 * The event-type list is checked against the harness's own projection rather
 * than assumed. A version that omitted `system/message` and `developer/message`
 * read a 2 343-message history as 2 333 and dropped ten messages silently — an
 * omission, which is the failure kind that never announces itself.
 *
 * @module scripts/session-history
 */

/** One event from a session log, narrowed to the fields the parser reads. */
export interface SessionEvent {
  readonly type?: string;
  readonly seq?: number;
  readonly data?: {
    readonly role?: string;
    readonly message?: { readonly role?: string; readonly content?: readonly unknown[] };
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

/** A message as it appears in a session log. */
export interface SessionMessage {
  readonly role: string;
  readonly content?: readonly unknown[];
  readonly toolCallId?: string;
  readonly [key: string]: unknown;
}

/** One content block, narrowed to the fields the invariant audit reads. */
interface BlockFields {
  readonly type?: string;
  readonly name?: string;
  readonly id?: string;
}

/** One message, narrowed to the fields the invariant audit reads. */
interface MessageFields {
  readonly role?: string;
  readonly content?: readonly BlockFields[];
  readonly toolCallId?: string;
}

/** The event types that contribute a message. */
export const MESSAGE_EVENT_TYPES: readonly string[] = [
  'user/message',
  'assistant/message',
  'system/message',
  'developer/message',
  'tool/result',
];

/**
 * Extract the message a single event contributes, or `undefined`.
 *
 * Returns `undefined` for any event that carries no message, so a caller can
 * count what it skipped rather than guessing.
 */
export function messageOf(event: unknown): SessionMessage | undefined {
  if (event === null || typeof event !== 'object') return undefined;
  const { type, data } = event as SessionEvent;
  switch (type) {
    case 'user/message':
      // The whole `data` object is the message.
      return data?.role === undefined ? undefined : (data as SessionMessage);
    case 'assistant/message':
    case 'system/message':
    case 'developer/message': {
      const message = data?.message;
      if (message?.role === undefined) return undefined;
      // The harness drops a message with no content rather than sending an empty
      // turn. `deriveEventMessage` returns null for exactly this case, so a
      // projection that keeps it would be one message longer than the request.
      if (Array.isArray(message.content) && message.content.length === 0) return undefined;
      return message as SessionMessage;
    }
    case 'tool/result': {
      const message = data?.message;
      return message?.role === undefined ? undefined : (message as SessionMessage);
    }
    default:
      return undefined;
  }
}

/**
 * Derive the provider-visible history from raw JSONL.
 *
 * @param raw - the decompressed session log.
 * @returns the messages, in log order, plus a tally of skipped events.
 */
export function deriveMessages(raw: string): {
  readonly messages: readonly SessionMessage[];
  readonly skipped: readonly { readonly reason: string; readonly seq?: number }[];
} {
  const messages: SessionMessage[] = [];
  const skipped: { readonly reason: string; readonly seq?: number }[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped.push({ reason: 'unparseable line' });
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    const event = parsed as SessionEvent;
    if (typeof event.type !== 'string' || !MESSAGE_EVENT_TYPES.includes(event.type)) continue;
    const message = messageOf(event);
    if (message === undefined) {
      skipped.push({ reason: `${event.type} carried no message`, seq: event.seq });
      continue;
    }
    messages.push(message);
  }
  return { messages, skipped };
}

/** Count messages by role, for reporting. */
export function countRoles(messages: readonly SessionMessage[]): Readonly<Record<string, number>> {
  const roles: Record<string, number> = {};
  for (const message of messages) {
    roles[message.role] = (roles[message.role] ?? 0) + 1;
  }
  return roles;
}

/** The provider invariants a history is checked against. */
export interface SessionInvariants {
  readonly emptyNames: number;
  readonly malformedCalls: number;
  readonly strandedResults: number;
}

/**
 * The invariants a strict provider enforces on a history.
 *
 * Deliberately an **independent** implementation from the rules: it exists to
 * cross-check them, so sharing code would make the check circular. But an
 * independent implementation that nobody tests is just a second opinion nobody
 * verified, so this is exported and covered by `test/session-invariants.test.ts`.
 *
 * The three are not equivalent, and the difference matters:
 *
 *   - `emptyNames` — an assistant tool call with no name. **The plugin's subject.**
 *     Fatal on the wire; the live acceptance run confirms 400 for Anthropic
 *     Messages. `tool-call-name` repairs it.
 *   - `strandedResults` — a tool result answering a call absent from the request.
 *     **Also the plugin's subject**, though protocol-dependent: Anthropic Messages
 *     accepts it, OpenAI-compatible protocols reject it by contract (TESTPLAN §3l).
 *     `orphan-tool-result` repairs it.
 *   - `malformedCalls` — a call with no usable id. **Not the plugin's subject.** It
 *     is reported because a non-zero value would mean the log shape is outside
 *     anything this plugin models, but no rule repairs it and none should. Across
 *     243 session logs — 86 322 tool-call blocks — none lacked an id, and there is
 *     no path by which one could: the adapter assigns provider ids, and the
 *     assembler falls back to `call-${index}`.
 *
 * Only usable ids are collected: treating `String(undefined)` as a matchable id
 * would silently pair an id-less call with an id-less result.
 */
export function auditInvariants(messages: readonly unknown[]): SessionInvariants {
  const ids = new Set<string>();
  let emptyNames = 0;
  let malformedCalls = 0;
  for (const message of messages) {
    const msg = (message ?? {}) as MessageFields;
    if (msg.role !== 'assistant') continue;
    for (const block of msg.content ?? []) {
      if (block?.type !== 'tool-call') continue;
      if (String(block.name ?? '').trim() === '') emptyNames += 1;
      if (typeof block.id !== 'string' || block.id.length === 0) {
        malformedCalls += 1;
        continue;
      }
      ids.add(block.id);
    }
  }
  let strandedResults = 0;
  for (const message of messages) {
    const msg = (message ?? {}) as MessageFields;
    if (msg.role !== 'tool') continue;
    const reference = msg.toolCallId;
    // A result with no reference at all cannot be correlated; `malformedCalls`
    // covers the call side, and guessing here would report a phantom strand.
    if (typeof reference !== 'string' || reference.length === 0) continue;
    if (!ids.has(reference)) strandedResults += 1;
  }
  return { emptyNames, malformedCalls, strandedResults };
}
