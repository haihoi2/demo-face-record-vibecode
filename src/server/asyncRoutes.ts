/**
 * Express 4 ignores the promise an async route handler returns. If it rejects,
 * the rejection goes unhandled and Node terminates the process - the whole
 * gateway, gate watchers included - because of one failed query or request.
 *
 * guardAsyncRoutes() wraps every handler registered through app.get/post/put/
 * patch/delete/use so a rejection (or a synchronous throw) is passed to
 * next(err), where the JSON error handler answers 500 and the process lives.
 */
import type { Application, NextFunction, Request, Response } from "express";

type Handler = (...args: any[]) => unknown;

export function guardHandler(handler: Handler): Handler {
  // Error middleware has four parameters; Express tells them apart by arity.
  if (typeof handler !== "function" || handler.length >= 4) return handler;
  const guarded = function (this: unknown, req: Request, res: Response, next: NextFunction) {
    try {
      const result = handler.call(this, req, res, next) as any;
      if (result && typeof result.then === "function") result.then(undefined, next);
      return result;
    } catch (err) {
      next(err);
    }
  };
  Object.defineProperty(guarded, "length", { value: 3 });
  return guarded;
}

const guardAll = (args: unknown[]) =>
  args.map((a) => (Array.isArray(a) ? a.map((h) => guardHandler(h as Handler)) : typeof a === "function" ? guardHandler(a as Handler) : a));

export function guardAsyncRoutes(app: Application): void {
  for (const method of ["get", "post", "put", "patch", "delete", "use"] as const) {
    const original = (app as any)[method].bind(app);
    (app as any)[method] = (...args: unknown[]) => {
      // app.get("setting") with a single string is a settings read, not a route.
      if (method === "get" && args.length === 1 && typeof args[0] === "string") return original(...args);
      return original(...guardAll(args));
    };
  }
}

/** Last in the chain: any error that reached here becomes a JSON 500. */
export function jsonErrorHandler(err: any, req: Request, res: Response, next: NextFunction): void {
  console.error(`[HTTP] Lỗi xử lý ${req.method} ${req.path}:`, err?.message || err);
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({ success: false, error: "Lỗi máy chủ khi xử lý yêu cầu" });
}
