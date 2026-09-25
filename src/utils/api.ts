/**
 * Safe API response parser and fetch helper.
 * Prevents "Unexpected token '<', '<!DOCTYPE '... is not valid JSON" errors
 * by checking content type and response body before parsing.
 */

export async function parseJsonResponse<T = any>(
  res: Response,
  fallback?: T
): Promise<{ ok: boolean; status: number; data: T; error?: string }> {
  const status = res.status;
  const contentType = res.headers.get("content-type") || "";

  try {
    const text = await res.text();

    // Check if the response is HTML (e.g., 404, 500, 502, 413, or SPA fallback index.html)
    if (!text || !text.trim()) {
      return {
        ok: res.ok,
        status,
        data: fallback as T,
        error: res.ok ? undefined : `Máy chủ phản hồi rỗng (HTTP ${status})`,
      };
    }

    const trimmed = text.trim();
    if (trimmed.startsWith("<") || contentType.includes("text/html")) {
      console.warn(
        `[API] Server returned HTML instead of JSON for ${res.url} (status: ${status} ${res.statusText})`
      );
      return {
        ok: false,
        status,
        data: fallback as T,
        error: `Máy chủ trả về trang lỗi HTML (HTTP ${status} ${res.statusText || ""})`,
      };
    }

    const parsed = JSON.parse(trimmed) as T;
    return {
      ok: res.ok,
      status,
      data: parsed,
      error: res.ok
        ? undefined
        : (parsed as any)?.error || `Lỗi yêu cầu (HTTP ${status})`,
    };
  } catch (err: any) {
    console.warn(`[API] Could not parse JSON for ${res.url}:`, err?.message);
    return {
      ok: false,
      status,
      data: fallback as T,
      error: err?.message || `Lỗi phân tích dữ liệu JSON (HTTP ${status})`,
    };
  }
}

export const STORAGE_KEY_CUSTOM_BACKEND = "smartlock_custom_backend_url";
let sessionCsrfToken = "";

export function clearSessionCsrfToken(): void {
  sessionCsrfToken = "";
}

/**
 * Retrieves user-defined custom backend URL from localStorage (if configured in UI).
 */
export function getCustomBackendUrl(): string {
  if (typeof window === "undefined") return "";
  try {
    return (localStorage.getItem(STORAGE_KEY_CUSTOM_BACKEND) || "").trim().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/**
 * Persists user-defined custom backend URL in localStorage.
 */
export function setCustomBackendUrl(url: string): void {
  if (typeof window === "undefined") return;
  try {
    const cleaned = url.trim().replace(/\/+$/, "");
    if (cleaned) {
      localStorage.setItem(STORAGE_KEY_CUSTOM_BACKEND, cleaned);
    } else {
      localStorage.removeItem(STORAGE_KEY_CUSTOM_BACKEND);
    }
  } catch {}
}

/**
 * Retrieves the external backend API base URL.
 * Priority:
 * 1. User-configured custom URL in UI (stored in localStorage)
 * 2. Environment variable VITE_API_URL (set on Netlify / build)
 * 3. Default: empty string (same-origin relative paths)
 *
 * NOTE: When deployed to Netlify without a custom backend, returning empty string
 * prevents the browser from sending unauthorized cross-origin preflight requests
 * to private development sandbox containers (which cause CORS net::ERR_INVALID_REDIRECT).
 */
export function getApiBaseUrl(): string {
  const custom = getCustomBackendUrl();
  if (custom) {
    return custom;
  }

  const env = (import.meta as any).env || {};
  const envUrl = String(env.VITE_API_BASE_URL || env.VITE_API_URL || "").trim();
  if (envUrl) {
    return envUrl.replace(/\/+$/, "");
  }

  return "";
}

/**
 * Normalizes API endpoint URLs ensuring correct leading slash and structure,
 * preventing relative path 404s when navigating or querying.
 * Prepends the configured external API base URL if present.
 */
export function normalizeApiUrl(rawUrl: string): string {
  if (!rawUrl) return "/api/health";
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
    return rawUrl;
  }
  let path = rawUrl.trim();
  if (path.startsWith("api/")) {
    path = "/" + path;
  } else if (!path.startsWith("/")) {
    path = "/" + path;
  }

  const base = getApiBaseUrl();
  return base ? `${base}${path}` : path;
}

export function buildEventSourceUrl(rawUrl: string): string {
  return normalizeApiUrl(rawUrl);
}

export function normalizeApiAssetUrl(rawUrl: string): string {
  return normalizeApiUrl(rawUrl);
}

function credentialedOptions(options: RequestInit = {}): RequestInit {
  const method = String(options.method || "GET").toUpperCase();
  const headers = new Headers(options.headers);
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && sessionCsrfToken) {
    headers.set("X-CSRF-Token", sessionCsrfToken);
  }
  return { ...options, headers, credentials: options.credentials || "include" };
}

export async function apiFetch(
  url: string,
  options?: RequestInit
): Promise<Response> {
  const normalizedUrl = normalizeApiUrl(url);
  const first = await fetch(normalizedUrl, credentialedOptions(options));
  if (first.status !== 403) return first;
  let code = "";
  try {
    code = String((await first.clone().json())?.code || "");
  } catch {}
  if (code !== "CSRF_REQUIRED") return first;

  const sessionResponse = await fetch(normalizeApiUrl("/api/operator/session"), credentialedOptions());
  if (!sessionResponse.ok) return first;
  try {
    const session = await sessionResponse.json();
    if (typeof session?.csrfToken !== "string" || !session.csrfToken) return first;
    sessionCsrfToken = session.csrfToken;
  } catch {
    return first;
  }
  return fetch(normalizedUrl, credentialedOptions(options));
}

