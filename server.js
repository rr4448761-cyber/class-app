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

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const VAPID_PUBLIC_KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const VAPID_PRIVATE_KEY = 'UUxI4O8-FbRouAevSmBQ6o18hgL2G7mjG2g1gK2dX2I';
webpush.setVapidDetails('mailto:admin@classxi5.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    store: new pgSession({ pool: pool, tableName: 'session', createTableIfMissing: true }),
    secret: 'super-secret-key-class-xi5',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.get('/health', (req, res) => res.status(200).send('OK'));

async function initDB() {
    const client = await pool.connect();
    try {
        // BIKIN SEMUA TABEL DARI NOL
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE, password TEXT, plain_password TEXT, role TEXT DEFAULT 'siswa', full_name TEXT, avatar_url TEXT);
            CREATE TABLE IF NOT EXISTS tasks (id SERIAL PRIMARY KEY, subject TEXT, title TEXT, description TEXT, due_date TIMESTAMP, created_by INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, sender_id INTEGER, receiver_id INTEGER, message TEXT, media TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS attendance (id SERIAL PRIMARY KEY, user_id INTEGER, status TEXT, date DATE DEFAULT CURRENT_DATE);
            CREATE TABLE IF NOT EXISTS schedules (id SERIAL PRIMARY KEY, day TEXT, start_time TEXT, end_time TEXT, subject TEXT, teacher TEXT, room TEXT);
            CREATE TABLE IF NOT EXISTS grades (id SERIAL PRIMARY KEY, user_id INTEGER, subject TEXT, score INTEGER, type TEXT);
            CREATE TABLE IF NOT EXISTS exams (id SERIAL PRIMARY KEY, subject TEXT, title TEXT, exam_date TIMESTAMP);
            CREATE TABLE IF NOT EXISTS library (id SERIAL PRIMARY KEY, title TEXT, subject TEXT, link TEXT);
            CREATE TABLE IF NOT EXISTS finance (id SERIAL PRIMARY KEY, user_id INTEGER, amount INTEGER, status TEXT, description TEXT);
            CREATE TABLE IF NOT EXISTS stories (id SERIAL PRIMARY KEY, user_id INTEGER, media TEXT, text TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
        `);
        
        // Bersihin tabel lama yang mungkin bikin error kolom
        try { await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plain_password TEXT;`); } catch(e){}

        const res = await client.query(`SELECT * FROM users WHERE username = 'ikyaja'`);
        if (res.rows.length === 0) {
            const hash = bcrypt.hashSync('ikyy2010', 10);
            await client.query(`INSERT INTO users (username, password, plain_password, role, full_name, avatar_url) VALUES ('admin', $1, 'admin123', 'admin', 'ADMIN-REX', NULL)`, [hash]);
        }
        console.log('Semua Tabel Database Supabase Siap.');
    } catch (err) { console.error('Gagal init DB:', err); } finally { client.release(); }
}

const requireAuth = (req, res, next) => { if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' }); next(); };
const requireAdmin = (req, res, next) => { if (req.session.role !== 'admin') return res.status(403).json({ error: 'Forbidden' }); next(); };

// --- AUTH & PROFIL ---
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
        const user = result.rows[0];
        if (user && bcrypt.compareSync(password, user.password)) {
            req.session.userId = user.id; req.session.role = user.role; req.session.fullName = user.full_name;
            res.json({ success: true, role: user.role });
        } else res.status(401).json({ success: false, message: 'Username atau password salah' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/register', async (req, res) => {
    const { username, password, full_name } = req.body;
    try {
        const exist = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
        if (exist.rows.length > 0) return res.status(409).json({ success: false, message: 'Username sudah dipakai' });
        const hash = bcrypt.hashSync(password, 10);
        await pool.query(`INSERT INTO users (username, password, plain_password, role, full_name) VALUES ($1, $2, $3, 'siswa', $4)`, [username, hash, password, full_name]);
        res.json({ success: true, message: 'Registrasi berhasil' });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/me', requireAuth, async (req, res) => {
    const result = await pool.query(`SELECT id, role, full_name, avatar_url FROM users WHERE id = $1`, [req.session.userId]);
    res.json({ id: result.rows[0].id, role: result.rows[0].role, name: result.rows[0].full_name, avatar: result.rows[0].avatar_url });
});
app.post('/api/profile/avatar', requireAuth, async (req, res) => {
    await pool.query(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [req.body.avatar, req.session.userId]);
    res.json({ success: true });
});

// --- ADMIN PANEL API ---
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
    const result = await pool.query(`SELECT id, username, plain_password, full_name, role FROM users ORDER BY id ASC`);
    res.json(result.rows);
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
    const targetId = req.params.id;
    if (targetId == req.session.userId) return res.status(400).json({error: 'Tidak bisa hapus diri sendiri'});
    await pool.query(`DELETE FROM users WHERE id = $1`, [targetId]);
    res.json({ success: true });
});

