let csrf = '';

export function setCsrf(value) {
  csrf = value;
}

export async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...options.headers },
  });
  // Прокси или упавший сервер могут ответить не JSON
  let data = null;
  try {
    data = JSON.parse(await response.text());
  } catch (error) {
    if (error.name === 'AbortError') throw error;
  }
  if (!response.ok || data === null) {
    const error = new Error(data?.message || `Сервер недоступен (HTTP ${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}
