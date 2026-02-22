import { homedir } from 'node:os';
import * as path from 'node:path';

export const DEFAULT_GATEWAY_PORT = 18789;
export const OPENCLAW_HOME = process.env.HOME?.trim() || homedir();
export const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_HOME, '.openclaw', 'openclaw.json');
