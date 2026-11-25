"""Regression check for upgrading existing report data, without accessing Cloudflare."""
import sqlite3
from pathlib import Path

migration = (Path(__file__).parents[1] / 'migrations/0011_report_ids.sql').read_text(encoding='utf-8')
for populated in (False, True):
    db = sqlite3.connect(':memory:')
    db.executescript('''
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO meta VALUES ('skips_merged', '500');
        CREATE TABLE skip_reports (user_id TEXT, ip_hash TEXT NOT NULL, created_at INTEGER NOT NULL, items TEXT);
    ''')
    if populated:
        db.execute("INSERT INTO skip_reports(rowid, user_id, ip_hash, created_at, items) VALUES (400, 'user', 'net', 100, '[]')")
    db.executescript(migration)
    if populated:
        assert db.execute('SELECT sequence, items FROM skip_reports').fetchone() == (400, '[]')
    db.execute('DELETE FROM skip_reports')
    db.execute("INSERT INTO skip_reports(user_id, ip_hash, created_at, items, report_id) VALUES ('user', 'net', 200, '[]', 'stable-id')")
    assert db.execute('SELECT sequence FROM skip_reports').fetchone()[0] > 500
    try:
        db.execute("INSERT INTO skip_reports(user_id, ip_hash, created_at, items, report_id) VALUES ('user', 'net', 201, '[]', 'stable-id')")
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError('Duplicate receipt was accepted')
    db.close()
print('PASS: populated and empty legacy databases preserve sequence, payloads and receipt uniqueness')
