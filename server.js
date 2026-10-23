const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// डिफ़ॉल्ट रूट - सीधे KOT डैशबोर्ड खुलेगा
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ---------- Database (TiDB Cloud) ----------
// Credentials sirf environment variables se aayenge, code me nahi.
const required = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('❌ Ye environment variables set karein:', missing.join(', '));
  process.exit(1);
}

const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 4000,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
  waitForConnections: true,
  connectionLimit: 10
});

// Har naye connection par session timezone IST kar do
db.on('connection', (conn) => {
  conn.query("SET time_zone = '+05:30'");
});

db.query('SELECT 1', (err) => {
  if (err) console.error('❌ Database connection check failed:', err.message);
  else console.log('✅ TiDB Pool Connected Successfully!');
});

// IST time helper
function getISTTime() {
  return new Date().toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
}

// ---------- Auth (dashboard ke liye) ----------
const authTokens = new Map(); // token -> restaurant_id

function requireAuth(req, res, next) {
  const rid = authTokens.get(req.headers['x-auth-token']);
  if (!rid) return res.status(401).json({ error: 'Login zaroori hai' });
  req.restaurantId = rid;
  next();
}

// ---------- 1. Menu API ----------
// Response: { restaurantName, items: [...] }
app.get('/api/menu', (req, res) => {
  const restaurantId = Number(req.query.restaurant) || 1;

  db.query('SELECT name FROM restaurants WHERE id = ?', [restaurantId], (err, rest) => {
    if (err) {
      console.error('Restaurant fetch error:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    const sql = 'SELECT * FROM menu_items WHERE restaurant_id = ? AND is_available = 1';
    db.query(sql, [restaurantId], (err2, items) => {
      if (err2) {
        console.error('Menu fetch error:', err2);
        return res.status(500).json({ error: 'Database error' });
      }
      res.json({
        restaurantName: rest.length ? rest[0].name : null,
        items: items
      });
    });
  });
});

// ---------- Dashboard: menu manage (price / available) ----------
// Saare items (unavailable bhi) dikhane ke liye
app.get('/api/admin/menu', requireAuth, (req, res) => {
  const sql = 'SELECT id, name, name_en, name_pa, price, is_available FROM menu_items WHERE restaurant_id = ? ORDER BY id';
  db.query(sql, [req.restaurantId], (err, results) => {
    if (err) {
      console.error('Admin menu fetch error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(results);
  });
});

// Price aur/ya availability badalna
app.put('/api/admin/menu/:id', requireAuth, (req, res) => {
  const itemId = Number(req.params.id);
  const fields = [];
  const values = [];

  if (req.body.price !== undefined) {
    const price = Number(req.body.price);
    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ error: 'Price sahi nahi hai' });
    }
    fields.push('price = ?');
    values.push(price);
  }
  if (req.body.is_available !== undefined) {
    fields.push('is_available = ?');
    values.push(req.body.is_available ? 1 : 0);
  }
  // Teeno bhasha ke naam (dashboard hamesha teeno ek saath bhejta hai)
  // `name` = हिंदी / mukhya naam (KOT me yahi chhapta hai), name_en = English, name_pa = ਪੰਜਾਬੀ
  const nameKeys = ['name', 'name_en', 'name_pa'];
  if (nameKeys.every((k) => req.body[k] !== undefined)) {
    const n = nameKeys.map((k) => String(req.body[k] || '').trim().slice(0, 100));
    if (!n[0] && !n[1] && !n[2]) {
      return res.status(400).json({ error: 'Kam se kam ek naam zaroori hai' });
    }
    fields.push('name = ?', 'name_en = ?', 'name_pa = ?');
    values.push(n[0] || n[1] || n[2], n[1] || null, n[2] || null);
  }

  if (!itemId || fields.length === 0) {
    return res.status(400).json({ error: 'Kuch badalne ko nahi mila' });
  }

  // restaurant_id check: koi dusre hotel ka item nahi badal sakta
  const sql = `UPDATE menu_items SET ${fields.join(', ')} WHERE id = ? AND restaurant_id = ?`;
  db.query(sql, [...values, itemId, req.restaurantId], (err, result) => {
    if (err) {
      console.error('Admin menu update error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Item nahi mila' });
    }
    res.json({ success: true });
  });
});

