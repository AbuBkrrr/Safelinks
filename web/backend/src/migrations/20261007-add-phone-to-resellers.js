// One-time migration: add `phone` column to resellers.
// Safe to run repeatedly (uses IF NOT EXISTS).

import { pool } from "../db.js";

export async function runMigration() {
  await pool.query(`
    ALTER TABLE resellers
    ADD COLUMN IF NOT EXISTS phone TEXT
  `);
  console.log("✔ Migration: resellers.phone ensured");
}
