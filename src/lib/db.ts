import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

// Initialize PostgreSQL connection pool
export const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

console.log("Database pool initialized.");

// Optional: Add graceful shutdown for the pool here if it makes sense
// process.on('SIGTERM', async () => { ... dbPool.end() ... });
// process.on('SIGINT', async () => { ... dbPool.end() ... });
