const path = require("path");
const fs = require("fs/promises");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");
require("dotenv").config();

const dbFile = process.env.DB_FILE || "./data/genealogy.sqlite";

async function initDb() {
  const absoluteDbPath = path.resolve(process.cwd(), dbFile);
  await fs.mkdir(path.dirname(absoluteDbPath), { recursive: true });

  const db = await open({
    filename: absoluteDbPath,
    driver: sqlite3.Database
  });

  await db.exec("PRAGMA foreign_keys = ON");

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      gender TEXT NULL,
      birth_date TEXT NULL,
      death_date TEXT NULL,
      is_deceased INTEGER NOT NULL DEFAULT 0,
      photo_url TEXT NULL,
      notes TEXT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_person_id INTEGER NOT NULL,
      target_person_id INTEGER NOT NULL,
      relationship_type TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT NULL,
      FOREIGN KEY (source_person_id) REFERENCES people(id),
      FOREIGN KEY (target_person_id) REFERENCES people(id)
    );

    CREATE TABLE IF NOT EXISTS change_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      action_type TEXT NOT NULL,
      entity_id INTEGER NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by INTEGER NOT NULL,
      reviewed_by INTEGER NULL,
      review_note TEXT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TEXT NULL,
      FOREIGN KEY (requested_by) REFERENCES users(id),
      FOREIGN KEY (reviewed_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const defaultAdminPin = process.env.ADMIN_PIN || "admin";
  await db.run("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('admin_pin', ?)", [defaultAdminPin]);

  const peopleCols = await db.all("PRAGMA table_info(people)");
  const peopleColNames = new Set(peopleCols.map((c) => c.name));
  if (!peopleColNames.has("is_deceased")) {
    await db.exec("ALTER TABLE people ADD COLUMN is_deceased INTEGER NOT NULL DEFAULT 0");
  }
  if (!peopleColNames.has("death_date")) {
    await db.exec("ALTER TABLE people ADD COLUMN death_date TEXT NULL");
  }
  if (!peopleColNames.has("photo_url")) {
    await db.exec("ALTER TABLE people ADD COLUMN photo_url TEXT NULL");
  }

  await db.run("INSERT INTO users (name, is_admin) SELECT 'Admin', 1 WHERE NOT EXISTS (SELECT 1 FROM users WHERE name = 'Admin')");
  await db.run("INSERT INTO users (name, is_admin) SELECT 'Contributor', 0 WHERE NOT EXISTS (SELECT 1 FROM users WHERE name = 'Contributor')");

  return db;
}

module.exports = { initDb };
