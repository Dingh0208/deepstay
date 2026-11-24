import { Capacitor, registerPlugin } from '@capacitor/core'
import { isPrivateNetworkApiUrl, isSafeApiPath } from './connection.js'

type ProviderHttp = {
  open(options: {
    id: string
    url: string
    method: string
    authorization: string | null
    accept: string | null
    body?: string | null
    bodyLength?: number | null
    streamBody?: boolean
    audioModel?: string | null
    audioFileName?: string | null
    audioContentType?: string | null
    audioBase64?: string | null
  }): Promise<{ status?: number; contentType?: string; uploading?: boolean }>
  writeBodyChunk(options: { id: string; data: string }): Promise<{ continueUpload?: boolean }>
  finishBody(options: { id: string }): Promise<{ continueUpload?: boolean }>
  awaitResponse(options: { id: string }): Promise<{ status: number; contentType?: string }>
  read(options: { id: string }): Promise<{ data?: string }>
  close(options: { id: string }): Promise<void>
}

export type AndroidProviderErrorCode =
  | 'PROVIDER_DNS'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_TLS'
  | 'PROVIDER_CONNECT'
  | 'PROVIDER_NETWORK'
  | 'PROVIDER_URL'
  | 'PROVIDER_BUSY'
  | 'PROVIDER_CLOSED'

export class AndroidProviderTransportError extends Error {
  constructor(readonly code: AndroidProviderErrorCode) {
    super('Provider request failed')
    this.name = 'AndroidProviderTransportError'
  }
}

export const normalizeAndroidProviderError = (error: unknown): AndroidProviderTransportError | null => {
  if (error instanceof AndroidProviderTransportError) {
    return error
  }
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null
  }
  const code = error.code
  switch (code) {
    case 'PROVIDER_DNS':
    case 'PROVIDER_TIMEOUT':
    case 'PROVIDER_TLS':
    case 'PROVIDER_CONNECT':
    case 'PROVIDER_NETWORK':
    case 'PROVIDER_URL':
    case 'PROVIDER_BUSY':
    case 'PROVIDER_CLOSED':
      return new AndroidProviderTransportError(code)
    default:
      return null
  }
}

const providerHttp = registerPlugin<ProviderHttp>('ProviderHttp')

export const isAndroidApiPlatform = () => Capacitor.getPlatform() === 'android'

export const requiresAndroidHttps = (url: string): boolean => {
  if (!isAndroidApiPlatform()) {
    return false
  }
  try {
    const endpoint = new URL(url)
    return endpoint.protocol !== 'https:' && !isPrivateNetworkApiUrl(url)
  } catch {
    return false
  }
}

export const supportsAndroidProviderTransport = (url: string): boolean => {
  if (!isAndroidApiPlatform() || !Capacitor.isPluginAvailable('ProviderHttp')) {
    return false
  }
  try {
    const endpoint = new URL(url)
    const rawPath = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(url)?.[1] ?? ''
    return (
      (endpoint.protocol === 'https:' || isPrivateNetworkApiUrl(url)) &&
      endpoint.hostname.toLowerCase() !== 'api.deepseek.com' &&
      !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash &&
      isSafeApiPath(rawPath) &&
      /\/(?:models|chat\/completions|audio\/transcriptions)$/.test(endpoint.pathname)
    )
  } catch {
    return false
  }
}

const NATIVE_BODY_CHUNK_BYTES = 24 * 1024
const NATIVE_STREAM_BODY_THRESHOLD = 128 * 1024

const utf8ByteLength = (value: string) => {
  let length = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) {
      length += 1
    } else if (code < 0x800) {
      length += 2
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
        value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      length += 4
      index += 1
    } else {
      length += 3
    }
  }
  return length
}

async function* encodeUtf8BodyChunks(value: string): AsyncGenerator<string> {
  const encoder = new TextEncoder()
  let offset = 0
  while (offset < value.length) {
    let end = offset
    let byteLength = 0
    while (end < value.length) {
      const code = value.charCodeAt(end)
      let codeBytes = code < 0x80 ? 1 : code < 0x800 ? 2 : 3
      let codeUnits = 1
      if (code >= 0xd800 && code <= 0xdbff && end + 1 < value.length) {
        const next = value.charCodeAt(end + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          codeBytes = 4
          codeUnits = 2
        }
      }
      if (byteLength + codeBytes > NATIVE_BODY_CHUNK_BYTES && end > offset) {
        break
      }
      byteLength += codeBytes
      end += codeUnits
    }
    const bytes = encoder.encode(value.slice(offset, end))
    let binary = ''
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
    }
    yield btoa(binary)
    offset = end
  }
}

