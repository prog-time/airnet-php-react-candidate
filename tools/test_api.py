"""Проверки поведения API заявок.

Запуск при поднятом docker compose из корня проекта:
    python3 tools/test_api.py [http://localhost:5173]

Перед каждым тестом данные сбрасываются database/reset.sql через сервис db.
"""
import http.cookiejar
import json
import os
import subprocess
import sys
import unittest
import urllib.error
import urllib.request

BASE = 'http://localhost:5173'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PSQL = ['docker', 'compose', 'exec', '-T', 'db', 'psql', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'assessment', '-d', 'airnet_assessment']

# Начальные данные из database/002_seed.sql
SOURCE_OF = {101: 1, 102: 2, 103: None, 104: 3, 105: 1}


def psql(sql):
    subprocess.run(PSQL, input=sql.encode(), cwd=ROOT, check=True, stdout=subprocess.DEVNULL)


class Client:
    def __init__(self, role=None):
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.csrf = ''
        if role:
            status, data = self.call('POST', '/demo/login', {'role': role})
            assert status == 200, data
            self.csrf = data['csrf']

    def call(self, method, path, body=None, raw=None):
        payload = raw if raw is not None else (None if body is None else json.dumps(body).encode())
        request = urllib.request.Request(BASE + '/api' + path, data=payload, method=method,
                                         headers={'Content-Type': 'application/json', 'X-CSRF-Token': self.csrf})
        try:
            response = self.opener.open(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        text = response.read().decode()
        try:
            data = json.loads(text)
        except ValueError:
            raise AssertionError('Ответ не JSON (%s): %r' % (response.status, text[:200]))
        return response.status, data

    def change(self, ticket_id, body=None, raw=None):
        return self.call('POST', '/tickets/%s/source' % ticket_id, body, raw)

    def ticket(self, ticket_id):
        status, data = self.call('GET', '/tickets/%s' % ticket_id)
        assert status == 200, data
        return data


class ApiTest(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(ROOT, 'database', 'reset.sql')) as file:
            psql(file.read())
        self.editor = Client('editor')
        self.viewer = Client('viewer')

    def assertError(self, result, status):
        code, data = result
        self.assertEqual(code, status, data)
        self.assertIsInstance(data.get('error'), str, data)

    def assertUnchanged(self, ticket_id):
        data = self.editor.ticket(ticket_id)
        source = data['ticket']['source']
        self.assertEqual(source and source['id'], SOURCE_OF[ticket_id])
        self.assertEqual(data['history'], [])

    # Исходная ошибка №3: карточка без источника отвечала 500
    def test_ticket_without_source(self):
        data = self.viewer.ticket(103)
        self.assertIsNone(data['ticket']['source'])
        self.assertEqual(data['ticket']['id'], 103)

    # Исходная ошибка №2: просмотр мог изменить источник
    def test_viewer_cannot_change_source(self):
        self.assertError(self.viewer.change(101, {'source_id': 2}), 403)
        self.assertUnchanged(101)

    def test_viewer_cannot_escalate_with_client_fields(self):
        body = {'source_id': 2, 'employee_id': 2, 'employee_name': 'Илья Учебный', 'permissions': ['FUNC_TICKETS_SOURCE_EDIT']}
        self.assertError(self.viewer.change(101, body), 403)
        self.assertUnchanged(101)

    def test_viewer_forbidden_before_any_other_check(self):
        self.assertError(self.viewer.change(999), 403)
        self.assertError(self.viewer.change(104, {'source_id': 'x'}), 403)
        self.assertError(self.viewer.change(101, raw=b'not json'), 403)

    def test_viewer_reads_list_ticket_history(self):
        status, data = self.viewer.call('GET', '/tickets')
        self.assertEqual(status, 200)
        self.assertEqual([row['id'] for row in data['tickets']], [101, 102, 103, 104, 105])
        self.assertIsNone(next(row for row in data['tickets'] if row['id'] == 103)['source_name'])
        self.assertEqual(self.viewer.call('GET', '/sources')[0], 200)
        self.assertEqual(self.viewer.ticket(101)['history'], [])

    def test_no_session(self):
        anonymous = Client()
        for method, path, body in (('GET', '/tickets', None), ('GET', '/tickets/101', None), ('POST', '/tickets/101/source', {'source_id': 2})):
            self.assertError(anonymous.call(method, path, body), 401)
        self.assertUnchanged(101)

    def test_editor_changes_source_with_session_employee(self):
        body = {'source_id': 3, 'employee_id': 1, 'employee_name': 'Анна Примерова'}
        status, data = self.editor.change(103, body)
        self.assertEqual(status, 200, data)
        self.assertEqual(data['ticket']['source'], {'id': 3, 'name': 'Сотрудник'})
        self.assertEqual(len(data['history']), 1)
        entry = data['history'][0]
        self.assertEqual((entry['employee_id'], entry['employee_name']), (2, 'Илья Учебный'))
        self.assertEqual((entry['old_source_id'], entry['new_source_id']), (None, 3))
        self.assertTrue(entry['created_at'])
        self.assertEqual(self.viewer.ticket(103)['history'], data['history'])
        status, data = self.viewer.call('GET', '/tickets')
        self.assertEqual(next(row for row in data['tickets'] if row['id'] == 103)['source_name'], 'Сотрудник')

    def test_history_newest_first(self):
        self.editor.change(101, {'source_id': 2})
        self.editor.change(101, {'source_id': 3})
        history = self.editor.ticket(101)['history']
        self.assertEqual([(h['old_source_id'], h['new_source_id']) for h in history], [(2, 3), (1, 2)])

    def test_same_source_is_success_without_history(self):
        before = self.editor.ticket(101)['ticket']
        status, data = self.editor.change(101, {'source_id': 1})
        self.assertEqual(status, 200, data)
        self.assertEqual(data['ticket']['source']['id'], 1)
        self.assertEqual(data['history'], [])
        self.assertEqual(data['ticket']['updated_at'], before['updated_at'])

    def test_invalid_source_rejected(self):
        for body in ({'source_id': '2'}, {'source_id': 2.5}, {'source_id': 2.0}, {'source_id': None}, {},
                     {'source_id': 0}, {'source_id': -1}, {'source_id': 999}, {'source_id': True},
                     {'source_id': [2]}, {'source_id': 99999999999}, [2]):
            with self.subTest(body=body):
                self.assertError(self.editor.change(101, body), 400)
        self.assertError(self.editor.change(101, raw=b'{"source_id":'), 400)
        self.assertUnchanged(101)

    def test_missing_ticket(self):
        self.assertError(self.editor.change(999, {'source_id': 2}), 404)
        self.assertError(self.editor.call('GET', '/tickets/999'), 404)
        self.assertError(self.editor.call('GET', '/tickets/99999999999'), 404)
        self.assertError(self.editor.change(99999999999, {'source_id': 2}), 404)

    def test_archived_ticket_is_read_only(self):
        self.assertError(self.editor.change(104, {'source_id': 1}), 403)
        self.assertError(self.editor.change(104, {'source_id': 3}), 403)
        self.assertUnchanged(104)
        self.assertEqual(self.viewer.ticket(104)['ticket']['status'], 'archived')

    def test_editor_check_order(self):
        # нет заявки → архив → источник
        self.assertError(self.editor.change(999, {'source_id': 'x'}), 404)
        self.assertError(self.editor.change(999, raw=b'not json'), 404)
        self.assertError(self.editor.change(104, {'source_id': 'x'}), 403)
        self.assertError(self.editor.change(104, raw=b'not json'), 403)

    def test_csrf_required(self):
        self.editor.csrf = 'wrong'
        self.assertError(self.editor.change(101, {'source_id': 2}), 403)
        self.assertUnchanged(101)

    def test_change_is_atomic_and_500_hides_details(self):
        psql("""CREATE FUNCTION test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'secret_internal_detail'; END $$;
                CREATE TRIGGER test_fail BEFORE INSERT ON ticket_history FOR EACH ROW EXECUTE FUNCTION test_fail();""")
        try:
            status, data = self.editor.change(101, {'source_id': 2})
        finally:
            psql('DROP TRIGGER test_fail ON ticket_history; DROP FUNCTION test_fail();')
        self.assertEqual(status, 500, data)
        self.assertNotIn('secret', json.dumps(data))
        self.assertNotIn('ticket_history', json.dumps(data))
        self.assertUnchanged(101)
        # соединение не осталось в прерванной транзакции
        self.assertEqual(self.editor.change(101, {'source_id': 2})[0], 200)


if __name__ == '__main__':
    if len(sys.argv) > 1 and not sys.argv[1].startswith('-'):
        BASE = sys.argv.pop(1).rstrip('/')
    unittest.main(verbosity=2)
