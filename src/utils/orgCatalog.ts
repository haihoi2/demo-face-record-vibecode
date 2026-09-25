/**
 * Managed departments (phòng ban) and positions (chức vụ).
 *
 * The server owns the list and refuses an employee whose department or
 * position is not an active entry, so every form that creates an employee
 * offers exactly this list.
 */
import { useCallback, useEffect, useState } from "react";
import { operatorJsonFetch } from "./api";

export type OrgKind = "departments" | "positions";

export interface OrgEntry {
  id: string;
  name: string;
  description: string;
  active: boolean;
  employeeCount: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

export const ORG_KIND_LABEL: Record<OrgKind, string> = {
  departments: "Phòng ban",
  positions: "Chức vụ",
};

export function useOrgCatalog() {
  const [departments, setDepartments] = useState<OrgEntry[]>([]);
  const [positions, setPositions] = useState<OrgEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await operatorJsonFetch<{ success: boolean; departments: OrgEntry[]; positions: OrgEntry[]; error?: string }>(
      "/api/org"
    );
    if (res.ok && res.data?.success) {
      setDepartments(res.data.departments);
      setPositions(res.data.positions);
      setError(null);
    } else {
      setError((res.data as any)?.error || res.error || `Không tải được danh mục (HTTP ${res.status})`);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { departments, positions, loading, error, reload };
}

/** Active names, the only values the server accepts for a new employee. */
export function orgOptions(entries: OrgEntry[]): string[] {
  return entries.filter((e) => e.active).map((e) => e.name);
}

/** `current` if it is still offered, otherwise the first offered value (or "" while loading). */
export function orgChoice(options: string[], current: string): string {
  return options.includes(current) ? current : options[0] || "";
}
