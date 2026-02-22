/**
 * Talk Context Builder
 *
 * Composes a compact context block for injection into OpenClaw's agent
 * via the `before_agent_start` hook's `prependContext` return.
 *
 * Includes: onMessagePrompt (instructions), objective, directives (rules),
 * conversation context (context.md), pinned messages, and state file paths.
 */

import type { TalkStore } from './talk-store.js';
import type { TalkMeta, TalkMessage, Logger } from './types.js';

const MAX_AGENT_CONTEXT_BYTES = 8 * 1024;

export async function buildTalkContextForAgent(
  talk: TalkMeta,
  store: TalkStore,
  logger: Logger,
): Promise<string | null> {
  const sections: string[] = [];

  sections.push('--- ClawTalk Talk Context ---');

  // Instructions from platform behaviors (onMessagePrompt)
  const slackBehaviors = (talk.platformBehaviors ?? []).filter(b => {
    const binding = (talk.platformBindings ?? []).find(pb => pb.id === b.platformBindingId);
    return binding?.platform.trim().toLowerCase() === 'slack';
  });
  const onMessagePrompts = slackBehaviors
    .map(b => b.onMessagePrompt?.trim())
    .filter((p): p is string => Boolean(p));
  if (onMessagePrompts.length > 0) {
    sections.push(`## Instructions\n${onMessagePrompts.join('\n\n')}`);
  }

  // Response policy — prompt the agent for 'off' and 'mentions' modes
  const observeOnlyScopes: string[] = [];
  const mentionsOnlyScopes: string[] = [];
  for (const b of slackBehaviors) {
    const mode = b.responseMode
      ?? ((b as { autoRespond?: boolean }).autoRespond === false ? 'off' : 'all');
    if (mode === 'all') continue;
    const binding = (talk.platformBindings ?? []).find(pb => pb.id === b.platformBindingId);
    if (!binding) continue;
    const label = binding.displayScope ?? binding.scope;
    if (mode === 'off') observeOnlyScopes.push(label);
    else if (mode === 'mentions') mentionsOnlyScopes.push(label);
  }
  const policyLines: string[] = [];
  if (observeOnlyScopes.length > 0) {
    policyLines.push(
      'Do not reply to messages from these channels. ' +
      'Read them and update context.md if they contain relevant information.',
      ...observeOnlyScopes.map(s => `- ${s}`),
    );
  }
  if (mentionsOnlyScopes.length > 0) {
    policyLines.push(
      'Only reply in these channels when you are directly @mentioned. ' +
      'Ignore messages that do not mention you.',
      ...mentionsOnlyScopes.map(s => `- ${s}`),
    );
  }
  if (policyLines.length > 0) {
    sections.push('## Response Policy\n' + policyLines.join('\n'));
  }

  // Objective
  if (talk.objective?.trim()) {
    sections.push(`## Objective\n${talk.objective.trim()}`);
  }

  // Rules (active directives)
  const activeDirectives = (talk.directives ?? []).filter(d => d.active);
  if (activeDirectives.length > 0) {
    const lines = activeDirectives.map((d, i) => `${i + 1}. ${d.text}`);
    sections.push(
      '## Rules\n' +
      'Follow each directive as written. These are standing rules for this conversation.\n\n' +
      lines.join('\n'),
    );
  }

  // Conversation context (context.md)
  try {
    const contextMd = await store.getContextMd(talk.id);
    if (contextMd.trim()) {
      sections.push(
        `## Conversation Context\nThe following is a running summary of this conversation so far:\n\n${contextMd.trim()}`,
      );
    }
  } catch {
    // context.md missing is non-fatal
  }

  // Knowledge files index (agent can Read full content)
  try {
    const knowledgeIndex = await store.getKnowledgeIndex(talk.id);
    if (knowledgeIndex.length > 0) {
      const indexLines = knowledgeIndex.map(e => `- ${e.slug}: ${e.summary}`);
      const dataDir = store.getDataDir();
      sections.push(
        '## Knowledge Files\n' +
        'Durable domain knowledge is stored in topic files. Use `Read` to access full content.\n\n' +
        indexLines.join('\n') + '\n\n' +
        `Directory: ${dataDir}/talks/${talk.id}/knowledge/`,
      );
    }
  } catch {
    // non-fatal
  }

  // Pinned references (match client cap of 10)
  if (talk.pinnedMessageIds.length > 0) {
    try {
      const pinned = await Promise.all(
        talk.pinnedMessageIds.slice(0, 10).map(id => store.getMessage(talk.id, id)),
      );
      const validPins = pinned.filter(Boolean) as TalkMessage[];
      if (validPins.length > 0) {
        const pinLines = validPins.map(m => {
          const preview = m.content.length > 200
            ? m.content.slice(0, 200) + '...'
            : m.content;
          const ts = new Date(m.timestamp).toISOString().slice(0, 16).replace('T', ' ');
          return `- ${m.role} (${ts}): ${preview}`;
        });
        const overflow = talk.pinnedMessageIds.length > 10
          ? `\n- ... and ${talk.pinnedMessageIds.length - 10} more pinned messages`
          : '';
        sections.push(`## Pinned References\nThe user has pinned these as important:\n${pinLines.join('\n')}${overflow}`);
      }
    } catch {
      // non-fatal
    }
  }

  // State paths — tell the agent where to read/write persistent data
  const dataDir = store.getDataDir();
  sections.push(
    `## State\n` +
    `Data directory: ${dataDir}/talks/${talk.id}/state/\n` +
    `Context file: ${dataDir}/talks/${talk.id}/context.md\n` +
    `Knowledge directory: ${dataDir}/talks/${talk.id}/knowledge/\n` +
    `Update context.md when significant progress occurs (not every message).`,
  );

  if (sections.length <= 1) return null; // only header, no meaningful content

  let result = sections.join('\n\n');

  // Cap at MAX_AGENT_CONTEXT_BYTES
  if (Buffer.byteLength(result, 'utf-8') > MAX_AGENT_CONTEXT_BYTES) {
    const encoder = new TextEncoder();
    const encoded = encoder.encode(result);
    const truncated = encoded.slice(0, MAX_AGENT_CONTEXT_BYTES);
    result = new TextDecoder().decode(truncated);
    const lastNewline = result.lastIndexOf('\n');
    if (lastNewline > MAX_AGENT_CONTEXT_BYTES * 0.8) {
      result = result.slice(0, lastNewline);
    }
    result += '\n\n[Talk context truncated]';
  }

  return result;
}
