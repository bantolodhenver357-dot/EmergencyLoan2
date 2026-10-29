
import type { SQLiteDatabase } from 'expo-sqlite';

export async function initializeDatabase(
  db: SQLiteDatabase
): Promise<void> {
  // Enable foreign-key relationships.
  await db.execAsync('PRAGMA foreign_keys = ON;');

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS borrowers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      phone TEXT,
      address TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ),
      updated_at TEXT NOT NULL DEFAULT (
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      )
    );

    CREATE TABLE IF NOT EXISTS loans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      borrower_id INTEGER NOT NULL,
      principal REAL NOT NULL CHECK (principal > 0),
      interest_type TEXT NOT NULL
        CHECK (interest_type IN ('fixed', 'percentage')),
      interest_value REAL NOT NULL DEFAULT 0
        CHECK (interest_value >= 0),
      interest_amount REAL NOT NULL DEFAULT 0,
      total_due REAL NOT NULL,
      start_date TEXT NOT NULL,
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paid', 'overdue', 'cancelled')),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ),
      updated_at TEXT NOT NULL DEFAULT (
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ),
      FOREIGN KEY (borrower_id)
        REFERENCES borrowers(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loan_id INTEGER NOT NULL,
      amount REAL NOT NULL CHECK (amount > 0),
      payment_date TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'cash',
      reference TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ),
      FOREIGN KEY (loan_id)
        REFERENCES loans(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_borrowers_name
      ON borrowers(full_name);

    CREATE INDEX IF NOT EXISTS idx_loans_borrower
      ON loans(borrower_id);

    CREATE INDEX IF NOT EXISTS idx_loans_status
      ON loans(status);

    CREATE INDEX IF NOT EXISTS idx_payments_loan
      ON payments(loan_id);

    PRAGMA user_version = 1;
  `);
}
