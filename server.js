
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// DB credentials SIRF environment variables se (.env / hosting settings)
const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 4000,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'test',
  ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true }
});
const dbp = db.promise();

db.query('SELECT 1', (err) => {
  if (err) console.error('❌ DB connection failed:', err.message);
  else console.log('✅ TiDB Pool Connected!');
});

const istTime = (d) =>
  new Date(d || Date.now()).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true
  });

// 1. Menu API -> { restaurantName, items }
app.get('/api/menu', async (req, res) => {
  const rid = Number(req.query.restaurant) || 1;
  try {
    const [[rest]] = await dbp.query('SELECT name FROM restaurants WHERE id = ?', [rid]);
    const [items] = await dbp.query(
      'SELECT * FROM menu_items WHERE restaurant_id = ? AND is_available = 1', [rid]);
    res.json({ restaurantName: rest ? rest.name : '', items });
  } catch (err) {
    console.error('Menu error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Login
app.post('/api/restaurant/login', async (req, res) => {
  const id = String(req.body.restaurant_id || '').trim();
  const password = String(req.body.password || '').trim();
  try {
    const [rows] = await dbp.query('SELECT id, name, password FROM restaurants WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(401).json({ success: false, message: 'गलत ID!' });
    if (String(rows[0].password).trim() !== password)
      return res.status(401).json({ success: false, message: 'गलत Password!' });
    res.json({ success: true, restaurant: { id: rows[0].id, name: rows[0].name } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// 2. Place order (price server se nikalta hai, browser par bharosa nahi)
app.post('/api/orders', async (req, res) => {
  const restaurantId = Number(req.body.restaurant_id) || 1;
  const tableNo = String(req.body.table_no || '').slice(0, 10);
  const reqItems = Array.isArray(req.body.items) ? req.body.items : [];

  if (reqItems.length === 0) return res.status(400).json({ error: 'कोई आइटम नहीं चुना गया' });

  try {
    const ids = reqItems.map((i) => Number(i.id));
    const [menu] = await dbp.query(
      'SELECT id, name, price FROM menu_items WHERE restaurant_id = ? AND is_available = 1 AND id IN (?)',
      [restaurantId, ids]);
    const byId = new Map(menu.map((m) => [m.id, m]));

    const items = [];
    let total = 0;
    for (const r of reqItems) {
      const m = byId.get(Number(r.id));
      const qty = Math.floor(Number(r.quantity));
      if (!m || !(qty >= 1 && qty <= 50)) return res.status(400).json({ error: 'गलत आइटम' });
      items.push({ id: m.id, name: m.name, price: Number(m.price), quantity: qty });
      total += Number(m.price) * qty;
    }

    const [result] = await dbp.query(
      'INSERT INTO orders (restaurant_id, table_no, total_amount, status) VALUES (?, ?, ?, ?)',
      [restaurantId, tableNo, total, 'Pending']);
    const orderId = result.insertId;

    await dbp.query('INSERT INTO order_items (order_id, item_name, quantity, price) VALUES ?',
  [items.map((i) => [orderId, i.name, i.quantity, i.price])]);

    io.to(`restaurant_${restaurantId}`).emit('new_order', {
      id: orderId, table_no: tableNo, items, total_amount: total, time: istTime()
    });

    res.json({ success: true, orderId });
  } catch (err) {
    console.error('Order error:', err);
    res.status(500).json({ error: 'Order save nahi ho paya' });
  }
});

// 3. Pending orders (dashboard reload par wapas dikhane ke liye)
app.get('/api/orders/pending', async (req, res) => {
  const rid = Number(req.query.restaurant);
  if (!rid) return res.status(400).json({ error: 'restaurant required' });
  try {
    const [rows] = await dbp.query(
            `SELECT o.id, o.table_no, o.total_amount, o.created_at,
              oi.quantity, oi.price, oi.item_name AS name
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.restaurant_id = ? AND o.status = 'Pending'
       ORDER BY o.id ASC`, [rid]);
       
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.id)) {
        map.set(r.id, {
          id: r.id, table_no: r.table_no, total_amount: r.total_amount,
          time: istTime(r.created_at), items: []
        });
      }
      map.get(r.id).items.push({ name: r.name, price: Number(r.price), quantity: r.quantity });
    }
    res.json([...map.values()]);
  } catch (err) {
    console.error('Pending error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// 4. Order "पूरा हुआ"
app.patch('/api/orders/:id/done', async (req, res) => {
  try {
    await dbp.query("UPDATE orders SET status = 'Done' WHERE id = ?", [Number(req.params.id)]);
    res.json({ success: true });
  } catch (err) {
    console.error('Done error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Socket.io rooms: har hotel ko sirf apne orders
io.on('connection', (socket) => {
  socket.on('join_restaurant', (id) => {
    socket.join(`restaurant_${Number(id)}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));