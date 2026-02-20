/**
 * Quick test: simulates what a user would see at Gateway startup.
 * Run with: npx tsx test-setup-flow.ts
 */

import { checkSlackProxySetup, logSlackProxySetupStatus } from './src/slack-proxy-setup.js';
import type { TalkStore } from './src/talk-store.js';

// Mock logger that prints to console
const logger = {
  debug: (msg: string) => console.log(`[DEBUG] ${msg}`),
  info: (msg: string) => console.log(`[INFO]  ${msg}`),
  warn: (msg: string) => console.log(`[WARN]  ${msg}`),
  error: (msg: string) => console.log(`[ERROR] ${msg}`),
};

// Mock TalkStore
function mockStore(talks: any[]): TalkStore {
  return {
    listTalks: () => talks,
    getInstanceId: () => 'test',
  } as any;
}

// ----- Scenario 1: No Slack bindings -----
console.log('\n=== Scenario 1: No Slack bindings ===\n');
logSlackProxySetupStatus(mockStore([]), {}, logger);

// ----- Scenario 2: Slack bindings but NO signing secret -----
console.log('\n=== Scenario 2: Slack bindings, missing signing secret ===\n');
const talkWithSlack = {
  id: 'talk-1',
  name: 'Coach Kimi',
  executionMode: 'full_control',
  platformBindings: [{
    id: 'binding-1',
    platform: 'slack',
    permission: 'read+write',
    scope: 'slack:channel:C123',
    accountId: 'default',
  }],
};
logSlackProxySetupStatus(mockStore([talkWithSlack]), {}, logger);

// ----- Scenario 3: Slack bindings WITH signing secret -----
console.log('\n=== Scenario 3: Slack bindings, signing secret configured ===\n');
const cfgWithSecret = {
  channels: { slack: { signingSecret: 'abc123fake' } },
};
logSlackProxySetupStatus(mockStore([talkWithSlack]), cfgWithSecret, logger);

// ----- Scenario 4: JSON API response -----
console.log('\n=== Scenario 4: /api/events/slack/proxy-setup response (no secret) ===\n');
const apiResponse = checkSlackProxySetup(mockStore([talkWithSlack]), {});
console.log(JSON.stringify(apiResponse, null, 2));

console.log('\n=== Scenario 5: /api/events/slack/proxy-setup response (with secret) ===\n');
const apiResponse2 = checkSlackProxySetup(mockStore([talkWithSlack]), cfgWithSecret);
console.log(JSON.stringify(apiResponse2, null, 2));
