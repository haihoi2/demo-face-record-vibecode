/**
 * The signed-in operator, shared across the app.
 *
 * OperatorSessionBar owns sign-in and writes here; any component reads it with
 * useOperatorSession() to decide what to SHOW. It never decides what is
 * ALLOWED - the server checks every request against the live account, so a
 * hidden button is a courtesy, not a control.
 */
import { useSyncExternalStore } from "react";
import type { OperatorRole, OperatorSessionInfo } from "./api";

let current: OperatorSessionInfo | null = null;
const listeners = new Set<() => void>();

export function getOperatorSession(): OperatorSessionInfo | null {
  return current;
}

export function setOperatorSession(session: OperatorSessionInfo | null): void {
  current = session;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOperatorSession(): OperatorSessionInfo | null {
  return useSyncExternalStore(subscribe, getOperatorSession, getOperatorSession);
}

const RANK: Record<OperatorRole, number> = { viewer: 0, operator: 1, admin: 2 };

/** Same nesting as the server: admin > operator > viewer. Signed out = nothing. */
export function hasRole(session: OperatorSessionInfo | null, required: OperatorRole): boolean {
  return Boolean(session) && RANK[session!.role] >= RANK[required];
}

export const ROLE_BADGE: Record<OperatorRole, { label: string; className: string }> = {
  admin: { label: "Quản trị", className: "bg-indigo-100 text-indigo-800 border-indigo-200" },
  operator: { label: "Vận hành", className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  viewer: { label: "Chỉ xem", className: "bg-slate-100 text-slate-700 border-slate-200" },
};

/**
 * Requests from anywhere in the UI (the top-bar user menu) to the dialog host
 * (OperatorSessionBar, mounted once in App): open sign-in or change-password.
 */
export type SessionUiRequest = "login" | "password";
const uiListeners = new Set<(request: SessionUiRequest) => void>();

export function requestSessionUi(request: SessionUiRequest): void {
  for (const listener of uiListeners) listener(request);
}

export function onSessionUiRequest(listener: (request: SessionUiRequest) => void): () => void {
  uiListeners.add(listener);
  return () => uiListeners.delete(listener);
}
