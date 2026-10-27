import { useEffect } from 'react'
import { useRouter } from 'next/router'

export default function Index() {
  const router = useRouter()
  useEffect(() => { router.replace('/app') }, [])
  return <div style={{ minHeight: '100vh', background: '#000' }} />
}
