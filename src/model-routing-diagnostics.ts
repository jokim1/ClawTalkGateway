import * as fs from 'node:fs/promises';
import * as path from 'node:path';

type AgentEntry = {
  id?: string;
  name?: string;
  model?: string;
  default?: boolean;
};

type OpenClawConfig = {
  agents?: {
    list?: AgentEntry[];
    defaults?: {
      model?: {
        primary?: string;
      };
    };
  };
};

export type RoutingDiagnostics = {
  requestedModel: string;
  headerAgentId?: string;
  configuredAgentId?: string;
  configuredAgentModel?: string;
  defaultAgentId?: string;
  defaultAgentModel?: string;
  matchedRequestedModelAgentId?: string;
  matchedRequestedModelAgentModel?: string;
  notes: string[];
};

function pickDefaultAgent(agents: AgentEntry[]): AgentEntry | undefined {
  return (
    agents.find((agent) => agent.default === true)
    ?? agents.find((agent) => (agent.id ?? '').trim().toLowerCase() === 'main')
    ?? agents[0]
  );
}

function findAgentById(agents: AgentEntry[], id: string): AgentEntry | undefined {
  const key = id.trim().toLowerCase();
  return agents.find((agent) => (agent.id ?? '').trim().toLowerCase() === key);
}

export async function collectRoutingDiagnostics(params: {
  requestedModel: string;
  headerAgentId?: string;
}): Promise<RoutingDiagnostics> {
  const notes: string[] = [];
  const result: RoutingDiagnostics = {
    requestedModel: params.requestedModel,
    headerAgentId: params.headerAgentId,
    notes,
  };

  const home = process.env.HOME?.trim();
  if (!home) {
    notes.push('missing-home');
    return result;
  }

  const configPath = path.join(home, '.openclaw', 'openclaw.json');
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf-8');
  } catch {
    notes.push('config-read-failed');
    return result;
  }

  let cfg: OpenClawConfig;
  try {
    cfg = JSON.parse(raw) as OpenClawConfig;
  } catch {
    notes.push('config-parse-failed');
    return result;
  }

  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents?.list ?? [] : [];
  const defaultAgent = pickDefaultAgent(agents);
  const defaultAgentModel = defaultAgent?.model?.trim() || cfg.agents?.defaults?.model?.primary?.trim();
  const requested = params.requestedModel.trim().toLowerCase();
  const requestedMatch = agents.find(
    (agent) => (agent.model ?? '').trim().toLowerCase() === requested,
  );
  if (defaultAgent?.id?.trim()) {
    result.defaultAgentId = defaultAgent.id.trim();
  }
  if (defaultAgentModel) {
    result.defaultAgentModel = defaultAgentModel;
  }
  if (requestedMatch?.id?.trim()) {
    result.matchedRequestedModelAgentId = requestedMatch.id.trim();
    if (requestedMatch.model?.trim()) {
      result.matchedRequestedModelAgentModel = requestedMatch.model.trim();
    }
  } else {
    notes.push('no-agent-model-match');
  }

  if (params.headerAgentId?.trim()) {
    const mapped = findAgentById(agents, params.headerAgentId);
    if (!mapped) {
      notes.push('header-agent-not-found');
      return result;
    }
    if (mapped.id?.trim()) {
      result.configuredAgentId = mapped.id.trim();
    }
    if (mapped.model?.trim()) {
      result.configuredAgentModel = mapped.model.trim();
    }
    return result;
  }

  if (defaultAgent?.id?.trim()) {
    result.configuredAgentId = defaultAgent.id.trim();
  }
  if (defaultAgentModel) {
    result.configuredAgentModel = defaultAgentModel;
  } else {
    notes.push('default-agent-model-missing');
  }
  return result;
}
