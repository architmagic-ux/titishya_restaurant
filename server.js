const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = socketio(server);
const PORT = process.env.PORT || 3000;

// MongoDB Atlas connection string (unchanged as requested)
const MONGO_URI = 'mongodb+srv://akofficial1905_db_user:FbqAuhCOkXLN0XH1@restaurantdata.kxozvbc.mongodb.net/?appName=RESTAURANTDATA';

mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

mongoose.connection.on('connected', () => {
  console.log('MongoDB connected! (Titishya Fast Food)');
});
mongoose.connection.on('error', (err) => {
  console.error('MongoDB connection error:', err);
});

const orderSchema = new mongoose.Schema({
  orderType: String,
  customerName: String,
  mobile: String,
  tableNumber: String,
  address: String,
  items: Array,
  total: Number,
  status: { type: String, default: 'incoming' },
  createdAt: { type: Date, default: Date.now, index: true }
});
orderSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });

const Order = mongoose.model('Order', orderSchema);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getToday(dateStr) {
  return dateStr || new Date().toISOString().slice(0, 10);
}

app.get('/menu.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/menu.json'));
});

// Get orders for a date (IST Timezone)
app.get('/api/orders', async (req, res) => {
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const nowIST = new Date(Date.now() + IST_OFFSET);
  const date = getToday(req.query.date || nowIST.toISOString().slice(0, 10));
  const start = new Date(Date.parse(date + 'T00:00:00+05:30'));
  const end = new Date(Date.parse(date + 'T23:59:59+05:30'));
  const orders = await Order.find({
    createdAt: { $gte: start, $lte: end },
    status: { $ne: 'deleted' }
  });
  res.json(orders);
});

app.post('/api/orders', async (req, res) => {
  const { orderType, customerName, mobile, tableNumber, address, items } = req.body;
  const total = items.reduce((s, i) => s + i.price * i.qty, 0);
  const order = new Order({
    orderType, customerName, mobile, tableNumber, address,
    items, total
  });
  await order.save();
  io.emit('newOrder', order);
  res.json(order);
});

app.patch('/api/orders/:id/status', async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (order) {
    order.status = req.body.status;
    await order.save();
    io.emit('orderUpdated', order);
    res.json(order);
  } else {
    res.status(404).json({ error: 'Order not found' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// --- FLEXIBLE DASHBOARD ENDPOINTS --- //
// Sales totals and orders for day/week/month OR any custom range
app.get('/api/dashboard/sales', async (req, res) => {
  let { period='day', date, from, to } = req.query;
  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  let start, end;

  if (from && to) {
    start = new Date(Date.parse(from + 'T00:00:00+05:30'));
    end = new Date(Date.parse(to + 'T23:59:59+05:30'));
  } else if(date) {
    const base = new Date(Date.parse(date + 'T00:00:00+05:30'));
    start = base, end = new Date(base);
    if (period === 'day') end.setDate(start.getDate() + 1);
    else if (period === 'week') end.setDate(start.getDate() + 7);
    else if (period === 'month') end.setMonth(start.getMonth() + 1);
  } else {
    const today = new Date();
    start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  }

  const agg = await Order.aggregate([
    { $match: { createdAt: { $gte: start, $lt: end }, status: { $ne: 'deleted' } } },
    { $group: { _id: null, total: { $sum: "$total" }, count: { $sum: 1 } } }
  ]);
  res.json({ total: agg[0]?.total || 0, count: agg[0]?.count || 0 });
});

// Most ordered dish in any period
app.get('/api/dashboard/topdish', async (req, res) => {
  let { date, from, to } = req.query;
  let match = { status: { $ne: 'deleted' } };
  if (from && to) {
    match.createdAt = {
      $gte: new Date(Date.parse(from + 'T00:00:00+05:30')),
      $lt: new Date(Date.parse(to + 'T23:59:59+05:30'))
    };
  } else if (date) {
    match.createdAt = {
      $gte: new Date(Date.parse(date + 'T00:00:00+05:30')),
      $lt: new Date(Date.parse(date + 'T23:59:59+05:30'))
    };
  }
  const agg = await Order.aggregate([
    { $match: match },
    { $unwind: "$items" },
    { $group: { _id: "$items.name", count: { $sum: "$items.qty" } } },
    { $sort: { count: -1 } }, { $limit: 1 }
  ]);
  res.json(agg[0]);
});

// Repeat customers in any period, with optional name filter
app.get('/api/dashboard/repeatcustomers', async (req, res) => {
  let { month, from, to, name } = req.query;
  let match = { status: { $ne: 'deleted' } };

  if (from && to) {
    match.createdAt = {
      $gte: new Date(Date.parse(from + 'T00:00:00+05:30')),
      $lt: new Date(Date.parse(to + 'T23:59:59+05:30'))
    };
  } else if (month) {
    let s = new Date(month + "-01T00:00:00+05:30");
    let e = new Date(s); e.setMonth(s.getMonth() + 1);
    match.createdAt = { $gte: s, $lt: e };
  }
  if (name) {
    match.customerName = name;
  }
  const agg = await Order.aggregate([
    { $match: match },
    { $group: { _id: "$customerName", orders: { $sum: 1 } } },
    { $match: { orders: { $gte: 2 } } }, // only repeat, flexible!
    { $sort: { orders: -1 } }
  ]);
  res.json(agg);
});

// Peak hour remains, uses "date" param
app.get('/api/dashboard/peakhour', async (req, res) => {
  const { date } = req.query;
  const start = new Date(Date.parse(date + 'T00:00:00+05:30'));
  const end = new Date(Date.parse(date + 'T23:59:59+05:30'));
  const agg = await Order.aggregate([
    { $match: { createdAt: { $gte: start, $lt: end }, status: { $ne: 'deleted' } } },
    { $group: { _id: { hour: { $hour: "$createdAt" } }, count: { $sum: 1 } } },
    { $sort: { count: -1 } }, { $limit: 1 }
  ]);
  res.json(agg[0]);
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
  console.log('Open index.html and manager.html in browser');
});

io.on('connection', (socket) => { /* no special handling needed */ });
