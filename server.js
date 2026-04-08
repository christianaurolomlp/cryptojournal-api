import express from 'express'
import cors from 'cors'
import pg from 'pg'

const { Pool } = pg

const app = express()
const PORT = process.env.PORT || 3000
const API_KEY = process.env.API_KEY
const ALLOWED_ORIGINS = [
  'https://christianaurolomlp.github.io',
  'http://localhost:5173',
  'http://localhost:4173'
]

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true)
    cb(null, false)
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key']
}))

app.use(express.json({ limit: '5mb' }))

// Auth middleware
function auth(req, res, next) {
  if (!API_KEY) return next() // no key configured = open (dev)
  const key = req.headers['x-api-key']
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

// ── Database ─────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false
})

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  console.log('✓ Database tables ready')
}

// ── Routes: Trades ───────────────────────────────────────────────────────────
app.get('/api/trades', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, data FROM trades ORDER BY created_at DESC')
    const trades = result.rows.map(r => ({ ...r.data, id: r.id }))
    res.json(trades)
  } catch (err) {
    console.error('GET /api/trades error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.post('/api/trades', auth, async (req, res) => {
  try {
    const trade = req.body
    if (!trade.id) return res.status(400).json({ error: 'Missing trade id' })
    const { id, ...data } = trade
    await pool.query(
      `INSERT INTO trades (id, data) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [id, data]
    )
    res.json({ ok: true, id })
  } catch (err) {
    console.error('POST /api/trades error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.put('/api/trades/:id', auth, async (req, res) => {
  try {
    const { id } = req.params
    const trade = req.body
    const { id: _, ...data } = trade
    const result = await pool.query(
      `UPDATE trades SET data = $1, updated_at = NOW() WHERE id = $2`,
      [data, id]
    )
    if (result.rowCount === 0) {
      // Upsert - create if not exists
      await pool.query(`INSERT INTO trades (id, data) VALUES ($1, $2)`, [id, data])
    }
    res.json({ ok: true, id })
  } catch (err) {
    console.error('PUT /api/trades error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.delete('/api/trades/month/:yearMonth', auth, async (req, res) => {
  try {
    const { yearMonth } = req.params
    // yearMonth = "2026-01"
    // Trades store date in data->>'date' as ISO string or "YYYY-MM-DD"
    const result = await pool.query(
      `DELETE FROM trades WHERE data->>'date' LIKE $1 || '%' RETURNING id`,
      [yearMonth]
    )
    res.json({ ok: true, deleted: result.rowCount, month: yearMonth })
  } catch (err) {
    console.error('DELETE /api/trades/month error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.delete('/api/trades/:id', auth, async (req, res) => {
  try {
    const { id } = req.params
    await pool.query('DELETE FROM trades WHERE id = $1', [id])
    res.json({ ok: true })
  } catch (err) {
    console.error('DELETE /api/trades error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Routes: Bulk import (for migration) ──────────────────────────────────────
app.post('/api/trades/bulk', auth, async (req, res) => {
  try {
    const { trades } = req.body
    if (!Array.isArray(trades)) return res.status(400).json({ error: 'trades must be array' })

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const trade of trades) {
        const { id, ...data } = trade
        await client.query(
          `INSERT INTO trades (id, data) VALUES ($1, $2)
           ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
          [id, data]
        )
      }
      await client.query('COMMIT')
      res.json({ ok: true, count: trades.length })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  } catch (err) {
    console.error('POST /api/trades/bulk error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Routes: Settings (caps, etc) ─────────────────────────────────────────────
app.get('/api/settings/:key', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT value FROM settings WHERE key = $1', [req.params.key])
    if (result.rows.length === 0) return res.json({ value: null })
    res.json({ value: result.rows[0].value })
  } catch (err) {
    console.error('GET /api/settings error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

app.put('/api/settings/:key', auth, async (req, res) => {
  try {
    const { value } = req.body
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [req.params.key, value]
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('PUT /api/settings error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ── Start ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✓ CryptoJournal API running on port ${PORT}`)
  })
}).catch(err => {
  console.error('Failed to initialize database:', err)
  process.exit(1)
})
