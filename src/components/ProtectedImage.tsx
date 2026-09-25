import React, { useEffect, useState } from "react";
import { apiFetch } from "../utils/api";

type ProtectedImageProps = Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src?: string | null;
  /** Tried once if `src` cannot be loaded, replacing a bare <img> onError chain. */
  fallbackSrc?: string | null;
};

/**
 * Only for single-shot responses. A continuous multipart stream (MJPEG) never
 * finishes, so it must stay a plain <img>; so must any URL on a host other than
 * this API, which has no business receiving the operator cookie.
 */

/** Fetches cookie-protected image bytes without exposing the URL to an unauthenticated <img>. */
export const ProtectedImage: React.FC<ProtectedImageProps> = ({ src, fallbackSrc, alt = "", ...props }) => {
  const [blobUrl, setBlobUrl] = useState<string>("");

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    setBlobUrl("");
    if (!src) return () => { active = false; };

    // An inline data:/blob: source is already the bytes - fetching it would add a
    // round trip and a failure mode for no gain. Only a server path needs the
    // operator cookie, and employee photoUrl is either shape depending on whether
    // the record was registered from an upload or adopted from a stranger sighting.
    if (/^(?:data|blob):/i.test(src)) {
      setBlobUrl(src);
      return () => { active = false; };
    }

    const fetchImage = async (url: string): Promise<string | null> => {
      const response = await apiFetch(url, { method: "GET" });
      if (!response.ok) return null;
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) return null;
      return URL.createObjectURL(blob);
    };

    const load = async () => {
      for (const candidate of [src, fallbackSrc]) {
        if (!candidate || !active) return;
        try {
          const url = await fetchImage(candidate);
          if (!url) continue;
          if (!active) {
            URL.revokeObjectURL(url);
            return;
          }
          objectUrl = url;
          setBlobUrl(url);
          return;
        } catch {
          // Try the fallback; rendering stays empty if neither loads.
        }
      }
    };
    void load();

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, fallbackSrc]);

  if (!blobUrl) return <span role="img" aria-label={alt} {...({ className: props.className } as any)} />;
  return <img src={blobUrl} alt={alt} {...props} />;
};
