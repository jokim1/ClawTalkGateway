/**
 * Event Dispatcher
 *
 * Listens to OpenClaw lifecycle hooks (e.g. message_received) and triggers
 * matching event-driven jobs. Each event is matched against platform bindings
 * and active event jobs across all Talks.
 *
 * Event-driven jobs use the schedule format "on <scope>" where <scope>
 * matches a platform binding's scope (e.g. "#kids-study-log", "Family Chat").
 */

import type { TalkStore } from './talk-store.js';
import type { TalkJob, Logger } from './types.js';
import type { ToolRegistry } from './tool-registry.js';
import type { ToolExecutor } from './tool-executor.js';
import { parseEventTrigger, EVENT_JOB_DEBOUNCE_MS, executeJob } from './job-scheduler.js';
import type { JobSchedulerOptions } from './job-scheduler.js';

/** Shape of the OpenClaw message_received event. */
export interface MessageReceivedEvent {
  from: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

/** Shape of the OpenClaw message context. */
export interface MessageContext {
  channelId: string;
  accountId?: string;
  conversationId?: string;
}

/** Info needed to deliver a reply back to the originating platform. */
export interface EventReplyTarget {
  platform: string;
  accountId: string | undefined;
  /** Platform-specific channel/conversation ID (e.g. Slack channel ID). */
  platformChannelId: string | undefined;
  /** Thread ID for threaded replies (e.g. Slack message ts). */
  threadId: string | undefined;
}

/**
 * Callback to deliver event job output back to the originating platform.
 * Returns true if delivery succeeded.
 */
export type ReplyToEventFn = (
  target: EventReplyTarget,
  message: string,
) => Promise<boolean>;

export interface EventDispatcherOptions {
  store: TalkStore;
  gatewayOrigin: string;
  authToken: string | undefined;
  logger: Logger;
  registry: ToolRegistry;
  executor: ToolExecutor;
  dataDir?: string;
  jobTimeoutMs?: number;
  /** Optional callback to deliver event job output back to the originating platform. */
  replyToEvent?: ReplyToEventFn;
}

/** Track debounce state per event job. */
interface DebounceEntry {
  lastFiredAt: number;
}

export class EventDispatcher {
  private readonly opts: EventDispatcherOptions;
  private readonly debounceMap = new Map<string, DebounceEntry>();
  /** Talks with an event job currently executing — prevent concurrent runs per talk. */
  private readonly runningTalks = new Set<string>();

  constructor(opts: EventDispatcherOptions) {
    this.opts = opts;
  }

  /**
   * Handle an incoming message_received event from OpenClaw.
   * Scans all Talks for matching event jobs and triggers them.
   */
  async handleMessageReceived(
    event: MessageReceivedEvent,
    ctx: MessageContext,
  ): Promise<void> {
    const { store, logger } = this.opts;

    const allJobs = store.getAllActiveJobs();
    if (allJobs.length === 0) return;

    for (const { talkId, job } of allJobs) {
      // Only consider event-type jobs
      const scope = parseEventTrigger(job.schedule);
      if (!scope) continue;
      if (job.type !== 'event') continue;

      // Match the event against this Talk's platform bindings
      const meta = store.getTalk(talkId);
      if (!meta) continue;

      const bindings = meta.platformBindings ?? [];
      const matchingBinding = bindings.find(
        b => b.scope.toLowerCase() === scope.toLowerCase(),
      );
      if (!matchingBinding) continue;

      // Match the binding's platform against the event's channel ID
      // channelId from OpenClaw is the platform identifier (e.g. "slack", "telegram")
      if (matchingBinding.platform.toLowerCase() !== ctx.channelId.toLowerCase()) continue;

      // Debounce: skip if this job fired too recently
      const debounceKey = `${talkId}:${job.id}`;
      const debounceEntry = this.debounceMap.get(debounceKey);
      const now = Date.now();
      if (debounceEntry && now - debounceEntry.lastFiredAt < EVENT_JOB_DEBOUNCE_MS) {
        logger.debug(`EventDispatcher: debounced job ${job.id} for talk ${talkId}`);
        continue;
      }

      // Prevent concurrent event runs on the same talk
      if (this.runningTalks.has(talkId)) {
        logger.debug(`EventDispatcher: talk ${talkId} already running an event job, skipping`);
        continue;
      }

      // Only reply if binding has write permission
      const canReply = matchingBinding.permission === 'write' || matchingBinding.permission === 'read+write';

      // Fire the job
      this.debounceMap.set(debounceKey, { lastFiredAt: now });
      this.runningTalks.add(talkId);

      logger.info(
        `EventDispatcher: triggering job ${job.id} for talk ${talkId} ` +
        `(${matchingBinding.platform}/${scope}, from: ${event.from})`,
      );

      this.executeEventJob(talkId, job, event, ctx, matchingBinding.platform, canReply)
        .finally(() => {
          this.runningTalks.delete(talkId);
        });
    }
  }

