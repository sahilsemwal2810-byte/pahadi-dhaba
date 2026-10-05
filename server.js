const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// TiDB Cloud MySQL Connection
const db = mysql.createConnection({
  host: process.env.DB_HOST || 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com',
  port: process.env.DB_PORT || 4000,
  user: process.env.DB_USER || '5FB8d5QXAeqh6eC.root',
  password: process.env.DB_PASSWORD || '0e7rqeZNvkEn8s69',
  database: process.env.DB_NAME || 'test',
  ssl: {
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true
  }
});

db.connect((err) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
  } else {
    console.log('✅ MySQL Database Connected Successfully');
  }
});

// 1. Menu API (कस्टमर मेनू दिखाने के लिए)
app.get('/api/menu', (req, res) => {
  const restaurantId = req.query.restaurant || 1;
  const sql = 'SELECT * FROM menu_items WHERE restaurant_id = ? AND is_available = 1';

  db.query(sql, [restaurantId], (err, results) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(results);
  });
});
    // होटल लॉगिन API
app.post('/api/restaurant/login', (req, res) => {
  const { restaurant_id, password } = req.body;
  const sql = 'SELECT id, name FROM restaurants WHERE id = ? AND password = ?';

  db.query(sql, [restaurant_id, password], (err, results) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Database error' });
    }
    if (results.length === 0) {
      return res.status(401).json({ success: false, message: 'गलत ID या Password!' });
    }
    res.json({ success: true, restaurant: results[0] });
  });
});
// 2. Orders API (कस्टमर का ऑर्डर सेव और लाइव ब्रॉडकास्ट करने के लिए)
app.post('/api/orders', (req, res) => {
  const { restaurant_id, table_no, items, total_amount } = req.body;

  const sqlOrder = 'INSERT INTO orders (restaurant_id, table_no, total_amount, status) VALUES (?, ?, ?, ?)';
  db.query(sqlOrder, [restaurant_id, table_no, total_amount, 'Pending'], (err, result) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Order save nahi ho paya' });
    }

    const orderId = result.insertId;

    // हर आइटम को order_items टेबल में डालना
    const orderItemsData = items.map(item => [orderId, item.id, item.quantity, item.price]);
    const sqlItems = 'INSERT INTO order_items (order_id, item_id, quantity, price) VALUES ?';

    db.query(sqlItems, [orderItemsData], (itemErr) => {
      if (itemErr) {
        console.error(itemErr);
      }

      // Socket.io से तुरंत काउंटर/किचन डैशबोर्ड पर अलर्ट भेजना
      const newOrderPayload = {
        id: orderId,
        table_no: table_no,
        items: items,
        total_amount: total_amount,
        time: new Date().toLocaleTimeString()
      };

      io.emit('new_order', newOrderPayload);

      res.json({ success: true, orderId: orderId });
    });
  });
});

// Socket.io लाइव कनेक्शन
io.on('connection', (socket) => {
  console.log('⚡ Dashboard connected:', socket.id);
});

// सर्वर स्टार्ट
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});