// --- 8 FITUR UTAMA (BROADCAST & GET) ---
app.get('/api/tasks', requireAuth, async (req, res) => { const r = await pool.query(`SELECT * FROM tasks ORDER BY created_at DESC`); res.json(r.rows); });
app.post('/api/tasks', requireAuth, requireAdmin, async (req, res) => {
    const { subject, title, description, due_date } = req.body;
    await pool.query(`INSERT INTO tasks (subject, title, description, due_date) VALUES ($1, $2, $3, $4)`, [subject, title, description, due_date]);
    io.emit('new_notif', { title: 'Tugas Baru!', msg: `Mapel ${subject}: ${title}` });
    res.json({ success: true });
});

app.get('/api/schedules', requireAuth, async (req, res) => { const r = await pool.query(`SELECT * FROM schedules ORDER BY day ASC`); res.json(r.rows); });
app.post('/api/schedules', requireAuth, requireAdmin, async (req, res) => {
    const { day, start_time, end_time, subject, teacher, room } = req.body;
    await pool.query(`INSERT INTO schedules (day, start_time, end_time, subject, teacher, room) VALUES ($1, $2, $3, $4, $5, $6)`, [day, start_time, end_time, subject, teacher, room]);
    io.emit('new_notif', { title: 'Jadwal Baru!', msg: `Hari ${day}: ${subject}` });
    res.json({ success: true });
});

app.get('/api/exams', requireAuth, async (req, res) => { const r = await pool.query(`SELECT * FROM exams ORDER BY exam_date ASC`); res.json(r.rows); });
app.post('/api/exams', requireAuth, requireAdmin, async (req, res) => {
    const { subject, title, exam_date } = req.body;
    await pool.query(`INSERT INTO exams (subject, title, exam_date) VALUES ($1, $2, $3)`, [subject, title, exam_date]);
    io.emit('new_notif', { title: 'Info Ujian!', msg: `${subject}: ${title}` });
    res.json({ success: true });
});

app.get('/api/grades', requireAuth, async (req, res) => { 
    const q = req.session.role === 'admin' ? `SELECT g.*, u.full_name FROM grades g JOIN users u ON g.user_id = u.id` : `SELECT * FROM grades WHERE user_id = $1`;
    const r = await pool.query(q, req.session.role === 'admin' ? [] : [req.session.userId]); res.json(r.rows); 
});
app.post('/api/grades', requireAuth, requireAdmin, async (req, res) => {
    const { user_id, subject, score, type } = req.body;
    await pool.query(`INSERT INTO grades (user_id, subject, score, type) VALUES ($1, $2, $3, $4)`, [user_id, subject, score, type]);
    io.emit('new_notif', { title: 'Nilai Keluar!', msg: `Nilai ${subject} telah diinput.` });
    res.json({ success: true });
});

app.get('/api/attendance', requireAuth, async (req, res) => { const r = await pool.query(`SELECT * FROM attendance WHERE user_id = $1 ORDER BY date DESC`, [req.session.userId]); res.json(r.rows); });
app.post('/api/attendance', requireAuth, requireAdmin, async (req, res) => {
    const { user_id, status } = req.body;
    await pool.query(`INSERT INTO attendance (user_id, status) VALUES ($1, $2)`, [user_id, status]);
    io.emit('new_notif', { title: 'Absensi Diupdate', msg: `Status kehadiran diperbarui.` });
    res.json({ success: true });
});

