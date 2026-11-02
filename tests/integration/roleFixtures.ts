/**
 * A throwaway named account with a given role, for tests that need to prove
 * the admin / operator split (the environment OPERATOR_TOKEN session is an
 * admin, so it cannot stand in for an operator). Created through the admin
 * accounts API and removed again by `dispose()`.
 */
import { randomBytes } from "node:crypto";

import { apiAs, authenticateAs, loginWithPassword } from "./helpers";

const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN || "integration-operator-token";
export const FIXTURE_PASSWORD = "integration pass 1";

export interface RoleUser {
  cookie: string;
  username: string;
  id: string;
  dispose: () => Promise<void>;
}

export async function createRoleUser(role: "admin" | "operator" | "viewer"): Promise<RoleUser> {
  const bootstrap = await authenticateAs(OPERATOR_TOKEN);
  const username = `it-${role.slice(0, 3)}-${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  const created = await apiAs<any>(bootstrap, "/api/users", {
    method: "POST",
    body: JSON.stringify({ username, displayName: `ITEST ${role}`, role, password: FIXTURE_PASSWORD }),
  });
  if (created.status !== 201 || !created.body?.user?.id) {
    throw new Error(`creating the ${role} fixture failed: HTTP ${created.status} ${created.text.slice(0, 200)}`);
  }
  const login = await loginWithPassword(username, FIXTURE_PASSWORD);
  if (login.status !== 200 || !login.cookie) {
    throw new Error(`signing in the ${role} fixture failed: HTTP ${login.status} ${login.text.slice(0, 200)}`);
  }
  const id = created.body.user.id as string;
  return {
    cookie: login.cookie,
    username,
    id,
    dispose: async () => {
      await apiAs(bootstrap, `/api/users/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
  };
}
