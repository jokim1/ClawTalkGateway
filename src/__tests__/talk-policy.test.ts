import { evaluateToolAvailability } from '../talk-policy';

describe('talk policy availability reasons', () => {
  test('marks uninstalled tools as blocked_not_installed', () => {
    const states = evaluateToolAvailability(
      [{ name: 'google_docs_add_tab', description: 'tab tool', builtin: true }],
      {
        executionMode: 'openclaw',
        filesystemAccess: 'full_host_access',
        networkAccess: 'full_outbound',
        toolsAllow: [],
        toolsDeny: [],
        toolMode: 'auto',
      },
      {
        isInstalled: () => false,
      },
    );
    expect(states[0]?.enabled).toBe(false);
    expect(states[0]?.reasonCode).toBe('blocked_not_installed');
  });

  test('marks tools blocked_execution_mode in openclaw mode', () => {
    const states = evaluateToolAvailability(
      [{ name: 'google_docs_create', description: 'docs', builtin: true }],
      {
        executionMode: 'openclaw',
        filesystemAccess: 'full_host_access',
        networkAccess: 'full_outbound',
        toolsAllow: [],
        toolsDeny: [],
        toolMode: 'off',
      },
      {
        isInstalled: () => true,
      },
    );
    expect(states[0]?.enabled).toBe(false);
    expect(states[0]?.reasonCode).toBe('blocked_execution_mode');
  });

  test('marks tools blocked_tool_mode when approval is off in full_control mode', () => {
    const states = evaluateToolAvailability(
      [{ name: 'google_docs_create', description: 'docs', builtin: true }],
      {
        executionMode: 'full_control',
        filesystemAccess: 'full_host_access',
        networkAccess: 'full_outbound',
        toolsAllow: [],
        toolsDeny: [],
        toolMode: 'off',
      },
      {
        isInstalled: () => true,
      },
    );
    expect(states[0]?.enabled).toBe(false);
    expect(states[0]?.reasonCode).toBe('blocked_tool_mode');
  });

  test('does not treat google docs tab tools as browser tools in full_control mode', () => {
    const states = evaluateToolAvailability(
      [{ name: 'google_docs_list_tabs', description: 'docs tabs', builtin: true }],
      {
        executionMode: 'full_control',
        filesystemAccess: 'full_host_access',
        networkAccess: 'full_outbound',
        toolsAllow: [],
        toolsDeny: [],
        toolMode: 'auto',
      },
      {
        isInstalled: () => true,
      },
    );
    expect(states[0]?.enabled).toBe(true);
    expect(states[0]?.reasonCode).toBeUndefined();
  });
});
