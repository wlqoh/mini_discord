import { useState } from "react";
import type { LinkPreview } from "../types/chat.ts";
import { embedImageUrl, hostFromUrl } from "../services/links.ts";

type Props = {
    preview: LinkPreview;
};

export default function LinkPreviewCard({ preview }: Props) {
    // Картинка может отвалиться уже после рендера (сайт отдал 404, прокси не
    // достучался) — тогда прячем миниатюру, а не показываем битую иконку.
    const [isImageBroken, setIsImageBroken] = useState(false);

    const imageSrc = preview.image_token && !isImageBroken ? embedImageUrl(preview.image_token) : "";
    const siteLabel = preview.site_name || hostFromUrl(preview.url);

    return (
        <a
            className="link-preview"
            href={preview.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
        >
            <span className="link-preview-body">
                <span className="link-preview-site">{siteLabel}</span>
                {preview.title ? <span className="link-preview-title">{preview.title}</span> : null}
                {preview.description ? <span className="link-preview-desc">{preview.description}</span> : null}
            </span>
            {imageSrc ? (
                <img
                    className="link-preview-thumb"
                    src={imageSrc}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    onError={() => setIsImageBroken(true)}
                />
            ) : null}
        </a>
    );
}
