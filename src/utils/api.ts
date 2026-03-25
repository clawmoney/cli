const API_BASE = process.env.CLAWMONEY_API_BASE || 'https://api.bnbot.ai';

export interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
}

function buildUrl(path: string): string {
  const base = API_BASE.replace(/\/+$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${cleanPath}`;
}

function buildHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

export async function apiGet<T = unknown>(
  path: string,
  apiKey?: string
): Promise<ApiResponse<T>> {
  const url = buildUrl(path);
  const response = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(apiKey),
  });

  let data: T;
  try {
    data = (await response.json()) as T;
  } catch {
    data = (await response.text()) as unknown as T;
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

export async function apiPost<T = unknown>(
  path: string,
  body: unknown,
  apiKey?: string
): Promise<ApiResponse<T>> {
  const url = buildUrl(path);
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    data = text as unknown as T;
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

export function getApiBase(): string {
  return API_BASE;
}
