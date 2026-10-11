import type { RichTextImage } from "../../domain/richText";

/** Storage is supplied by the caller; the editor owns no workspace or file database. */
export interface RichTextImageStorage {
  upload(files: File[]): Promise<RichTextImage[]>;
  resolve?(id: string): Promise<Blob>;
}
