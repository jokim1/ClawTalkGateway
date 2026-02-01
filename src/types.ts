/**
 * Type definitions for RemoteClaw Gateway Plugin
 */

// Moltbot Plugin API (subset we use)
export interface MoltbotPluginApi {
  logger: Logger;
  config: MoltbotConfig;
  runtime: {
    tts: {
      textToSpeech(options: { text: string; voice?: string; model?: string; speed?: number }): Promise<{ audioBuffer: Buffer }>;
    };
    stt: {
      transcribe(options: { audioBuffer: Buffer; language?: string; model?: string }): Promise<{ text: string; language?: string; duration?: number }>;
    };
  };
  registerCli(fn: (ctx: { program: any }) => void, options?: { commands?: string[] }): void;
  registerRoute(method: string, path: string, handler: RouteHandler): void;
}

export interface Logger {
  info(msg: string, ...args: any[]): void;
  warn(msg: string, ...args: any[]): void;
  error(msg: string, ...args: any[]): void;
  debug(msg: string, ...args: any[]): void;
}

export interface MoltbotConfig {
  agents?: Record<string, any>;
  models?: Record<string, any>;
  plugins?: Record<string, PluginConfig>;
}

export interface PluginConfig {
  proxyPort?: number;
  providers?: Record<string, ProviderBillingConfig>;
  voice?: VoicePluginConfig;
}

export interface ProviderBillingConfig {
  billing: 'api' | 'subscription';
  plan?: string;
  monthlyPrice?: number;
}

export interface VoicePluginConfig {
  stt?: {
    provider?: string;
    model?: string;
  };
  tts?: {
    provider?: string;
    model?: string;
    defaultVoice?: string;
  };
}

export type RouteHandler = (req: IncomingRequest, res: OutgoingResponse) => void | Promise<void>;

// Minimal HTTP types (compatible with Node http.IncomingMessage / http.ServerResponse)
export interface IncomingRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string>;
  pipe(destination: any): any;
  on(event: string, listener: (...args: any[]) => void): this;
}

export interface OutgoingResponse {
  statusCode: number;
  setHeader(name: string, value: string | number): void;
  end(data?: string | Buffer): void;
  write(data: string | Buffer): void;
}