  private async executeEventJob(
    talkId: string,
    job: TalkJob,
    event: MessageReceivedEvent,
    ctx: MessageContext,
    platform: string,
    canReply: boolean,
  ): Promise<void> {
    const { logger } = this.opts;

    // Build trigger context that will be injected into the job prompt
    const timestamp = event.timestamp
      ? new Date(event.timestamp).toISOString().replace('T', ' ').slice(0, 19)
      : new Date().toISOString().replace('T', ' ').slice(0, 19);

    const senderName = (event.metadata?.senderName ?? event.metadata?.senderUsername ?? event.from) as string;

    const triggerContext = [
      '## Event Trigger',
      `Platform: ${platform}`,
      `Source: ${parseEventTrigger(job.schedule)}`,
      `From: ${senderName}`,
      `Time: ${timestamp}`,
      `Content: ${event.content}`,
      '',
      'Your response will be automatically delivered to the channel. Just respond naturally.',
    ].join('\n');

    try {
      // Reuse the shared executeJob from job-scheduler with trigger context
      const schedulerOpts: JobSchedulerOptions = {
        store: this.opts.store,
        gatewayOrigin: this.opts.gatewayOrigin,
        authToken: this.opts.authToken,
        logger: this.opts.logger,
        registry: this.opts.registry,
        executor: this.opts.executor,
        dataDir: this.opts.dataDir,
        jobTimeoutMs: this.opts.jobTimeoutMs,
      };

      const report = await executeJob(schedulerOpts, talkId, job, triggerContext);

      // Deliver reply back to the originating platform if enabled
      if (report && report.status === 'success' && canReply && this.opts.replyToEvent) {
        const platformChannelId = extractPlatformChannelId(event.from);
        const threadId = event.metadata?.threadId as string | undefined;

        const target: EventReplyTarget = {
          platform,
          accountId: ctx.accountId,
          platformChannelId,
          threadId,
        };

        try {
          const sent = await this.opts.replyToEvent(target, report.fullOutput);
          if (sent) {
            logger.info(`EventDispatcher: reply delivered to ${platform}/${platformChannelId}`);
          } else {
            logger.warn(`EventDispatcher: reply delivery returned false for ${platform}/${platformChannelId}`);
          }
        } catch (replyErr) {
          const msg = replyErr instanceof Error ? replyErr.message : String(replyErr);
          logger.warn(`EventDispatcher: reply delivery failed: ${msg}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`EventDispatcher: job ${job.id} for talk ${talkId} failed: ${msg}`);
    }
  }

  /**
   * Clean up stale debounce entries (called periodically or on stop).
   */
  cleanup(): void {
    const cutoff = Date.now() - EVENT_JOB_DEBOUNCE_MS * 10;
    for (const [key, entry] of this.debounceMap) {
      if (entry.lastFiredAt < cutoff) {
        this.debounceMap.delete(key);
      }
    }
  }
}

/**
 * Extract the platform-specific channel ID from an event `from` string.
 * Examples:
 *   "slack:channel:C01CL1PU022" → "C01CL1PU022"
 *   "slack:U12345"              → "U12345"
 *   "telegram:group:-123456"    → "-123456"
 */
function extractPlatformChannelId(from: string): string | undefined {
  // Format: "platform:type:id" or "platform:id"
  const parts = from.split(':');
  if (parts.length >= 3) return parts.slice(2).join(':');
  if (parts.length === 2) return parts[1];
  return undefined;
}