export async function safeJsonFetch<T = any>(
  url: string,
  options?: RequestInit,
  fallback?: T
): Promise<{ ok: boolean; status: number; data: T; error?: string }> {
  const normalizedUrl = normalizeApiUrl(url);

  try {
    const res = await apiFetch(normalizedUrl, options);
    const parsed = await parseJsonResponse<T>(res, fallback);
    const csrfToken = (parsed.data as any)?.csrfToken;
    if (parsed.ok && typeof csrfToken === "string" && csrfToken) sessionCsrfToken = csrfToken;
    if (res.status === 401) sessionCsrfToken = "";
    return parsed;
  } catch (netErr: any) {
    console.warn(`[API Network Warning] ${normalizedUrl}:`, netErr?.message);
    return {
      ok: false,
      status: 0,
      data: fallback as T,
      error: netErr?.message || "Không thể kết nối đến máy chủ",
    };
  }
}

export type OperatorRole = "admin" | "operator" | "viewer";

export interface OperatorSessionInfo {
  actor: string;
  /** Account username; null for the bootstrap token session. */
  username: string | null;
  displayName: string;
  role: OperatorRole;
  roleLabel: string;
  authMethod: "account" | "token";
  expiresAt: string;
}

export type OperatorCredentials = { username: string; password: string } | { token: string };

const toSessionInfo = (d: any): OperatorSessionInfo => ({
  actor: String(d?.actor || ""),
  username: d?.username ?? null,
  displayName: String(d?.displayName || d?.actor || ""),
  role: (["admin", "operator", "viewer"].includes(d?.role) ? d.role : "viewer") as OperatorRole,
  roleLabel: String(d?.roleLabel || ""),
  authMethod: d?.authMethod === "account" ? "account" : "token",
  expiresAt: String(d?.expiresAt || ""),
});

/**
 * How a 401 gets a person signed in. The UI registers a dialog here that
 * resolves true once the person has signed in; the failed request is then
 * retried once. Without one (tests, non-browser callers) the request simply
 * stays rejected rather than blocking on a dialog.
 */
type OperatorLoginResolver = () => Promise<boolean>;
let operatorLoginResolver: OperatorLoginResolver | null = null;
export function setOperatorLoginResolver(resolver: OperatorLoginResolver | null): void {
  operatorLoginResolver = resolver;
}

/** Sign in with an account or the bootstrap token. The server sets an HttpOnly cookie. */
export async function openOperatorSession(credentials: OperatorCredentials): Promise<OperatorSessionInfo> {
  const res = await safeJsonFetch<any>("/api/operator/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });
  if (!res.ok || !res.data?.success) {
    throw new Error(res.data?.error || res.error || "Đăng nhập thất bại");
  }
  return toSessionInfo(res.data);
}

/** Current session, or null when unauthenticated. Never throws. */
export async function readOperatorSession(): Promise<OperatorSessionInfo | null> {
  const res = await safeJsonFetch<any>("/api/operator/session");
  if (!res.ok || !res.data?.success) return null;
  return toSessionInfo(res.data);
}

/** Clear the server session cookie. Requires the session CSRF token. */
export async function closeOperatorSession(): Promise<void> {
  await safeJsonFetch("/api/operator/session", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
  });
  clearSessionCsrfToken();
}

/** Change the signed-in account's own password. Other sessions of the account end. */
export async function changeOwnPassword(currentPassword: string, newPassword: string): Promise<OperatorSessionInfo> {
  const res = await safeJsonFetch<any>("/api/operator/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (!res.ok || !res.data?.success) throw new Error(res.data?.error || res.error || "Đổi mật khẩu thất bại");
  return toSessionInfo(res.data);
}

export async function operatorJsonFetch<T = any>(
  url: string,
  options?: RequestInit,
  fallback?: T,
): Promise<{ ok: boolean; status: number; data: T; error?: string }> {
  const response = await safeJsonFetch<T>(url, options, fallback);
  if (response.status !== 401 || !operatorLoginResolver) return response;
  const signedIn = await operatorLoginResolver();
  if (!signedIn) return response;
  return safeJsonFetch<T>(url, options, fallback);
}

/**
 * Compress an image (File or base64 Data URL) to ensure it stays well under 250KB,
 * preventing HTTP 413 Request Entity Too Large HTML error pages from proxies/Nginx.
 */
export function compressImage(
  fileOrDataUrl: File | string,
  maxWidth = 720,
  maxHeight = 720,
  quality = 0.8
): Promise<string> {
  return new Promise((resolve, reject) => {
    const processImage = (src: string) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        let { width, height } = img;
        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(src);
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);
        const compressedBase64 = canvas.toDataURL("image/jpeg", quality);
        resolve(compressedBase64);
      };
      img.onerror = () => {
        // Fallback to original string if image failed to load in canvas
        resolve(src);
      };
      img.src = src;
    };

    if (typeof fileOrDataUrl === "string") {
      processImage(fileOrDataUrl);
    } else {
      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result as string;
        if (result) {
          processImage(result);
        } else {
          reject(new Error("Không thể đọc tệp hình ảnh"));
        }
      };
      reader.onerror = () => reject(new Error("Lỗi đọc tệp"));
      reader.readAsDataURL(fileOrDataUrl);
    }
  });
}
