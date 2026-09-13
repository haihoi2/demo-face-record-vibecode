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
  // 1. Custom URL configured by user
  const custom = getCustomBackendUrl();
  if (custom) {
    return custom;
  }

  // 2. VITE_API_URL environment variable
  const envUrl = (((import.meta as any).env?.VITE_API_URL as string) || "").trim();
  if (envUrl) {
    return envUrl.replace(/\/+$/, "");
  }

  // 3. Default to relative path (same-origin)
  return "";
}

/**
 * Normalizes API endpoint URLs ensuring correct leading slash and structure,
 * preventing relative path 404s when navigating or querying.
 * Prepends VITE_API_URL if configured.
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

export async function safeJsonFetch<T = any>(
  url: string,
  options?: RequestInit,
  fallback?: T
): Promise<{ ok: boolean; status: number; data: T; error?: string }> {
  const normalizedUrl = normalizeApiUrl(url);

  try {
    const res = await fetch(normalizedUrl, options);
    return await parseJsonResponse<T>(res, fallback);
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
