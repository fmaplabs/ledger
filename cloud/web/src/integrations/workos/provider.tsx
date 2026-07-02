import { AuthKitProvider } from '@workos-inc/authkit-react'
import { useNavigate } from '@tanstack/react-router'
import { env } from '../../env'

export default function AppWorkOSProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const navigate = useNavigate()

  return (
    <AuthKitProvider
      clientId={env.VITE_WORKOS_CLIENT_ID}
      apiHostname={env.VITE_WORKOS_API_HOSTNAME}
      onRedirectCallback={({ state }) => {
        if (state?.returnTo) {
          navigate({ to: state.returnTo })
        }
      }}
    >
      {children}
    </AuthKitProvider>
  )
}
