import { toSameOriginStorageUrl } from '@/lib/core/documents/storage-proxy'

export async function getDocumentSignedUrl(storagePath: string): Promise<{ signedUrl: string | null; error: string | null }> {
  if (!storagePath) {
    return { signedUrl: null, error: 'No storage path provided' }
  }

  try {
    const response = await fetch('/api/extensions/ext/underlagsjakt/documents/signed-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storagePath }),
    })

    if (!response.ok) {
      return { signedUrl: null, error: 'Could not generate signed URL' }
    }

    const data = await response.json()
    if (!data.signedUrl) {
      return { signedUrl: null, error: 'Could not generate signed URL' }
    }

    const proxiedUrl = toSameOriginStorageUrl(data.signedUrl)
    return { signedUrl: proxiedUrl, error: null }
  } catch (err) {
    console.error('Error fetching signed URL:', err)
    return { signedUrl: null, error: 'Could not generate signed URL' }
  }
}
