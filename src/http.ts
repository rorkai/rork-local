/**
 * The small slice of express this server actually used: routing with path
 * params, JSON body parsing, and static file serving. Implemented on
 * `node:http` so the published package has no HTTP framework dependency.
 */
import { createReadStream, statSync, type Stats } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

export type RouteContext = {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
};

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
) => void | Promise<void>;

export type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void;

/** Carries an HTTP status so request parsing can reject with the right code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/** Path portion of a request URL, without query string. */
export function requestPath(req: IncomingMessage): string {
  const raw = req.url || "/";
  const queryAt = raw.indexOf("?");
  const pathname = queryAt === -1 ? raw : raw.slice(0, queryAt);
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function requestQuery(req: IncomingMessage): URLSearchParams {
  const raw = req.url || "/";
  const queryAt = raw.indexOf("?");
  return new URLSearchParams(queryAt === -1 ? "" : raw.slice(queryAt + 1));
}

async function readJsonBody(req: IncomingMessage, limitBytes: number): Promise<unknown> {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "DELETE") return undefined;

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) throw new HttpError(413, "Request body too large");
    chunks.push(buf);
  }
  if (size === 0) return undefined;

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

type Route = {
  method: string;
  segments: string[];
  hasParams: boolean;
  handler: RouteHandler;
};

function splitPath(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

function matchRoute(route: Route, method: string, segments: string[]) {
  if (route.method !== method || route.segments.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (const [i, expected] of route.segments.entries()) {
    const actual = segments[i] as string;
    if (expected.startsWith(":")) params[expected.slice(1)] = actual;
    else if (expected !== actual) return null;
  }
  return params;
}

export type Router = {
  use(middleware: Middleware): void;
  get(pattern: string, handler: RouteHandler): void;
  post(pattern: string, handler: RouteHandler): void;
  put(pattern: string, handler: RouteHandler): void;
  delete(pattern: string, handler: RouteHandler): void;
  handle(req: IncomingMessage, res: ServerResponse): void;
};

export function createRouter(options: { bodyLimitBytes: number }): Router {
  const middlewares: Middleware[] = [];
  const routes: Route[] = [];

  const add = (method: string, pattern: string, handler: RouteHandler) => {
    const segments = splitPath(pattern);
    routes.push({
      method,
      segments,
      hasParams: segments.some((s) => s.startsWith(":")),
      handler,
    });
  };

  const dispatch = async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method || "GET";
    const segments = splitPath(requestPath(req));

    // Literal routes win over parameterised ones, so /api/screenshots/deck is
    // never swallowed by /api/screenshots/:kind/:name regardless of order.
    for (const pass of [false, true]) {
      for (const route of routes) {
        if (route.hasParams !== pass) continue;
        const params = matchRoute(route, method, segments);
        if (!params) continue;
        const body = await readJsonBody(req, options.bodyLimitBytes);
        await route.handler(req, res, { params, query: requestQuery(req), body });
        return;
      }
    }

    sendError(res, 404, `Cannot ${method} ${requestPath(req)}`);
  };

  return {
    use(middleware) {
      middlewares.push(middleware);
    },
    get(pattern, handler) {
      add("GET", pattern, handler);
    },
    post(pattern, handler) {
      add("POST", pattern, handler);
    },
    put(pattern, handler) {
      add("PUT", pattern, handler);
    },
    delete(pattern, handler) {
      add("DELETE", pattern, handler);
    },
    handle(req, res) {
      const fail = (err: unknown) => {
        if (res.headersSent) {
          res.end();
          return;
        }
        const status = err instanceof HttpError ? err.status : 500;
        const message = err instanceof Error ? err.message : "Internal error";
        if (status >= 500) console.error("[rork-local]", err);

        // A body rejected mid-upload (over the size limit) leaves bytes in
        // flight on a request we stopped reading. Answering and keeping the
        // connection alive makes the client's next request on that socket fail
        // with ECONNRESET, so close it and let the client open a fresh one.
        if (!req.readableEnded) {
          const payload = JSON.stringify({ error: message });
          res.writeHead(status, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(payload),
            Connection: "close",
          });
          res.end(payload);
          return;
        }
        sendError(res, status, message);
      };

      let index = 0;
      const next = (err?: unknown) => {
        if (err) {
          fail(err);
          return;
        }
        const middleware = middlewares[index++];
        if (!middleware) {
          dispatch(req, res).catch(fail);
          return;
        }
        try {
          middleware(req, res, next);
        } catch (mwErr) {
          fail(mwErr);
        }
      };
      next();
    },
  };
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function statOrNull(file: string): Stats | null {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}

/**
 * Serve `urlPath` from `root`, returning false when there is nothing to send so
 * the caller can fall through. Paths that escape the root are treated as
 * misses rather than errors.
 */
export function serveStatic(
  root: string,
  urlPath: string,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  const rootDir = path.resolve(root);
  const target = path.resolve(rootDir, `.${urlPath.startsWith("/") ? urlPath : `/${urlPath}`}`);
  if (target !== rootDir && !target.startsWith(rootDir + path.sep)) return false;

  let file = target;
  let stats = statOrNull(file);
  if (stats?.isDirectory()) {
    file = path.join(file, "index.html");
    stats = statOrNull(file);
  }
  if (!stats?.isFile()) return false;

  const etag = `W/"${stats.size}-${stats.mtimeMs}"`;
  const headers = {
    "Content-Type": MIME_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
    "Content-Length": stats.size,
    "Last-Modified": stats.mtime.toUTCString(),
    ETag: etag,
  };

  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return true;
  }

  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return true;
  }

  const stream = createReadStream(file);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
  return true;
}
