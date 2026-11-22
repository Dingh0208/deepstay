export const isSafeApiPath = (path: string): boolean => {
  try {
    return path.split('/').every((part) => {
      const decoded = decodeURIComponent(part)
      return decoded !== '.' && decoded !== '..' && !/[\\/%]/.test(decoded)
    })
  } catch {
    return false
  }
}

export const isPrivateNetworkHostname = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === 'localhost') {
    return true
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4) {
    const [first, second] = ipv4.slice(1).map(Number)
    if (ipv4.slice(1).some((part) => Number(part) > 255)) {
      return false
    }
    return first === 10 || first === 127 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
  }
  if (!host.includes(':') || !/^[0-9a-f:]+$/i.test(host) || host.includes(':::')) {
    return false
  }
  if (host === '::1') {
    return true
  }
  const firstGroup = host.split(':', 1)[0]
  return /^f[cd][0-9a-f]{2}$/i.test(firstGroup) || /^fe[89ab][0-9a-f]$/i.test(firstGroup)
}

export const isPrivateNetworkApiUrl = (input: string): boolean => {
  try {
    const url = new URL(input)
    return url.protocol === 'http:' && isPrivateNetworkHostname(url.hostname)
  } catch {
    return false
  }
}

export class InsecurePublicApiUrlError extends Error {
  constructor() {
    super('HTTP is only allowed for loopback or private-network IP addresses')
    this.name = 'InsecurePublicApiUrlError'
  }
}

export const normalizeApiBaseUrl = (input: string): string => {
  const url = new URL(input.trim())
  const rawPath = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(input.trim())?.[1] ?? ''
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !isSafeApiPath(rawPath)
  ) {
    throw new Error('Enter an HTTP or HTTPS API base URL without credentials, query or fragment')
  }
  if (url.protocol === 'http:' && !isPrivateNetworkHostname(url.hostname)) {
    throw new InsecurePublicApiUrlError()
  }
  // Accept a request URL copied from an API example without losing a relay's prefix.
  url.pathname = url.pathname
    .replace(/\/+$/, '')
    .replace(/(\/(?:v\d+(?:\.\d+)?|openai))\/(?:chat\/completions|models)$/, '$1')
    .replace(/(\/anthropic\/v1)\/messages$/, '$1')
  return url.href.replace(/\/+$/, '')
}

/** 根地址和普通代理前缀追加 /v1；版本地址、OpenAI base 和完整聊天地址保留原路由。 */
export const apiEndpoint = (baseUrl: string, path: string): string => {
  let base = normalizeApiBaseUrl(baseUrl)
  const route = path.replace(/^\/+/, '')
  if (route === 'v1/models' || route === 'v1/chat/completions') {
    const suffix = route.slice(3)
    // 保留未知前缀的完整 endpoint，避免与普通 /proxy base 的含义混淆。
    if (/\/chat\/completions$/.test(new URL(base).pathname)) {
      return `${base.replace(/\/chat\/completions$/, '')}/${suffix}`
    }
    if (/\/(?:v\d+(?:\.\d+)?|openai)$/.test(new URL(base).pathname)) {
      return `${base}/${suffix}`
    }
  }
  if (route.startsWith('anthropic/v1/') || route.startsWith('v1/')) {
    base = base.replace(/\/(?:anthropic(?:\/v1)?|v1)$/, '')
  }
  return `${base}/${route}`
}

