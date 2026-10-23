// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App.jsx';
import { fakeServer, sources, ticket } from './testServer.js';

const editor = { id: 2, name: 'Илья Учебный', role: 'editor', permissions: ['FUNC_TICKETS_SOURCE_EDIT', 'FUNC_TICKETS_VIEW'] };
const row = (id, sourceName) => ({ id, title: `Заявка ${id}`, status: 'active', source_name: sourceName });

let server;
beforeEach(() => {
  server = fakeServer();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('после сохранения обновляются карточка, история и список', async () => {
  const { respond, requests } = server;
  render(<App />);
  await respond('GET', '/api/me', 200, { employee: editor, csrf: 'token' });
  await respond('GET', '/api/tickets', 200, { tickets: [row(101, 'Телефон'), row(102, 'Личный кабинет')] });
  await respond('GET', '/api/sources', 200, { sources });

  fireEvent.click(screen.getByRole('button', { name: /Заявка 101/ }));
  await respond('GET', '/api/tickets/101', 200, { ticket: ticket(101, 1), history: [] });
  fireEvent.change(screen.getByLabelText('Источник заявки'), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
  const history = [{ id: 1, employee_id: 2, employee_name: 'Илья Учебный', old_source_id: 1, new_source_id: 3, created_at: '2026-01-01T00:00:00+00:00' }];
  await respond('POST', '/api/tickets/101/source', 200, { ticket: ticket(101, 3), history });

  const list = screen.getByRole('region', { name: 'Список заявок' });
  expect(within(list).getByRole('button', { name: /Заявка 101/ }).textContent).toContain('Сотрудник');
  expect(screen.getByText('Телефон → Сотрудник')).toBeTruthy();
  expect(screen.getByText('Источник сохранён')).toBeTruthy();
  expect(JSON.parse(requests.find(item => item.method === 'POST').body)).toEqual({ source_id: 3 });

  // Список перечитывается с сервера и подхватывает чужие изменения
  await respond('GET', '/api/tickets', 200, { tickets: [row(101, 'Сотрудник'), row(102, 'Телефон')] });
  expect(within(list).getByRole('button', { name: /Заявка 102/ }).textContent).toContain('Телефон');
});
