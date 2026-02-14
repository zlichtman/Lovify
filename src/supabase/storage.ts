import { supabase } from "./client";

const BUCKET = "mixtape-images";

export async function uploadMixtapeImage(
  file: File,
  mixtapeId: string,
  type: "cover" | "track" | "note" | "background",
): Promise<string | null> {
  if (!supabase) return null;

  const ext = file.name.split(".").pop() ?? "jpg";
  const path = `${mixtapeId}/${type}-${crypto.randomUUID().slice(0, 8)}.${ext}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { cacheControl: "31536000", upsert: false });

  if (error) {
    console.error("Upload error:", error);
    return null;
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Extract the storage path from a Supabase public URL. Returns null for URLs
 * we don't recognize so we never accidentally try to delete the wrong thing.
 *
 * Public URL format:
 *   https://<proj>.supabase.co/storage/v1/object/public/mixtape-images/<path>
 */
export function extractStoragePath(publicUrl: string): string | null {
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const idx = publicUrl.indexOf(marker);
  if (idx < 0) return null;
  return publicUrl.slice(idx + marker.length);
}

export async function deleteStoragePaths(paths: string[]): Promise<void> {
  if (!supabase || !paths.length) return;
  const { error } = await supabase.storage.from(BUCKET).remove(paths);
  if (error) console.error("Storage delete error:", error);
}
