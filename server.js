const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const webpush = require('web-push');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- KONEKSI KE SUPABASE ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- VAPID KEY (BENER & PAS 65 KARAKTER) ---
const VAPID_PUBLIC_KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const VAPID_PRIVATE_KEY = 'UUxI4O8-FbRouAevSmBQ6o18hgL2G7mjG2g1gK2dX2I';
webpush.setVapidDetails('mailto:admin@classxi5.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// --- SESSION STORE ---
app.use(session({
    store: new pgSession({ pool: pool, tableName: 'session', createTableIfMissing: true }),
    secret: 'super-secret-key-class-xi5',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// --- HEALTH CHECK (BUAT BACK4APP) ---
app.get('/health', (req, res) => res.status(200).send('OK'));

// --- FUNGSI INIT DATABASE ---
async function initDB() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE, password TEXT, role TEXT DEFAULT 'siswa', full_name TEXT, avatar_url TEXT);
            CREATE TABLE IF NOT EXISTS tasks (id SERIAL PRIMARY KEY, subject TEXT, title TEXT, description TEXT, due_date TIMESTAMP, created_by INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, sender_id INTEGER, receiver_id INTEGER, message TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS attendance (id SERIAL PRIMARY KEY, user_id INTEGER, status TEXT, date DATE DEFAULT CURRENT_DATE);
            CREATE TABLE IF NOT EXISTS subscriptions (id SERIAL PRIMARY KEY, user_id INTEGER, endpoint TEXT UNIQUE, p256dh TEXT, auth TEXT);
            CREATE TABLE IF NOT EXISTS schedules (id SERIAL PRIMARY KEY, day TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, subject TEXT NOT NULL, teacher TEXT, room TEXT);
        `);
        const res = await client.query(`SELECT * FROM users WHERE username = 'admin'`);
        if (res.rows.length === 0) {
            const hash = bcrypt.hashSync('admin123', 10);
            await client.query(`INSERT INTO users (username, password, role, full_name, avatar_url) VALUES ('admin', $1, 'admin', 'ADMIN-REX', 'https://ui-avatars.com/api/?name=Admin+Rex&background=6c5ce7&color=fff')`, [hash]);
        }
        console.log('Database Supabase siap.');
    } catch (err) {
        console.error('Gagal init DB:', err);
    } finally {
        client.release();
    }
}

// --- AUTH MIDDLEWARE ---
const requireAuth = (req, res, next) => { if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' }); next(); };
const requireAdmin = (req, res, next) => { if (req.session.role !== 'admin') return res.status(403).json({ error: 'Forbidden' }); next(); };

// --- API ROUTES ---
app.get('/api/vapid-public-key', (req, res) => res.send(VAPID_PUBLIC_KEY));

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
        const user = result.rows[0];
        if (user && bcrypt.compareSync(password, user.password)) {
            req.session.userId = user.id;
            req.session.role = user.role;
            req.session.fullName = user.full_name;
            req.session.avatar = user.avatar_url || `https://ui-avatars.com/api/?name=${user.full_name}&background=random`;
            res.json({ success: true, role: user.role });
        } else {
            res.status(401).json({ success: false, message: 'Username atau password salah' });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/register', async (req, res) => {
    const { username, password, full_name } = req.body;
    if (!username || !password || !full_name) return res.status(400).json({ success: false, message: 'Semua field harus diisi' });
    if (username.length < 3 || password.length < 6) return res.status(400).json({ success: false, message: 'Username min 3, password min 6' });
    try {
        const exist = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
        if (exist.rows.length > 0) return res.status(409).json({ success: false, message: 'Username sudah dipakai' });
        const hash = bcrypt.hashSync(password, 10);
        const avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(full_name)}&background=random&color=fff`;
        await pool.query(`INSERT INTO users (username, password, role, full_name, avatar_url) VALUES ($1, $2, 'siswa', $3, $4)`, [username, hash, full_name, avatar]);
        res.json({ success: true, message: 'Registrasi berhasil' });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/me', requireAuth, (req, res) => res.json({ id: req.session.userId, role: req.session.role, name: req.session.fullName, avatar: req.session.avatar }));

app.get('/api/tasks', requireAuth, async (req, res) => {
    const result = await pool.query(`SELECT * FROM tasks ORDER BY created_at DESC`);
    res.json(result.rows);
});

app.post('/api/tasks', requireAuth, requireAdmin, async (req, res) => {
    const { subject, title, description, due_date } = req.body;
    const result = await pool.query(`INSERT INTO tasks (subject, title, description, due_date, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [subject, title, description, due_date, req.session.userId]);
    const notifMessage = `Tugas Baru [${subject}]: ${title}. Deadline: ${new Date(due_date).toLocaleString()}`;
    io.emit('new_task_broadcast', { id: result.rows[0].id, subject, title, description, due_date, notifMessage });
    res.json({ success: true, id: result.rows[0].id });
});

app.get('/api/schedules', requireAuth, async (req, res) => {
    const result = await pool.query(`SELECT * FROM schedules ORDER BY CASE day WHEN 'Senin' THEN 1 WHEN 'Selasa' THEN 2 WHEN 'Rabu' THEN 3 WHEN 'Kamis' THEN 4 WHEN 'Jumat' THEN 5 ELSE 6 END, start_time ASC`);
    res.json(result.rows);
});

app.post('/api/schedules', requireAuth, requireAdmin, async (req, res) => {
    const { day, start_time, end_time, subject, teacher, room } = req.body;
    const allowedDays = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat'];
    if (!allowedDays.includes(day)) return res.status(400).json({ error: 'Hanya Senin-Jumat' });
    const result = await pool.query(`INSERT INTO schedules (day, start_time, end_time, subject, teacher, room) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [day, start_time, end_time, subject, teacher || '-', room || '-']);
    io.emit('schedule_updated'); 
    res.json({ success: true, id: result.rows[0].id });
});

app.delete('/api/schedules/:id', requireAuth, requireAdmin, async (req, res) => {
    await pool.query(`DELETE FROM schedules WHERE id = $1`, [req.params.id]);
    io.emit('schedule_updated');
    res.json({ success: true });
});

app.get('/api/users', requireAuth, async (req, res) => {
    const result = await pool.query(`SELECT id, username, full_name, avatar_url, role FROM users WHERE id != $1`, [req.session.userId]);
    res.json(result.rows);
});

app.get('/api/messages/:receiverId', requireAuth, async (req, res) => {
    const receiverId = req.params.receiverId;
    let result;
    if (receiverId === 'group') {
        result = await pool.query(`SELECT m.*, u.full_name, u.avatar_url FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.receiver_id IS NULL ORDER BY m.created_at ASC LIMIT 100`);
    } else {
        result = await pool.query(`SELECT m.*, u.full_name, u.avatar_url FROM messages m JOIN users u ON m.sender_id = u.id WHERE (m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1) ORDER BY m.created_at ASC LIMIT 100`, [req.session.userId, receiverId]);
    }
    res.json(result.rows);
});

app.post('/api/subscribe', requireAuth, async (req, res) => {
    const sub = req.body;
    await pool.query(`INSERT INTO subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4) ON CONFLICT (endpoint) DO NOTHING`, [req.session.userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth]);
    res.json({ success: true });
});

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    socket.on('join_chat', (data) => {
        if (data.room === 'group') socket.join('group_chat');
        else socket.join(`user_${data.userId}`);
    });

    socket.on('send_message', async (data) => {
        const { sender_id, receiver_id, message, sender_name, sender_avatar } = data;
        const dbReceiverId = (receiver_id === 'group') ? null : receiver_id;
        const result = await pool.query(`INSERT INTO messages (sender_id, receiver_id, message) VALUES ($1, $2, $3) RETURNING id, created_at`, [sender_id, dbReceiverId, message]);
        const msgData = { id: result.rows[0].id, sender_id, receiver_id: dbReceiverId, message, full_name: sender_name, avatar_url: sender_avatar, created_at: result.rows[0].created_at };
        if (dbReceiverId === null) {
            io.to('group_chat').emit('receive_message', msgData);
        } else {
            io.to(`user_${receiver_id}`).emit('receive_message', msgData);
            socket.emit('receive_message', msgData);
        }
    });
});

// --- ROUTING HTML ---
app.get('/', (req, res) => { if (req.session.userId) return res.redirect('/dashboard'); res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/dashboard', (req, res) => { if (!req.session.userId) return res.redirect('/'); res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); });
app.get('/chat', (req, res) => { if (!req.session.userId) return res.redirect('/'); res.sendFile(path.join(__dirname, 'public', 'chat.html')); });

// --- NYALAIN SERVER DULU, BARU KONEK DB ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    initDB().catch(console.error);
});