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
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE, password TEXT, role TEXT DEFAULT 'siswa', full_name TEXT, avatar_url TEXT);
            CREATE TABLE IF NOT EXISTS tasks (id SERIAL PRIMARY KEY, subject TEXT, title TEXT, description TEXT, due_date TIMESTAMP, created_by INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, sender_id INTEGER, receiver_id INTEGER, message TEXT, media TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS stories (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), media TEXT, text TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
        `);
        
        const res = await client.query(`SELECT * FROM users WHERE username = 'admin'`);
        if (res.rows.length === 0) {
            const hash = bcrypt.hashSync('admin123', 10);
            await client.query(`INSERT INTO users (username, password, role, full_name, avatar_url) VALUES ('admin', $1, 'admin', 'ADMIN-REX', NULL)`, [hash]);
        }
        console.log('Database Supabase siap.');
    } catch (err) { console.error('Gagal init DB:', err); } finally { client.release(); }
}

const requireAuth = (req, res, next) => { if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' }); next(); };

// --- API STATUS (STORY) ---
app.post('/api/stories', requireAuth, async (req, res) => {
    const { media, text } = req.body;
    if (!media && !text) return res.status(400).json({error: 'Kosong'});
    await pool.query(`INSERT INTO stories (user_id, media, text) VALUES ($1, $2, $3)`, [req.session.userId, media, text]);
    res.json({ success: true });
});

app.get('/api/stories', requireAuth, async (req, res) => {
    // Ambil status 24 jam terakhir
    const result = await pool.query(`
        SELECT s.*, u.full_name, u.avatar_url FROM stories s 
        JOIN users u ON s.user_id = u.id 
        WHERE s.created_at >= NOW() - INTERVAL '24 HOURS' 
        ORDER BY s.created_at DESC
    `);
    res.json(result.rows);
});

// --- API LAINNYA ---
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
        const user = result.rows[0];
        if (user && bcrypt.compareSync(password, user.password)) {
            req.session.userId = user.id; req.session.role = user.role; req.session.fullName = user.full_name; req.session.avatar = user.avatar_url;
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
        await pool.query(`INSERT INTO users (username, password, role, full_name, avatar_url) VALUES ($1, $2, 'siswa', $3, NULL)`, [username, hash, full_name]);
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

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    socket.on('join_chat', (data) => {
        if (data.room === 'group') socket.join('group_chat');
        else socket.join(`user_${data.userId}`);
    });
    socket.on('send_message', async (data) => {
        const { sender_id, receiver_id, message, media } = data;
        const dbReceiverId = (receiver_id === 'group') ? null : receiver_id;
        const result = await pool.query(`INSERT INTO messages (sender_id, receiver_id, message, media) VALUES ($1, $2, $3, $4) RETURNING id, created_at`, [sender_id, dbReceiverId, message, media]);
        const msgData = { id: result.rows[0].id, sender_id, receiver_id: dbReceiverId, message, media, full_name: data.sender_name, created_at: result.rows[0].created_at };
        if (dbReceiverId === null) io.to('group_chat').emit('receive_message', msgData);
        else { io.to(`user_${receiver_id}`).emit('receive_message', msgData); socket.emit('receive_message', msgData); }
    });
    // WebRTC Signals
    socket.on('callUser', (data) => { io.to(`user_${data.userToCall}`).emit('callUser', data); });
    socket.on('answerCall', (data) => { io.to(`user_${data.to}`).emit('callAccepted', data.signal); });
    socket.on('endCall', (data) => { io.to(`user_${data.to}`).emit('endCall'); });
});

app.get('/', (req, res) => { if (req.session.userId) return res.redirect('/dashboard'); res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/dashboard', (req, res) => { if (!req.session.userId) return res.redirect('/'); res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); });
app.get('/chat', (req, res) => { if (!req.session.userId) return res.redirect('/'); res.sendFile(path.join(__dirname, 'public', 'chat.html')); });
app.get('/status', (req, res) => { if (!req.session.userId) return res.redirect('/'); res.sendFile(path.join(__dirname, 'public', 'status.html')); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    initDB().catch(console.error);
});