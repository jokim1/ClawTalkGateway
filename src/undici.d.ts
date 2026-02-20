/**
 * Minimal type declarations for Node.js built-in undici.
 *
 * Node.js bundles undici internally, so the runtime import works. This file
 * provides the type information TypeScript needs without requiring the undici
 * npm package to be installed.
 */
declare module 'undici' {
  import type { IncomingHttpHeaders } from 'node:http';

  export interface AgentOptions {
    headersTimeout?: number;
    bodyTimeout?: number;
    keepAliveTimeout?: number;
    keepAliveMaxTimeout?: number;
    connections?: number;
    pipelining?: number;
  }

  export class Agent {
    constructor(opts?: AgentOptions);
    close(): Promise<void>;
    destroy(): Promise<void>;
  }

  export interface RequestOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer | Uint8Array;
    headersTimeout?: number;
    bodyTimeout?: number;
    dispatcher?: Agent;
  }

  export interface ResponseData {
    statusCode: number;
    headers: IncomingHttpHeaders;
    body: {
      text(): Promise<string>;
      json(): Promise<unknown>;
      arrayBuffer(): Promise<ArrayBuffer>;
    };
  }

  export function request(url: string, opts?: RequestOptions): Promise<ResponseData>;
}
