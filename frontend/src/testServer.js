import { act } from '@testing-library/react';
import { expect, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

export const sources = [{ id: 1, name: 'Телефон' }, { id: 2, name: 'Личный кабинет' }, { id: 3, name: 'Сотрудник' }];

export function ticket(id, sourceId = 1, status = 'active') {
  const source = sources.find(item => item.id === sourceId) ?? null;
  return { id, title: `Заявка ${id}`, description: `Описание ${id}`, status, source, updated_at: '2026-01-01T00:00:00+00:00' };
}

// Сервер под управлением теста: каждый запрос ждёт, пока тест не ответит на него
export function fakeServer() {
  const requests = [];
  vi.stubGlobal('fetch', vi.fn((url, options = {}) => new Promise((resolve, reject) => {
    const request = { url, method: options.method ?? 'GET', body: options.body, settled: false };
    request.respond = (status, body) => {
      request.settled = true;
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      resolve(new Response(text, { status, headers: { 'Content-Type': 'application/json' } }));
    };
    options.signal?.addEventListener('abort', () => {
      request.settled = true;
      reject(new DOMException('Aborted', 'AbortError'));
    });
    requests.push(request);
  })));

  function pending(method, url) {
    const found = requests.filter(item => !item.settled && item.method === method && item.url === url);
    expect(found, `${method} ${url}`).toHaveLength(1);
    return found[0];
  }

  return {
    requests,
    pending,
    async respond(method, url, status, body) {
      await act(async () => pending(method, url).respond(status, body));
    },
  };
}
