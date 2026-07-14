/**
 * Local type surface for `serve-sim/middleware`.
 *
 * The published package maps its `types` to `src/middleware.ts`, but that file
 * imports sibling modules the package does not ship (device-session, debug,
 * exec-ws, …) and uses extensionless relative imports, so it cannot be
 * consumed under NodeNext resolution. This declaration mirrors the exported
 * API we use, transcribed from the real source (v0.1.x).
 */
declare module "serve-sim/middleware" {
  import type { IncomingMessage, ServerResponse } from "node:http";
  import type { Duplex } from "node:stream";

  export type SimMiddleware = {
    (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void): void;
    /** Wire this to the HTTP server's `upgrade` event for the control WebSocket. */
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  };

  export interface SimMiddlewareOptions {
    /** Mount point for the preview UI (default "/.sim"). */
    basePath?: string;
    /** Proxy helper endpoints through this server (single-port setups). */
    proxyHelpers?: boolean;
    /** Pin the preview to a specific simulator udid. */
    device?: string;
    /** Override the per-process token protecting the /exec endpoint. */
    execToken?: string;
  }

  export function simMiddleware(options?: SimMiddlewareOptions): SimMiddleware;
}
