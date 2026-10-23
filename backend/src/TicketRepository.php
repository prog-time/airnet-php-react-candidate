<?php
class TicketRepository
{
    public function all()
    {
        $rows = pg_fetch_all(query('SELECT t.id, t.title, t.status, s.name AS source_name FROM tickets t LEFT JOIN sources s ON s.id=t.source_id ORDER BY t.id')) ?: array();
        foreach ($rows as &$row) {
            $row['id'] = (int) $row['id'];
        }
        return $rows;
    }

    public function find($id)
    {
        if (!self::isDbInteger($id)) {
            return null;
        }
        $row =pg_fetch_assoc(query('SELECT t.id, t.title, t.description, t.status, t.updated_at, s.id AS source_id, s.name AS source_name FROM tickets t LEFT JOIN sources s ON s.id=t.source_id WHERE t.id=$1', array($id)));
        if (!$row) {
            return null;
        }
        return array(
            'id' => (int) $row['id'],
            'title' => $row['title'],
            'description' => $row['description'],
            'status' => $row['status'],
            'source' => $row['source_id'] === null ? null : array('id' => (int) $row['source_id'], 'name' => $row['source_name']),
            'updated_at' => $row['updated_at'],
        );
    }

    public function sources()
    {
        $rows = pg_fetch_all(query('SELECT id, name FROM sources ORDER BY id')) ?: array();
        foreach ($rows as &$row) {
            $row['id'] = (int) $row['id'];
        }
        return $rows;
    }

    public function history($id)
    {
        $rows = pg_fetch_all(query('SELECT h.id, h.employee_id, e.name AS employee_name, h.old_source_id, h.new_source_id, h.created_at FROM ticket_history h JOIN employees e ON e.id=h.employee_id WHERE h.ticket_id=$1 ORDER BY h.id DESC', array($id))) ?: array();
        foreach ($rows as &$row) {
            $row['id'] = (int) $row['id'];
            $row['employee_id'] = (int) $row['employee_id'];
            $row['old_source_id'] = $row['old_source_id'] === null ? null : (int) $row['old_source_id'];
            $row['new_source_id'] = (int) $row['new_source_id'];
        }
        return $rows;
    }

    public function sourceExists($sourceId)
    {
        return self::isDbInteger($sourceId) && (bool) pg_fetch_assoc(query('SELECT id FROM sources WHERE id=$1', array($sourceId)));
    }

    // Заявка блокируется до конца транзакции: параллельные изменения
    // одной заявки выполняются по очереди и видят актуальный источник
    public function changeSource($id, $sourceId, array $employee)
    {
        query('BEGIN');
        try {
            $ticket = pg_fetch_assoc(query('SELECT status, source_id FROM tickets WHERE id=$1 FOR UPDATE', array($id)));
            if (!$ticket) {
                query('ROLLBACK');
                respond(404, array('error' => 'not_found', 'message' => 'Заявка не найдена'));
            }
            if ($ticket['status'] === 'archived') {
                query('ROLLBACK');
                respond(403, array('error' => 'archived', 'message' => 'Архивная заявка доступна только для чтения'));
            }
            if ($ticket['source_id'] === null || (int) $ticket['source_id'] !== $sourceId) {
                query('UPDATE tickets SET source_id=$1, updated_at=clock_timestamp() WHERE id=$2', array($sourceId, $id));
                query('INSERT INTO ticket_history(ticket_id, employee_id, old_source_id, new_source_id) VALUES($1,$2,$3,$4)', array($id, $employee['id'], $ticket['source_id'], $sourceId));
            }
            query('COMMIT');
        } catch (Throwable $error) {
            @pg_query(db(), 'ROLLBACK');
            throw $error;
        }
        return $this->find($id);
    }

    // id вне диапазона integer PostgreSQL не существует, а не ломает запрос
    public static function isDbInteger($value)
    {
        return is_int($value) && $value > 0 && $value <= 2147483647;
    }
}
