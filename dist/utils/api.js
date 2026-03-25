const API_BASE = process.env.CLAWMONEY_API_BASE || 'https://api.bnbot.ai';
function buildUrl(path) {
    const base = API_BASE.replace(/\/+$/, '');
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${base}${cleanPath}`;
}
function buildHeaders(apiKey) {
    const headers = {
        'Content-Type': 'application/json',
    };
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
}
export async function apiGet(path, apiKey) {
    const url = buildUrl(path);
    const response = await fetch(url, {
        method: 'GET',
        headers: buildHeaders(apiKey),
    });
    let data;
    try {
        data = (await response.json());
    }
    catch {
        data = (await response.text());
    }
    return {
        ok: response.ok,
        status: response.status,
        data,
    };
}
export async function apiPost(path, body, apiKey) {
    const url = buildUrl(path);
    const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(apiKey),
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let data;
    try {
        data = JSON.parse(text);
    }
    catch {
        data = text;
    }
    return {
        ok: response.ok,
        status: response.status,
        data,
    };
}
export function getApiBase() {
    return API_BASE;
}
