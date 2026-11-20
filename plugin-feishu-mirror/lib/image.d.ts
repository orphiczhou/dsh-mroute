/**
 * Image media-type sniffing — pure byte arithmetic, no dsh or Lark imports.
 *
 * Feishu image messages carry only an opaque `image_key`; the resource
 * download returns raw bytes with no declared MIME. The attachment service
 * requires a caller-declared media type VERIFIED against the decoded bytes,
 * so the type must come from the bytes themselves (a wrong declaration fails
 * admission and the image never reaches the session).
 */
/** The media types the dsh attachment path accepts (structural — mirrors dsh-attachment). */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
/**
 * Sniff the media type from image magic bytes; undefined for anything the
 * attachment path does not accept (sticker-like formats, truncated payloads).
 */
export declare function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | undefined;
/** File-extension for an accepted media type (display name for the attachment). */
export declare function imageExtensionOf(mediaType: ImageMediaType): string;
