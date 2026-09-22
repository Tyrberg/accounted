'use server'

import { createClient } from '@/lib/supabase/server'
import { toSameOriginStorageUrl } from '@/lib/core/documents/storage-proxy'

/**
 * Generate a signed URL for a stored document. Used by DocumentViewer to display
 * documents delivered by bertil without requiring the user to download.
 *
 * Requires the user to be authenticated and have access to the company that owns
 * the document (verified by checking company_id in the storage path).
 */
export async function getDocumentSignedUrl(storagePath: string): Promise<{ signedUrl: string | null; error: string | null }> {
  if (!storagePath) {
    return { signedUrl: null, error: 'No storage path provided' }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return { signedUrl: null, error: 'Unauthorized' }
  }

  // Verify the storage path belongs to a company the user has access to.
  // Storage path format: documents/company-id/user-id/filename
  const pathParts = storagePath.split('/')
  if (pathParts.length < 3 || pathParts[0] !== 'documents') {
    return { signedUrl: null, error: 'Invalid storage path' }
  }

  const companyIdFromPath = pathParts[1]

  // Check that user is a member of this company
  const { data: membership, error: membershipError } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('company_id', companyIdFromPath)
    .eq('user_id', user.id)
    .maybeSingle()

  if (membershipError || !membership) {
    return { signedUrl: null, error: 'Access denied' }
  }

  const { data, error } = await supabase.storage
    .from('documents')
    .createSignedUrl(storagePath, 3600) // 1 hour expiry

  if (error || !data?.signedUrl) {
    return { signedUrl: null, error: error?.message || 'Could not generate signed URL' }
  }

  // Convert to same-origin proxy URL
  const proxiedUrl = toSameOriginStorageUrl(data.signedUrl)
  return { signedUrl: proxiedUrl, error: null }
}
