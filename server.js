const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    store: new pgSession({ pool: pool, tableName: 'session', createTableIfMissing: true }),
    secret: 'super-secret-key-class-xi5',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

async function initDB() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE, password TEXT, plain_password TEXT, role TEXT DEFAULT 'siswa', full_name TEXT, avatar_url TEXT, last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS tasks (id SERIAL PRIMARY KEY, subject TEXT, title TEXT, description TEXT, due_date TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS messages (id SERIAL PRIMARY KEY, sender_id INTEGER, receiver_id INTEGER, message TEXT, media TEXT, media_type TEXT, is_read BOOLEAN DEFAULT FALSE, reply_to_id INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS stories (id SERIAL PRIMARY KEY, user_id INTEGER, media TEXT, media_type TEXT, text TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
        `);
        // Migrasi jika tabel sudah ada
        try { await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE;`); } catch(e){}
        try { await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER;`); } catch(e){}
        try { await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP;`); } catch(e){}

        const res = await client.query(`SELECT * FROM users WHERE username = 'admin'`);
        if (res.rows.length === 0) {
            const hash = bcrypt.hashSync('admin123', 10);
            await client.query(`INSERT INTO users (username, password, plain_password, role, full_name, avatar_url) VALUES ('admin', $1, 'admin123', 'admin', 'ADMIN-REX', NULL)`, [hash]);
        }
    } catch (err) { console.error(err); } finally { client.release(); }
}

const requireAuth = (req, res, next) => { if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' }); next(); };

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

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/me', requireAuth, async (req, res) => {
    const result = await pool.query(`SELECT id, role, full_name, avatar_url FROM users WHERE id = $1`, [req.session.userId]);
    res.json({ id: result.rows[0].id, role: result.rows[0].role, name: result.rows[0].full_name, avatar: result.rows[0].avatar_url });
});

app.get('/api/users', requireAuth, async (req, res) => {
    // Ambil data user + status online/terakhir dilihat
    const result = await pool.query(`SELECT id, full_name, avatar_url, last_seen FROM users WHERE id != $1`, [req.session.userId]);
    res.json(result.rows);
});

app.get('/api/messages/:receiverId', requireAuth, async (req, res) => {
    const receiverId = req.params.receiverId;
    let result;
    if (receiverId === 'group') {
        result = await pool.query(`SELECT m.*, u.full_name, r.message as reply_text FROM messages m JOIN users u ON m.sender_id = u.id LEFT JOIN messages r ON m.reply_to_id = r.id WHERE m.receiver_id IS NULL ORDER BY m.created_at ASC LIMIT 100`);
    } else {
        result = await pool.query(`SELECT m.*, u.full_name, r.message as reply_text FROM messages m JOIN users u ON m.sender_id = u.id LEFT JOIN messages r ON m.reply_to_id = r.id WHERE (m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1) ORDER BY m.created_at ASC LIMIT 100`, [req.session.userId, receiverId]);
    }
    res.json(result.rows);
});

// --- SOCKET.IO CORE ---
io.on('connection', (socket) => {
    // Fitur Online / Last Seen
    socket.on('user_online', async (userId) => {
        socket.userId = userId;
        await pool.query(`UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = $1`, [userId]);
        io.emit('user_status_change', { userId, status: 'online' });
    });

    socket.on('disconnect', async () => {
        if (socket.userId) {
            await pool.query(`UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = $1`, [socket.userId]);
            io.emit('user_status_change', { userId: socket.userId, status: 'offline' });
        }
    });

    socket.on('join_chat', (data) => { if (data.room === 'group') socket.join('group_chat'); else socket.join(`user_${data.userId}`); });
    
    // Fitur Kirim Pesan & Reply
    socket.on('send_message', async (data) => {
        const { sender_id, receiver_id, message, media, media_type, sender_name, reply_to_id } = data;
        const dbReceiverId = (receiver_id === 'group') ? null : receiver_id;
        
        try {
            const result = await pool.query(`INSERT INTO messages (sender_id, receiver_id, message, media, media_type, reply_to_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`, [sender_id, dbReceiverId, message, media, media_type, reply_to_id]);
            
            let replyText = null;
            if(reply_to_id) {
                const r = await pool.query(`SELECT message FROM messages WHERE id = $1`, [reply_to_id]);
                if(r.rows.length > 0) replyText = r.rows[0].message;
            }

            const msgData = { id: result.rows[0].id, sender_id, receiver_id: dbReceiverId, message, media, media_type, reply_to_id, reply_text: replyText, full_name: sender_name, is_read: false, created_at: result.rows[0].created_at };
            
            if (dbReceiverId === null) io.to('group_chat').emit('receive_message', msgData);
            else { io.to(`user_${receiver_id}`).emit('receive_message', msgData); socket.emit('receive_message', msgData); }
        } catch(e) { console.log(e); }
    });

    // Fitur Centang Biru (Read Receipt)
    socket.on('mark_as_read', async (data) => {
        const { chat_id, current_user_id } = data;
        let query = chat_id === 'group' 
            ? `UPDATE messages SET is_read = true WHERE receiver_id IS NULL AND sender_id != $1 AND is_read = false RETURNING id, sender_id`
            : `UPDATE messages SET is_read = true WHERE sender_id = $1 AND receiver_id = $2 AND is_read = false RETURNING id, sender_id`;
        
        const res = await pool.query(query, chat_id === 'group' ? [current_user_id] : [chat_id, current_user_id]);
        
        res.rows.forEach(row => {
            // Kasih tau pengirim kalau pesannya udah dibaca
            io.to(`user_${row.sender_id}`).emit('message_read_status', { message_id: row.id });
        });
    });

    // Fitur Hapus Pesan
    socket.on('delete_message', async (data) => {
        const { message_id, chat_id } = data;
        await pool.query(`DELETE FROM messages WHERE id = $1`, [message_id]);
        
        if (chat_id === 'group') io.to('group_chat').emit('message_deleted', { message_id });
        else { io.to(`user_${chat_id}`).emit('message_deleted', { message_id }); socket.emit('message_deleted', { message_id }); }
    });
});

app.get('/', (req, res) => { if (req.session.userId) return res.redirect('/dashboard'); res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/dashboard', (req, res) => { if (!req.session.userId) return res.redirect('/'); res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); });
app.get('/chat', (req, res) => { if (!req.session.userId) return res.redirect('/'); res.sendFile(path.join(__dirname, 'public', 'chat.html')); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => { initDB().catch(console.error); });