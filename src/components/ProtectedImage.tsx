import React, { useEffect, useState } from "react";
import { apiFetch } from "../utils/api";

type ProtectedImageProps = Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src?: string | null;
};

/** Fetches cookie-protected image bytes without exposing the URL to an unauthenticated <img>. */
export const ProtectedImage: React.FC<ProtectedImageProps> = ({ src, alt = "", ...props }) => {
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

    const load = async () => {
      try {
        const response = await apiFetch(src, { method: "GET" });
        if (!response.ok) return;
        const blob = await response.blob();
        if (!blob.type.startsWith("image/") || !active) return;
        objectUrl = URL.createObjectURL(blob);
        if (active) setBlobUrl(objectUrl);
      } catch {
        // Rendering remains empty when authentication or transport fails.
      }
    };
    void load();

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  if (!blobUrl) return <span role="img" aria-label={alt} {...({ className: props.className } as any)} />;
  return <img src={blobUrl} alt={alt} {...props} />;
};