app.get('/api/library', requireAuth, async (req, res) => { const r = await pool.query(`SELECT * FROM library`); res.json(r.rows); });
app.post('/api/library', requireAuth, requireAdmin, async (req, res) => {
    const { title, subject, link } = req.body;
    await pool.query(`INSERT INTO library (title, subject, link) VALUES ($1, $2, $3)`, [title, subject, link]);
    io.emit('new_notif', { title: 'Materi Baru!', msg: `${title} (${subject})` });
    res.json({ success: true });
});

app.get('/api/finance', requireAuth, async (req, res) => { const r = await pool.query(`SELECT * FROM finance WHERE user_id = $1`, [req.session.userId]); res.json(r.rows); });
app.post('/api/finance', requireAuth, requireAdmin, async (req, res) => {
    const { user_id, amount, status, description } = req.body;
    await pool.query(`INSERT INTO finance (user_id, amount, status, description) VALUES ($1, $2, $3, $4)`, [user_id, amount, status, description]);
    io.emit('new_notif', { title: 'Info Kas', msg: `Tagihan: ${description}` });
    res.json({ success: true });
});

// --- CHAT API ---
app.get('/api/users', requireAuth, async (req, res) => {
    const result = await pool.query(`SELECT id, full_name, avatar_url FROM users WHERE id != $1`, [req.session.userId]);
    res.json(result.rows);
});
app.get('/api/messages/:receiverId', requireAuth, async (req, res) => {
    const receiverId = req.params.receiverId;
    let result;
    if (receiverId === 'group') result = await pool.query(`SELECT m.*, u.full_name FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.receiver_id IS NULL ORDER BY m.created_at ASC LIMIT 100`);
    else result = await pool.query(`SELECT m.*, u.full_name FROM messages m JOIN users u ON m.sender_id = u.id WHERE (m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1) ORDER BY m.created_at ASC LIMIT 100`, [req.session.userId, receiverId]);
    res.json(result.rows);
});

// --- STATUS API ---
app.get('/api/stories', requireAuth, async (req, res) => {
    const r = await pool.query(`SELECT s.*, u.full_name, u.avatar_url FROM stories s JOIN users u ON s.user_id = u.id WHERE s.created_at >= NOW() - INTERVAL '24 HOURS' ORDER BY s.created_at DESC`);
    res.json(r.rows);
});
app.post('/api/stories', requireAuth, async (req, res) => {
    await pool.query(`INSERT INTO stories (user_id, media, text) VALUES ($1, $2, $3)`, [req.session.userId, req.body.media, req.body.text]);
    res.json({ success: true });
});

// --- SOCKET IO ---
io.on('connection', (socket) => {
    socket.on('join_chat', (data) => { if (data.room === 'group') socket.join('group_chat'); else socket.join(`user_${data.userId}`); });
    socket.on('send_message', async (data) => {
        const { sender_id, receiver_id, message, media, sender_name } = data;
        const dbReceiverId = (receiver_id === 'group') ? null : receiver_id;
        const result = await pool.query(`INSERT INTO messages (sender_id, receiver_id, message, media) VALUES ($1, $2, $3, $4) RETURNING id, created_at`, [sender_id, dbReceiverId, message, media]);
        const msgData = { id: result.rows[0].id, sender_id, receiver_id: dbReceiverId, message, media, full_name: sender_name, created_at: result.rows[0].created_at };
        if (dbReceiverId === null) io.to('group_chat').emit('receive_message', msgData);
        else { io.to(`user_${receiver_id}`).emit('receive_message', msgData); socket.emit('receive_message', msgData); }
    });
    socket.on('callUser', (data) => { io.to(`user_${data.userToCall}`).emit('callUser', data); });
    socket.on('answerCall', (data) => { io.to(`user_${data.to}`).emit('callAccepted', data.signal); });
    socket.on('endCall', (data) => { io.to(`user_${data.to}`).emit('endCall'); });
});

app.get('/', (req, res) => { if (req.session.userId) return res.redirect('/dashboard'); res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/dashboard', (req, res) => { if (!req.session.userId) return res.redirect('/'); res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); });
app.get('/chat', (req, res) => { if (!req.session.userId) return res.redirect('/'); res.sendFile(path.join(__dirname, 'public', 'chat.html')); });
app.get('/status', (req, res) => { if (!req.session.userId) return res.redirect('/'); res.sendFile(path.join(__dirname, 'public', 'status.html')); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => { console.log(`Server on ${PORT}`); initDB().catch(console.error); });