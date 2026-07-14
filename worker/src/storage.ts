// R2 / S3-compatible upload for finished renders. Returns a public URL.
// Configure with S3-style env vars (works against Cloudflare R2, AWS S3, Supabase S3,
// MinIO, etc.). If no bucket is configured, callers fall back to returning nothing and
// the worker streams the file back inline instead.
import { readFile } from 'node:fs/promises'

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

const {
  R2_ACCOUNT_ID,
  S3_ENDPOINT,
  S3_REGION,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
  S3_BUCKET,
  S3_PUBLIC_BASE_URL
} = process.env

export function storageConfigured(): boolean {
  return !!(S3_BUCKET && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY)
}

let client: S3Client | null = null
function s3(): S3Client {
  if (client) return client
  // Cloudflare R2 endpoint is derived from the account id when S3_ENDPOINT is unset.
  const endpoint =
    S3_ENDPOINT ||
    (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined)
  client = new S3Client({
    region: S3_REGION || 'auto',
    endpoint,
    credentials: {
      accessKeyId: S3_ACCESS_KEY_ID!,
      secretAccessKey: S3_SECRET_ACCESS_KEY!
    }
  })
  return client
}

// Upload a local file and return its public URL.
export async function uploadFile(
  localPath: string,
  key: string,
  contentType = 'video/mp4'
): Promise<string> {
  const body = await readFile(localPath)
  await s3().send(
    new PutObjectCommand({
      Bucket: S3_BUCKET!,
      Key: key,
      Body: body,
      ContentType: contentType
    })
  )
  const base = (S3_PUBLIC_BASE_URL || '').replace(/\/$/, '')
  if (base) return `${base}/${key}`
  // Best-effort fallback (works for public S3 buckets); prefer setting S3_PUBLIC_BASE_URL.
  return `${S3_ENDPOINT?.replace(/\/$/, '') || ''}/${S3_BUCKET}/${key}`
}
