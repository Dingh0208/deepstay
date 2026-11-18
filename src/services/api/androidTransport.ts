import { Capacitor, registerPlugin } from '@capacitor/core'

type ProviderHttp = {
  open(options: {
    id: string
    url: string
    method: string
    authorization: string | null
    accept: string | null
    body?: string | null
  }): Promise<{ status: number; contentType?: string }>
  read(options: { id: string }): Promise<{ data?: string }>
  close(options: { id: string }): Promise<void>
}

const providerHttp = registerPlugin<ProviderHttp>('ProviderHttp')

export const supportsAndroidProviderTransport = (url: string): boolean => {
  if (Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('ProviderHttp')) {
    return false
  }
  try {
    const endpoint = new URL(url)
    return (
      endpoint.protocol === 'https:' &&
      endpoint.hostname.toLowerCase() !== 'api.deepseek.com' &&
      !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash &&
      /\/v1\/(?:models|chat\/completions)$/.test(endpoint.pathname)
    )
  } catch {
    return false
  }
}

/** Relay the native response body in bounded chunks, preserving the timing of SSE frames. */
export const requestAndroidProvider = async (
  url: string,
  { method = 'GET', headers: inputHeaders, body, signal }: RequestInit
): Promise<Response> => {
  if (body !== undefined && body !== null && typeof body !== 'string') {
    throw new TypeError('Android provider requests require a string body')
  }
  const abortReason = () => signal?.reason ?? new DOMException('Aborted', 'AbortError')
  if (signal?.aborted) {
    throw abortReason()
  }
  const id = crypto.getRandomValues(new Uint32Array(4)).join('-')
  const input = new Headers(inputHeaders)
  let closed = false
  let fail: (reason?: unknown) => void = () => {}
  const close = () => {
    if (closed) {
      return
    }
    closed = true
    signal?.removeEventListener('abort', onAbort)
    void providerHttp.close({ id }).catch(() => {})
  }
  const onAbort = () => {
    fail(abortReason())
    close()
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const { status, contentType } = await new Promise<Awaited<ReturnType<ProviderHttp['open']>>>((resolve, reject) => {
      fail = reject
      void providerHttp
        .open({ id, url, method, authorization: input.get('Authorization'), accept: input.get('Accept'), body })
        .then(resolve, reject)
    })
    if (signal?.aborted) {
      throw abortReason()
    }
    const headers = new Headers()
    if (contentType) {
      headers.set('Content-Type', contentType)
    }
    const init = { status, statusText: `HTTP ${status}`, headers }
    if (status === 204 || status === 205 || status === 304) {
      close()
      return new Response(null, init)
    }
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        fail = (reason) => controller.error(reason)
      },
      async pull(controller) {
        try {
          const { data } = await providerHttp.read({ id })
          if (closed) {
            return
          }
          if (data === undefined) {
            controller.close()
            close()
            return
          }
          controller.enqueue(Uint8Array.from(atob(data), (byte) => byte.charCodeAt(0)))
        } catch (error) {
          if (closed) {
            return
          }
          controller.error(error)
          close()
        }
      },
      cancel: close,
    }, { highWaterMark: 0 }), init)
  } catch (error) {
    close()
    throw error
  }
}