const encodeAudioForm = async (body: FormData) => {
  const entries = [...body.entries()]
  if (entries.length !== 2 || entries[0][0] !== 'model' || entries[0][1] !== 'whisper-1' ||
      entries[1][0] !== 'file' || typeof entries[1][1] === 'string') {
    throw new TypeError('Unsupported Android audio transcription form')
  }
  const file = entries[1][1]
  if (file.name !== 'recording.wav' || !['audio/wav', 'audio/x-wav'].includes(file.type.toLowerCase()) ||
      file.size === 0 || file.size > 8 * 1024 * 1024) {
    throw new TypeError('Unsupported Android audio transcription file')
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return {
    model: 'whisper-1',
    fileName: file.name,
    contentType: file.type.toLowerCase(),
    data: btoa(binary),
  }
}

/** Relay the native response body in bounded chunks, preserving the timing of SSE frames. */
export const requestAndroidProvider = async (
  url: string,
  { method = 'GET', headers: inputHeaders, body, signal }: RequestInit
): Promise<Response> => {
  let encodedAudio: Awaited<ReturnType<typeof encodeAudioForm>> | undefined
  if (body instanceof FormData) {
    encodedAudio = await encodeAudioForm(body)
  } else if (body !== undefined && body !== null && typeof body !== 'string') {
    throw new TypeError('Android provider requests require a string or allowlisted audio form body')
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
    const requestBody = typeof body === 'string' ? body : null
    const streamBody = requestBody !== null && utf8ByteLength(requestBody) >= NATIVE_STREAM_BODY_THRESHOLD
    const opened = await new Promise<Awaited<ReturnType<ProviderHttp['open']>>>((resolve, reject) => {
      fail = reject
      void providerHttp
        .open({
          id, url, method, authorization: input.get('Authorization'), accept: input.get('Accept'),
          body: streamBody ? null : requestBody,
          bodyLength: streamBody ? utf8ByteLength(requestBody) : null,
          streamBody,
          audioModel: encodedAudio?.model ?? null,
          audioFileName: encodedAudio?.fileName ?? null,
          audioContentType: encodedAudio?.contentType ?? null,
          audioBase64: encodedAudio?.data ?? null,
        })
        .then(resolve, reject)
    })
    let responseInfo: { status: number; contentType?: string } | undefined
    if (opened.uploading) {
      if (requestBody === null) {
        throw new TypeError('Missing streamed provider request body')
      }
      const responseReady = providerHttp.awaitResponse({ id }).then(
        (response) => ({ response }),
        (error: unknown) => ({ error })
      )
      const earlyResponseReady = responseReady.then((result) => {
        if ('error' in result || result.response.status < 200 || result.response.status >= 300) {
          return result
        }
        return new Promise<never>(() => {})
      })
      const readResponse = async () => {
        const result = await responseReady
        if ('error' in result) {
          throw result.error
        }
        return result.response
      }
      for await (const data of encodeUtf8BodyChunks(requestBody)) {
        if (signal?.aborted) {
          throw abortReason()
        }
        const result = await Promise.race([
          providerHttp.writeBodyChunk({ id, data }).then((write) => ({ write })),
          earlyResponseReady.then((response) => ({ response })),
        ])
        if ('response' in result) {
          responseInfo = await readResponse()
          break
        }
        if (signal?.aborted) {
          throw abortReason()
        }
        if (result.write.continueUpload === false) {
          responseInfo = await readResponse()
          break
        }
      }
      if (responseInfo === undefined) {
        if (signal?.aborted) {
          throw abortReason()
        }
        const finish = await Promise.race([
          providerHttp.finishBody({ id }).then((value) => ({ value })),
          earlyResponseReady.then((response) => ({ response })),
        ])
        if ('response' in finish) {
          responseInfo = await readResponse()
        } else if (finish.value.continueUpload === false) {
          responseInfo = await readResponse()
        } else {
          if (signal?.aborted) {
            throw abortReason()
          }
          responseInfo = await readResponse()
        }
      }
    } else if (opened.status !== undefined) {
      responseInfo = { status: opened.status, contentType: opened.contentType }
    } else {
      throw new TypeError('Invalid provider response')
    }
    if (!responseInfo) {
      throw new TypeError('Invalid provider response')
    }
    const { status, contentType } = responseInfo
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
          controller.error(normalizeAndroidProviderError(error) ?? error)
          close()
        }
      },
      cancel: close,
    }, { highWaterMark: 0 }), init)
  } catch (error) {
    close()
    if (signal?.aborted) {
      throw abortReason()
    }
    throw normalizeAndroidProviderError(error) ?? error
  }
}
