import { ConvexProviderWithAuthKit } from '@convex-dev/workos'
import { useAuth } from '@workos-inc/authkit-react'
import type { ConvexReactClient } from 'convex/react'

// Forwards WorkOS access tokens to Convex so functions see
// ctx.auth.getUserIdentity(). Must be rendered inside AuthKitProvider.
export default function AppConvexProvider({
  client,
  children,
}: {
  client: ConvexReactClient
  children: React.ReactNode
}) {
  return (
    <ConvexProviderWithAuthKit client={client} useAuth={useAuth}>
      {children}
    </ConvexProviderWithAuthKit>
  )
}
