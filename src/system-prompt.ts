/**
 * System Prompt Composition
 *
 * Builds the system prompt for a Talk from its metadata, context document,
 * pinned messages, and active jobs. Sections are omitted when empty.
 */

import type { TalkMeta, TalkMessage, TalkJob } from './types.js';

export interface SystemPromptInput {
  meta: TalkMeta;
  contextMd: string;
  pinnedMessages: TalkMessage[];
  agentOverride?: {
    name: string;
    role: string;
    roleInstructions: string;
    otherAgents: { name: string; role: string; model: string }[];
  };
}

export function composeSystemPrompt(input: SystemPromptInput): string | undefined {
  const { meta, contextMd, pinnedMessages, agentOverride } = input;

  const sections: string[] = [];

  // Agent identity (prepended before base instruction when present)
  if (agentOverride) {
    let identitySection = `## Your Identity\nYou are **${agentOverride.name}**, acting as the **${agentOverride.role}** in this conversation.\n\n${agentOverride.roleInstructions}`;
    if (agentOverride.otherAgents.length > 0) {
      const agentLines = agentOverride.otherAgents.map(
        a => `- **${a.name}** (${a.role}) — using ${a.model}`,
      );
      identitySection += `\n\n### Other Agents in This Conversation\n${agentLines.join('\n')}`;
    }
    identitySection += '\n\n---';
    sections.push(identitySection);
  }

  // Base instruction
  sections.push(
    'You are a focused assistant in an ongoing conversation.\n\n' +
    '## Context Saving\n' +
    'This conversation is a **Talk** — a scoped, self-contained context. ' +
    'When the user asks to save or remember context, default to saving it ' +
    'within this Talk (e.g. pinned messages, conversation context, or objective) ' +
    'rather than writing to external or general-purpose context files. ' +
    'Talks are designed to keep context confined and focused. ' +
    'Only save to broader/external context if the user explicitly asks for it.',
  );

  // Objective
  if (meta.objective) {
    sections.push(
      `## Objective\n${meta.objective}\n\n` +
      'Your responses should serve this objective. If the conversation drifts, gently ' +
      'steer it back. Track progress and flag when milestones are reached.',
    );
  }

  // Conversation context
  if (contextMd.trim()) {
    sections.push(
      `## Conversation Context\nThe following is a running summary of this conversation so far:\n\n${contextMd.trim()}`,
    );
  }

  // Pinned references
  if (pinnedMessages.length > 0) {
    const pinLines = pinnedMessages.map(m => {
      const preview = m.content.length > 200
        ? m.content.slice(0, 200) + '...'
        : m.content;
      const ts = new Date(m.timestamp).toISOString().slice(0, 16).replace('T', ' ');
      return `- ${m.role} (${ts}): ${preview}`;
    });
    sections.push(
      `## Pinned References\nThe user has pinned these as important:\n${pinLines.join('\n')}`,
    );
  }

  // Active jobs
  const activeJobs = meta.jobs.filter(j => j.active);
  if (activeJobs.length > 0) {
    const jobLines = activeJobs.map(j => `- [${j.schedule}] ${j.prompt}`);
    sections.push(
      `## Active Jobs\nBackground tasks monitoring this conversation:\n${jobLines.join('\n')}`,
    );
  }

  // Job creation instructions (always included)
  sections.push(
    `## Job Creation\n` +
    `You can create recurring scheduled jobs for this conversation. When the user asks\n` +
    `for recurring monitoring, scheduled check-ins, or periodic tasks, output a job block:\n\n` +
    '```job\n' +
    `schedule: <cron expression>\n` +
    `prompt: <self-contained instruction for each run>\n` +
    '```\n\n' +
    `Common cron patterns:\n` +
    '- `0 8 * * *` — daily at 8 AM\n' +
    '- `0 9 * * 1` — weekly Monday at 9 AM\n' +
    '- `0 */2 * * *` — every 2 hours\n' +
    '- `30 17 * * 1-5` — weekdays at 5:30 PM\n\n' +
    `The prompt should be a complete, self-contained instruction for what to check/do on\n` +
    `each run. The job executes in this conversation's full context.\n` +
    `Only create jobs when the user explicitly asks for something recurring or scheduled.`,
  );

  return sections.join('\n\n');
}
