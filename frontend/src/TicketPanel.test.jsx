// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import TicketPanel from './TicketPanel.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const sources = [{ id: 1, name: 'Телефон' }, { id: 2, name: 'Личный кабинет' }, { id: 3, name: 'Сотрудник' }];
const editor = { id: 2, name: 'Илья Учебный', role: 'editor', permissions: ['FUNC_TICKETS_SOURCE_EDIT', 'FUNC_TICKETS_VIEW'] };
const viewer = { id: 1, name: 'Анна Примерова', role: 'viewer', permissions: ['FUNC_TICKETS_VIEW'] };

function ticket(id, sourceId = 1, status = 'active') {
  const source = sources.find(item => item.id === sourceId) ?? null;
  return { id, title: `Заявка ${id}`, description: `Описание ${id}`, status, source, updated_at: '2026-01-01T00:00:00+00:00' };
}

// Сервер под управлением теста: каждый запрос ждёт, пока тест не ответит на него
let requests;
beforeEach(() => {
  requests = [];
  vi.stubGlobal('fetch', vi.fn((url, options = {}) => new Promise((resolve, reject) => {
    const request = { url, method: options.method ?? 'GET', body: options.body, settled: false };
    request.respond = (status, body) => {
      request.settled = true;
      resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
    };
    options.signal?.addEventListener('abort', () => {
      request.settled = true;
      reject(new DOMException('Aborted', 'AbortError'));
    });
    requests.push(request);
  })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function pending(method, url) {
  const found = requests.filter(item => !item.settled && item.method === method && item.url === url);
  expect(found, `${method} ${url}`).toHaveLength(1);
  return found[0];
}

async function respond(method, url, status, body) {
  await act(async () => pending(method, url).respond(status, body));
}

function renderPanel(props) {
  const all = { employee: editor, selectedId: null, sources, onChanged: vi.fn(), ...props };
  const view = render(<TicketPanel {...all} />);
  return { ...view, props: all, select: selectedId => view.rerender(<TicketPanel {...all} selectedId={selectedId} />) };
}

test('поздний ответ загрузки предыдущей заявки не подменяет выбранную', async () => {
  const view = renderPanel({ selectedId: 101 });
  view.select(102);
  await respond('GET', '/api/tickets/102', 200, { ticket: ticket(102, 2), history: [] });
  await respond('GET', '/api/tickets/101', 200, { ticket: ticket(101, 1), history: [] }).catch(() => {});

  expect(screen.getByRole('heading', { name: 'Заявка 102' })).toBeTruthy();
  expect(screen.queryByText('Заявка 101')).toBeNull();
  expect(screen.getByLabelText('Источник заявки').value).toBe('2');
});

test('пока грузится новая заявка, карточка предыдущей не показывается', async () => {
  const view = renderPanel({ selectedId: 101 });
  await respond('GET', '/api/tickets/101', 200, { ticket: ticket(101), history: [] });
  view.select(102);

  expect(screen.queryByText('Заявка 101')).toBeNull();
  expect(screen.getByText('Загрузка карточки…')).toBeTruthy();
});

test('ответ сохранения предыдущей заявки не подменяет текущую карточку', async () => {
  const view = renderPanel({ selectedId: 101 });
  await respond('GET', '/api/tickets/101', 200, { ticket: ticket(101, 1), history: [] });
  fireEvent.change(screen.getByLabelText('Источник заявки'), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

  view.select(102);
  await respond('GET', '/api/tickets/102', 200, { ticket: ticket(102, 2), history: [] });
  const history = [{ id: 1, employee_id: 2, employee_name: 'Илья Учебный', old_source_id: 1, new_source_id: 3, created_at: '2026-01-01T00:00:00+00:00' }];
  await respond('POST', '/api/tickets/101/source', 200, { ticket: ticket(101, 3), history });

  expect(screen.getByRole('heading', { name: 'Заявка 102' })).toBeTruthy();
  expect(screen.getByLabelText('Источник заявки').value).toBe('2');
  expect(screen.queryByText('Источник сохранён')).toBeNull();
  expect(screen.getByText('Изменений пока нет.')).toBeTruthy();
  expect(view.props.onChanged).toHaveBeenCalledWith(expect.objectContaining({ id: 101 }));
});

test('повторное нажатие во время сохранения не отправляет второй запрос', async () => {
  renderPanel({ selectedId: 101 });
  await respond('GET', '/api/tickets/101', 200, { ticket: ticket(101, 1), history: [] });
  fireEvent.change(screen.getByLabelText('Источник заявки'), { target: { value: '2' } });
  const button = screen.getByRole('button', { name: 'Сохранить' });
  fireEvent.click(button);
  fireEvent.click(button);

  expect(requests.filter(item => item.method === 'POST')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Сохранение…' }).disabled).toBe(true);
  await respond('POST', '/api/tickets/101/source', 200, { ticket: ticket(101, 2), history: [] });
  expect(screen.getByText('Источник сохранён')).toBeTruthy();
});

test('ошибка сохранения показывается пользователю', async () => {
  renderPanel({ selectedId: 101 });
  await respond('GET', '/api/tickets/101', 200, { ticket: ticket(101, 1), history: [] });
  fireEvent.change(screen.getByLabelText('Источник заявки'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  await respond('POST', '/api/tickets/101/source', 403, { error: 'forbidden', message: 'Недостаточно прав' });

  expect(screen.getByRole('alert').textContent).toBe('Недостаточно прав');
  expect(screen.getByRole('button', { name: 'Сохранить' }).disabled).toBe(false);
});

test('заявка без источника показывает «Не указан»', async () => {
  renderPanel({ selectedId: 103, employee: viewer });
  await respond('GET', '/api/tickets/103', 200, { ticket: ticket(103, null), history: [] });

  expect(screen.getByText('Не указан')).toBeTruthy();
});

test('архивная заявка и роль просмотра доступны только для чтения', async () => {
  const view = renderPanel({ selectedId: 104 });
  await respond('GET', '/api/tickets/104', 200, { ticket: ticket(104, 3, 'archived'), history: [] });
  expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull();

  view.rerender(<TicketPanel {...view.props} employee={viewer} selectedId={101} />);
  await respond('GET', '/api/tickets/101', 200, { ticket: ticket(101), history: [] });
  expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull();
});