// नया dish जोड़ना
app.post('/api/admin/menu', requireAuth, (req, res) => {
  const clean = (v) => String(v || '').trim().slice(0, 100);
  const nameHi = clean(req.body.name);
  const name_en = clean(req.body.name_en);
  const name_pa = clean(req.body.name_pa);
  const price = Number(req.body.price);
  // `name` = हिंदी / KOT me dikhne wala mukhya naam (khali ho to koi aur bhasha)
  const name = nameHi || name_en || name_pa;

  if (!name) {
    return res.status(400).json({ error: 'Kam se kam ek bhasha me naam zaroori hai' });
  }
  if (!Number.isFinite(price) || price < 0) {
    return res.status(400).json({ error: 'Price sahi nahi hai' });
  }

  const sql =
    'INSERT INTO menu_items (restaurant_id, name, name_en, name_pa, price, is_available) VALUES (?, ?, ?, ?, ?, 1)';
  db.query(
    sql,
    [req.restaurantId, name, name_en || null, name_pa || null, price],
    (err, result) => {
      if (err) {
        console.error('Admin menu insert error:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      res.json({ success: true, id: result.insertId });
    }
  );
});

// Dish हटाना
// Agar dish purane orders me use hui hai aur database delete nahi hone deta,
// to use hata-ne ki jagah "unavailable" kar dete hain.
app.delete('/api/admin/menu/:id', requireAuth, (req, res) => {
  const itemId = Number(req.params.id);
  if (!itemId) return res.status(400).json({ error: 'Item ID sahi nahi hai' });

  db.query(
    'DELETE FROM menu_items WHERE id = ? AND restaurant_id = ?',
    [itemId, req.restaurantId],
    (err, result) => {
      if (err) {
        if (err.errno === 1451 || err.code === 'ER_ROW_IS_REFERENCED_2') {
          return db.query(
            'UPDATE menu_items SET is_available = 0 WHERE id = ? AND restaurant_id = ?',
            [itemId, req.restaurantId],
            (err2) => {
              if (err2) return res.status(500).json({ error: 'Database error' });
              res.json({ success: true, deleted: false });
            }
          );
        }
        console.error('Admin menu delete error:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'Item nahi mila' });
      }
      res.json({ success: true, deleted: true });
    }
  );
});

// ---------- होटल लॉगिन API ----------
app.post('/api/restaurant/login', (req, res) => {
  let { restaurant_id, password } = req.body;
  restaurant_id = String(restaurant_id).trim();
  password = String(password).trim();

  const sql = 'SELECT id, name, password FROM restaurants WHERE id = ?';
  db.query(sql, [restaurant_id], (err, results) => {
    if (err) {
      console.error('Login error:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    if (results.length === 0) {
      return res.status(401).json({ success: false, message: 'गलत ID!' });
    }

    const restaurant = results[0];
    if (String(restaurant.password).trim() !== password) {
      return res.status(401).json({ success: false, message: 'गलत Password!' });
    }

    // Login token (server memory me; restart par dobara login karna hoga)
    const token = crypto.randomBytes(24).toString('hex');
    authTokens.set(token, restaurant.id);

    res.json({
      success: true,
      token: token,
      restaurant: { id: restaurant.id, name: restaurant.name }
    });
  });
});

// ---------- 2. Orders API ----------
app.post('/api/orders', (req, res) => {
  const { table_no, items, total_amount } = req.body;
  const restaurantId = Number(req.body.restaurant_id) || 1;

  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'कोई आइटम नहीं चुना गया' });
  }

  const sqlOrder =
    'INSERT INTO orders (restaurant_id, table_no, total_amount, status) VALUES (?, ?, ?, ?)';

  db.query(sqlOrder, [restaurantId, String(table_no), total_amount, 'Pending'], (err, result) => {
    if (err) {
      console.error('❌ Order Insert Error:', err);
      return res.status(500).json({ error: 'Order save nahi ho paya' });
    }

    const orderId = result.insertId;
    const orderItemsData = items.map((i) => [orderId, i.id, i.quantity, i.price]);
    const sqlItems = 'INSERT INTO order_items (order_id, item_id, quantity, price) VALUES ?';

    db.query(sqlItems, [orderItemsData], (itemErr) => {
      if (itemErr) {
        console.error('❌ Items Insert Error:', itemErr);
        // Adhura order hata do, taaki database saaf rahe
        db.query('DELETE FROM orders WHERE id = ?', [orderId]);
        return res.status(500).json({ error: 'Items save nahi ho paye, dobara try karein' });
      }

      const newOrderPayload = {
        id: orderId,
        table_no: table_no,
        items: items,
        total_amount: total_amount,
        time: getISTTime(),
        created_at: new Date().toISOString()
      };

      // Sirf usi hotel ke dashboard ko bhejo
      io.to(`restaurant_${restaurantId}`).emit('new_order', newOrderPayload);

      res.json({ success: true, orderId: orderId });
    });
  });
});

// ---------- Socket.io ----------
io.on('connection', (socket) => {
  console.log('⚡ Dashboard connected:', socket.id);

  socket.on('join_restaurant', (id) => {
    const rid = Number(id);
    if (rid) socket.join(`restaurant_${rid}`);
  });
});

// सर्वर स्टार्ट
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});